/**
 * paystack-crypto.server.ts
 *
 * HMAC-SHA512 signature verification for Paystack webhooks.
 *
 * Lives in a `.server.ts` file so Vite's TanStack Start plugin never
 * includes it in the client bundle. Importing `crypto` at the top level
 * of a route file causes Vite to warn:
 *   "Module 'crypto' has been externalized for browser compatibility"
 * because route files are scanned by both client and server builds.
 * Isolating it here silences that warning entirely.
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify Paystack's HMAC-SHA512 webhook signature.
 *
 * @param secretKey - WABIZZ_PAYSTACK_SECRET_KEY env var
 * @param rawBody   - raw request body string (before JSON.parse)
 * @param signature - value of the x-paystack-signature header
 */
export function verifyPaystackSignature(
  secretKey: string,
  rawBody: string,
  signature: string,
): boolean {
  try {
    const expected = createHmac("sha512", secretKey).update(rawBody).digest("hex");
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
