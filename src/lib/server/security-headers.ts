/**
 * security-headers.ts — HTTP Security Headers Middleware
 *
 * Adds production-grade security headers to every server response:
 *  - Content-Security-Policy (CSP)
 *  - X-Frame-Options (clickjacking protection)
 *  - X-Content-Type-Options (MIME sniffing protection)
 *  - Referrer-Policy
 *  - Strict-Transport-Security (HSTS)
 *  - Permissions-Policy
 *  - CORS helpers (corsHeaders / withCors) — allowlist-based, not wildcard
 *
 * Usage:
 *   return applySecurityHeaders(new Response(...));
 *   — or wrap a handler —
 *   return withSecurityHeaders(() => yourHandler(request));
 *
 * CORS usage (for future public API / partner embeds):
 *   const origin = request.headers.get("origin") ?? "";
 *   return withCors(origin, () => yourApiHandler(request));
 */

const IS_PROD = process.env.NODE_ENV === "production";

// ── CORS allowlist ────────────────────────────────────────────────────────────

/**
 * Origins explicitly permitted to make cross-origin requests.
 * Add partner domains here — never use "*" in production.
 *
 * Webhook endpoints (/api/public/twilio-webhook, /api/public/paystack-webhook)
 * do NOT need CORS — they are server-to-server calls, not browser requests.
 * This list is for future browser-facing public API or embedded widgets.
 */
const CORS_ALLOWED_ORIGINS: Set<string> = new Set([
  // Add partner / embed origins here when needed, e.g.:
  // "https://partner.example.com",
]);

/**
 * Returns CORS headers for a given origin, or null if the origin is not allowed.
 * Null means the caller should NOT add any Access-Control-Allow-Origin header,
 * which causes the browser to block the request — correct behaviour for
 * unapproved origins.
 */
export function corsHeaders(origin: string): Record<string, string> | null {
  if (!CORS_ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Handle a CORS preflight OPTIONS request.
 * Returns a 204 with CORS headers, or 403 if origin not allowed.
 */
export function handleCorsPreflight(origin: string): Response {
  const headers = corsHeaders(origin);
  if (!headers) return new Response("Forbidden", { status: 403 });
  return new Response(null, { status: 204, headers });
}

/**
 * Wrap an async handler with CORS + security headers.
 * Use for future public API routes.
 */
export async function withCors(
  origin: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const cors = corsHeaders(origin);
  const response = await handler();
  const secured = applySecurityHeaders(response);
  if (!cors) return secured;
  const newHeaders = new Headers(secured.headers);
  for (const [k, v] of Object.entries(cors)) newHeaders.set(k, v);
  return new Response(secured.body, {
    status: secured.status,
    statusText: secured.statusText,
    headers: newHeaders,
  });
}

// ── Security header definitions ───────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  // Allow Facebook OAuth popup to frame our pages; DENY everything else.
  // Must NOT be "DENY" — Facebook's Embedded Signup opens in a popup that
  // needs to load pages from our origin inside an iframe context.
  "X-Frame-Options": "SAMEORIGIN",

  // Prevent MIME type sniffing
  "X-Content-Type-Options": "nosniff",

  // No referrer on cross-origin navigation
  "Referrer-Policy": "strict-origin-when-cross-origin",

  // Disable potentially dangerous browser features
  "Permissions-Policy": [
    "camera=()",
    "microphone=()",
    "geolocation=()",
    "interest-cohort=()",
    "payment=(self)",
  ].join(", "),

  // Enforce HTTPS — 1 year, include subdomains (production only)
  ...(IS_PROD
    ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload" }
    : {}),

  // Content Security Policy
  // Includes Meta / Facebook domains required for Embedded Signup + Cloud API.
  "Content-Security-Policy": [
    "default-src 'self'",
    // Scripts: self + Meta SDK (connect.facebook.net serves the FB JS SDK)
    IS_PROD
      ? "script-src 'self' https://connect.facebook.net"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://connect.facebook.net",
    // Styles: self + inline (Tailwind injects style tags)
    "style-src 'self' 'unsafe-inline'",
    // Images: self + data URIs (avatars / placeholders) + Meta CDN
    "img-src 'self' data: https:",
    // Fonts: self only
    "font-src 'self'",
    // API connections: self + Supabase + Paystack + Twilio + Meta Graph API
    [
      "connect-src 'self'",
      "https://*.supabase.co",
      "wss://*.supabase.co",
      "https://api.paystack.co",
      "https://api.twilio.com",
      "https://waba-v2.360dialog.io",
      "https://graph.facebook.com",
      "https://connect.facebook.net",
    ].join(" "),
    // Facebook OAuth popup + Embedded Signup iframe
    "frame-src https://www.facebook.com https://web.facebook.com",
    // No plugins
    "object-src 'none'",
    // Base URI restricted to self
    "base-uri 'self'",
    // Form actions to self only
    "form-action 'self'",
    // Block mixed content
    "upgrade-insecure-requests",
  ].join("; "),
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mutate a Response by adding all security headers.
 * Returns a new Response with headers applied (Response objects are immutable).
 */
export function applySecurityHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Wrap an async handler and automatically apply security headers to its response.
 *
 * Example:
 *   GET: async ({ request }) =>
 *     withSecurityHeaders(() => handleGetRequest(request))
 */
export async function withSecurityHeaders(handler: () => Promise<Response>): Promise<Response> {
  const response = await handler();
  return applySecurityHeaders(response);
}

/**
 * Security headers as a plain object — for use in fetch() calls or
 * frameworks that accept header maps directly.
 */
export function getSecurityHeadersObject(): Record<string, string> {
  return { ...SECURITY_HEADERS };
}
