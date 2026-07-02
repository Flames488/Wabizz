/**
 * meta-whatsapp.ts — Meta WhatsApp Cloud API helpers.
 *
 * Shared by Embedded Signup, webhook verification, and queue sends.
 */

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── Coexistence eligibility by country code ────────────────────────────────────
// BUG 4 FIX: Do NOT use platform_type to determine Coexistence eligibility.
// platform_type = "CLOUD_API" for ALL Meta Cloud API numbers, including Nigeria.
// Nigeria (+234) does NOT support Coexistence regardless of platform_type.
// The correct check is the phone number's country code prefix.
const COEXISTENCE_UNSUPPORTED_PREFIXES = [
  "+234", // Nigeria      — confirmed unsupported as of June 2026
  "+27",  // South Africa — confirmed unsupported as of June 2026
];

export function isCoexistenceEligibleByPhone(e164Phone: string): boolean {
  return !COEXISTENCE_UNSUPPORTED_PREFIXES.some((prefix) => e164Phone.startsWith(prefix));
}

// ── Crypto ────────────────────────────────────────────────────────────────────

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyMetaWebhookSignature(opts: {
  rawBody: string;
  signature: string;
  appSecret: string;
}): Promise<boolean> {
  const { rawBody, signature, appSecret } = opts;
  if (!appSecret || !signature.startsWith("sha256=")) return false;
  const expected = signature.slice("sha256=".length).toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqualHex(hex(mac), expected);
}

// ── Send ─────────────────────────────────────────────────────────────────────

export async function sendMetaTextMessage(opts: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  text: string;
}): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/${opts.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: opts.to.replace(/[^\d]/g, ""),
      type: "text",
      text: { body: opts.text, preview_url: false },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Meta Cloud API ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeForLongLivedToken(opts: {
  shortLivedToken: string;
  appId: string;
  appSecret: string;
}): Promise<string> {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", opts.appId);
  url.searchParams.set("client_secret", opts.appSecret);
  url.searchParams.set("fb_exchange_token", opts.shortLivedToken);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; error?: { message?: string } };
  if (!data.access_token) {
    throw new Error(data.error?.message ?? "Token exchange returned no access token.");
  }
  return data.access_token;
}

// ── Account info (WABA + phone discovery) ─────────────────────────────────────

export interface MetaPhoneNumberInfo {
  phoneNumberId: string;
  wabaId: string;
  /** Normalized E.164, e.g. "+2348012345678" */
  phoneNumber: string;
  verifiedName: string | null;
  platformType: string | null;
  businessManagerId: string | null;
  /** True only when the phone number's country supports Coexistence. */
  coexistenceEligible: boolean;
}

function normalizePhone(displayPhoneNumber: string): string {
  const digits = displayPhoneNumber.replace(/\D/g, "");
  return digits ? `+${digits}` : displayPhoneNumber;
}

export async function getWhatsAppAccountInfo(
  accessToken: string,
  preferredPhoneNumberId?: string,
  preferredWabaId?: string,
): Promise<MetaPhoneNumberInfo> {
  // Step 1: list WABAs
  const wabaUrl = new URL(`${GRAPH_BASE}/me/whatsapp_business_accounts`);
  wabaUrl.searchParams.set("fields", "id,name,business");
  const wabaRes = await fetch(wabaUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!wabaRes.ok) {
    const body = await wabaRes.text().catch(() => "");
    throw new Error(`WABA lookup failed: ${wabaRes.status} ${body.slice(0, 200)}`);
  }
  const wabaData = (await wabaRes.json()) as {
    data?: Array<{ id: string; business?: { id?: string } }>;
  };
  const waba =
    wabaData.data?.find((row) => row.id === preferredWabaId) ?? wabaData.data?.[0] ?? null;
  if (!waba) throw new Error("No WhatsApp Business Account found for this Meta login.");

  // Step 2: list phone numbers on the WABA
  const phonesUrl = new URL(`${GRAPH_BASE}/${waba.id}/phone_numbers`);
  phonesUrl.searchParams.set("fields", "id,display_phone_number,verified_name,platform_type");
  const phonesRes = await fetch(phonesUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!phonesRes.ok) {
    const body = await phonesRes.text().catch(() => "");
    throw new Error(`Phone number lookup failed: ${phonesRes.status} ${body.slice(0, 200)}`);
  }
  const phonesData = (await phonesRes.json()) as {
    data?: Array<{
      id: string;
      display_phone_number?: string;
      verified_name?: string;
      platform_type?: string;
    }>;
  };
  const phone =
    phonesData.data?.find((row) => row.id === preferredPhoneNumberId) ??
    phonesData.data?.[0] ??
    null;
  if (!phone) throw new Error("No WhatsApp phone numbers found on this account.");

  const resolvedPhone = normalizePhone(phone.display_phone_number ?? phone.id);

  return {
    phoneNumberId: phone.id,
    wabaId: waba.id,
    phoneNumber: resolvedPhone,
    verifiedName: phone.verified_name ?? null,
    platformType: phone.platform_type ?? null,
    businessManagerId: waba.business?.id ?? null,
    coexistenceEligible: isCoexistenceEligibleByPhone(resolvedPhone),
  };
}

// ── Webhook subscription ──────────────────────────────────────────────────────

export async function subscribePhoneToWebhook(opts: {
  wabaId: string;
  accessToken: string;
}): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/${opts.wabaId}/subscribed_apps`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Webhook subscription failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
