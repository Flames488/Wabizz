/**
 * security.test.ts
 *
 * Tests for verifyTwilioSignature and verifyPaystackSignature.
 * These are pure crypto functions — zero mocking required.
 *
 * Covers:
 *   - Valid signatures (happy path)
 *   - Invalid / tampered signatures
 *   - Missing / empty inputs
 *   - Malformed hex (Paystack)
 *   - URL sensitivity (Twilio)
 *   - Param ordering (Twilio)
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
// These used to live inline in the route files and were later extracted
// into dedicated .server.ts crypto modules (see the "lives in ..." comments
// left behind in the route files) — this test wasn't updated to follow, so
// it was importing names the route modules no longer export.
import { verifyTwilioSignature } from "../lib/server/twilio-crypto.server";
import { verifyPaystackSignature } from "../lib/server/paystack-crypto.server";

// ── Helper to build a valid Twilio signature ─────────────────────────────────

function buildTwilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const keys = Array.from(new Set(Array.from(params.keys()))).sort();
  let data = url;
  for (const key of keys) {
    for (const value of params.getAll(key)) {
      data += key + value;
    }
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

function buildPaystackSignature(secretKey: string, rawBody: string): string {
  return createHmac("sha512", secretKey).update(rawBody).digest("hex");
}

// ── Twilio tests ─────────────────────────────────────────────────────────────

describe("verifyTwilioSignature", () => {
  const authToken = "test-auth-token-abc123";
  const url = "https://example.com/api/public/twilio-webhook";

  it("accepts a valid signature with no params", () => {
    const params = new URLSearchParams();
    const sig = buildTwilioSignature(authToken, url, params);
    expect(verifyTwilioSignature(authToken, url, params, sig)).toBe(true);
  });

  it("accepts a valid signature with params", () => {
    const params = new URLSearchParams({
      From: "whatsapp:+2348012345678",
      To: "whatsapp:+2348087654321",
      Body: "Hello there",
      MessageSid: "SM123456",
    });
    const sig = buildTwilioSignature(authToken, url, params);
    expect(verifyTwilioSignature(authToken, url, params, sig)).toBe(true);
  });

  it("rejects a tampered body (wrong params)", () => {
    const params = new URLSearchParams({ From: "whatsapp:+2348012345678", Body: "Hello" });
    const sig = buildTwilioSignature(authToken, url, params);

    const tamperedParams = new URLSearchParams({ From: "whatsapp:+2348012345678", Body: "Evil" });
    expect(verifyTwilioSignature(authToken, url, tamperedParams, sig)).toBe(false);
  });

  it("rejects a tampered URL", () => {
    const params = new URLSearchParams({ Body: "Test" });
    const sig = buildTwilioSignature(authToken, url, params);
    const differentUrl = "https://evil.com/api/public/twilio-webhook";
    expect(verifyTwilioSignature(authToken, differentUrl, params, sig)).toBe(false);
  });

  it("rejects a wrong auth token", () => {
    const params = new URLSearchParams({ Body: "Test" });
    const sig = buildTwilioSignature(authToken, url, params);
    expect(verifyTwilioSignature("wrong-token", url, params, sig)).toBe(false);
  });

  it("rejects an empty signature string", () => {
    const params = new URLSearchParams({ Body: "Test" });
    expect(verifyTwilioSignature(authToken, url, params, "")).toBe(false);
  });

  it("rejects a completely random signature", () => {
    const params = new URLSearchParams({ Body: "Hello" });
    expect(verifyTwilioSignature(authToken, url, params, "randomgarbage==")).toBe(false);
  });

  it("is insensitive to param key insertion order (sorts keys)", () => {
    // Both orderings must produce the same result
    const params1 = new URLSearchParams();
    params1.append("Body", "Hello");
    params1.append("From", "+234");

    const params2 = new URLSearchParams();
    params2.append("From", "+234");
    params2.append("Body", "Hello");

    const sig1 = buildTwilioSignature(authToken, url, params1);
    const sig2 = buildTwilioSignature(authToken, url, params2);
    expect(sig1).toBe(sig2);

    expect(verifyTwilioSignature(authToken, url, params1, sig2)).toBe(true);
    expect(verifyTwilioSignature(authToken, url, params2, sig1)).toBe(true);
  });

  it("handles query string in URL as part of signed data", () => {
    const urlWithQuery = `${url}?foo=bar`;
    const params = new URLSearchParams({ Body: "Hi" });
    const sig = buildTwilioSignature(authToken, urlWithQuery, params);

    // Correct URL passes
    expect(verifyTwilioSignature(authToken, urlWithQuery, params, sig)).toBe(true);
    // URL without query string fails
    expect(verifyTwilioSignature(authToken, url, params, sig)).toBe(false);
  });

  it("handles special characters in param values", () => {
    const params = new URLSearchParams({ Body: "Hello & Goodbye <World>" });
    const sig = buildTwilioSignature(authToken, url, params);
    expect(verifyTwilioSignature(authToken, url, params, sig)).toBe(true);
  });
});

// ── Paystack tests ───────────────────────────────────────────────────────────

describe("verifyPaystackSignature", () => {
  const secretKey = "sk_test_paystack_secret_key_xyz123";

  it("accepts a valid signature", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "abc123" } });
    const sig = buildPaystackSignature(secretKey, body);
    expect(verifyPaystackSignature(secretKey, body, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "abc123" } });
    const sig = buildPaystackSignature(secretKey, body);
    const tampered = JSON.stringify({ event: "charge.success", data: { reference: "EVIL" } });
    expect(verifyPaystackSignature(secretKey, tampered, sig)).toBe(false);
  });

  it("rejects a wrong secret key", () => {
    const body = JSON.stringify({ event: "charge.success" });
    const sig = buildPaystackSignature(secretKey, body);
    expect(verifyPaystackSignature("wrong-secret", body, sig)).toBe(false);
  });

  it("rejects an empty signature", () => {
    const body = JSON.stringify({ event: "charge.success" });
    expect(verifyPaystackSignature(secretKey, body, "")).toBe(false);
  });

  it("rejects malformed hex signature", () => {
    const body = JSON.stringify({ event: "charge.success" });
    // Non-hex string causes Buffer.from(..., 'hex') to produce wrong-length buffer
    expect(verifyPaystackSignature(secretKey, body, "not-valid-hex!@#")).toBe(false);
  });

  it("rejects a random hex string of correct length", () => {
    const body = JSON.stringify({ event: "charge.success" });
    // SHA-512 produces 128 hex chars — supply random 128 hex chars
    const randomHex = "a".repeat(128);
    expect(verifyPaystackSignature(secretKey, body, randomHex)).toBe(false);
  });

  it("accepts a large payload without issues", () => {
    const body = JSON.stringify({
      event: "charge.success",
      data: { reference: "ref", metadata: { items: Array(100).fill("product") } },
    });
    const sig = buildPaystackSignature(secretKey, body);
    expect(verifyPaystackSignature(secretKey, body, sig)).toBe(true);
  });

  it("is case-sensitive on the body content", () => {
    const bodyLower = JSON.stringify({ event: "charge.success" });
    const bodyUpper = JSON.stringify({ event: "Charge.Success" });
    const sig = buildPaystackSignature(secretKey, bodyLower);
    expect(verifyPaystackSignature(secretKey, bodyUpper, sig)).toBe(false);
  });
});
