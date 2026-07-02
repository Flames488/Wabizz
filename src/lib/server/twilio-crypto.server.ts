/**
 * twilio-crypto.server.ts
 *
 * HMAC-SHA1 signature verification for Twilio webhooks.
 * Isolated in a .server.ts file so Vite never includes `crypto`
 * in the client bundle (avoids "Module crypto externalized" warning).
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify Twilio's HMAC-SHA1 webhook signature.
 *
 * @param authToken - TWILIO_AUTH_TOKEN env var
 * @param url       - full request URL (including query string)
 * @param params    - parsed POST body as URLSearchParams
 * @param signature - value of the X-Twilio-Signature header
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
  signature: string,
): boolean {
  const keys = Array.from(new Set(Array.from(params.keys()))).sort();
  let data = url;
  for (const key of keys) {
    for (const value of params.getAll(key)) {
      data += key + value;
    }
  }
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
