/**
 * admin-auth.ts — Stateless admin authentication
 *
 * Completely separate from Supabase auth (which is for business owners).
 * Admin auth uses:
 *   - Username + PBKDF2 password stored in admin_users table
 *   - Short-lived JWT (4 hours) signed with ADMIN_JWT_SECRET
 *   - Server-side verification on every admin API call
 *
 * LOGIN CREDENTIALS:
 *   Username : set via ADMIN_SEED_USERNAME env var (default: "admin")
 *   Password : set via ADMIN_SEED_PASSWORD env var — REQUIRED, no default
 *
 * Security:
 *   - Passwords are PBKDF2-SHA256 hashed (600k iterations, NIST-approved)
 *   - Tokens are signed HS256 — tampering detected server-side
 *   - All admin actions are logged to admin_actions_log
 *   - Token expiry enforced on every request
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";

const JWT_SECRET = () => process.env.ADMIN_JWT_SECRET ?? "wabizz-admin-secret-change-in-prod";
const TOKEN_EXPIRY_HOURS = 4;

// ── Crypto helpers (Web Crypto API — works in both Workers and Node) ──────────

async function _hmacSign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function _hmacVerify(payload: string, sig: string, secret: string): Promise<boolean> {
  const expected = await _hmacSign(payload, secret);
  // Constant-time compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function _b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── bcrypt via native crypto (PBKDF2 as bcrypt substitute) ───────────────────
// True bcrypt requires a native module. We use PBKDF2-SHA256. Cloudflare Workers'
// crypto.subtle hard-caps PBKDF2 at 100,000 iterations (deriveBits throws
// NotSupportedError above that) — this is Workers' ceiling, not a security choice;
// on Node the NIST-recommended 600k+ would be preferable, but this code must run
// in the Workers runtime.
const PBKDF2_ITERATIONS = 100_000;

async function _hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function _verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2:")) return false;
  const [, saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  const candidate = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time compare
  if (candidate.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ hashHex.charCodeAt(i);
  }
  return diff === 0;
}

// ── JWT ───────────────────────────────────────────────────────────────────────

export interface AdminToken {
  adminId: string;
  username: string;
  exp: number;
}

async function _signToken(payload: AdminToken): Promise<string> {
  const header = _b64url({ alg: "HS256", typ: "JWT" });
  const body = _b64url(payload);
  const sig = await _hmacSign(`${header}.${body}`, JWT_SECRET());
  return `${header}.${body}.${sig}`;
}

export async function verifyAdminToken(token: string): Promise<AdminToken | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const valid = await _hmacVerify(`${header}.${body}`, sig, JWT_SECRET());
    if (!valid) return null;
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as AdminToken;
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Seed default admin user ───────────────────────────────────────────────────

let _seeded = false;
export async function seedAdminUser(): Promise<void> {
  if (_seeded) return;
  _seeded = true;

  const seedPassword = process.env.ADMIN_SEED_PASSWORD;
  if (!seedPassword) {
    console.error(
      "[admin-auth] ADMIN_SEED_PASSWORD env var is not set — skipping admin seed. " +
        "Set it via `wrangler secret put ADMIN_SEED_PASSWORD` before first deploy.",
    );
    return;
  }

  const seedUsername = process.env.ADMIN_SEED_USERNAME ?? "admin";

  const { count } = await supabaseAdmin
    .from("admin_users")
    .select("*", { count: "exact", head: true });

  if ((count ?? 0) > 0) return; // already seeded

  const hash = await _hashPassword(seedPassword);
  const { error } = await supabaseAdmin
    .from("admin_users")
    .insert({ username: seedUsername, password_hash: hash });

  if (error) {
    console.error("[admin-auth] Failed to seed admin user:", error.message);
  } else {
    await logInfo("admin-auth", `Default admin user seeded (username: ${seedUsername})`, {});
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function adminLogin(
  username: string,
  password: string,
  ip: string,
): Promise<{ token: string; expiresAt: number } | null> {
  const { data: admin } = await supabaseAdmin
    .from("admin_users")
    .select("id, username, password_hash")
    .eq("username", username)
    .maybeSingle();

  if (!admin) {
    await logError("admin-auth", "Login failed — unknown username", { username, ip });
    return null;
  }

  const valid = await _verifyPassword(password, admin.password_hash);
  if (!valid) {
    await logError("admin-auth", "Login failed — wrong password", { username, ip });
    return null;
  }

  // Update last_login
  await supabaseAdmin
    .from("admin_users")
    .update({ last_login: new Date().toISOString() })
    .eq("id", admin.id);

  const exp = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_HOURS * 3600;
  const token = await _signToken({ adminId: admin.id, username: admin.username, exp });

  await logInfo("admin-auth", "Admin login successful", { username, ip });
  return { token, expiresAt: exp * 1000 };
}

// ── Require admin middleware helper ───────────────────────────────────────────

export async function requireAdmin(request: Request): Promise<AdminToken> {
  const auth =
    request.headers.get("x-admin-token") ??
    request.headers.get("authorization")?.replace("Bearer ", "");
  if (!auth) throw new Response("Unauthorized", { status: 401 });
  const token = await verifyAdminToken(auth);
  if (!token) throw new Response("Unauthorized: Invalid or expired token", { status: 401 });
  return token;
}

// ── Admin action logger ───────────────────────────────────────────────────────

export async function logAdminAction(args: {
  adminId: string;
  action: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  await supabaseAdmin.from("admin_actions_log").insert({
    admin_id: args.adminId,
    action: args.action,
    target_id: args.targetId,
    details: args.details,
    ip: args.ip,
  });
}
