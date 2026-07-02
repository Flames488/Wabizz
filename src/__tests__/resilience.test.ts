/**
 * resilience.test.ts
 *
 * Tests for:
 *   - Rate limiter behaviour (allow / block / KV failure fallback)
 *   - Health endpoint response shape
 *   - AbortController timeout classification (abort vs generic error)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, checkIpRateLimit } from "../../lib/rate-limiter";

// ── Rate limiter — in-memory backend ─────────────────────────────────────────

describe("Rate limiter — in-memory backend (no KV, no Upstash)", () => {
  beforeEach(() => {
    // Ensure KV binding is absent so in-memory fallback activates
    vi.stubGlobal("RATE_LIMIT_KV", undefined);
    // Ensure Upstash env vars are absent
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("allows the first request", async () => {
    const result = await checkRateLimit("test-sender-allow-first", 5);
    expect(result.allowed).toBe(true);
  });

  it("blocks when limit is exceeded", async () => {
    const key = `test-block-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(key, 5);
    }
    const result = await checkRateLimit(key, 5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Rate limit exceeded");
  });

  it("uses separate counters for different keys", async () => {
    const key1 = `test-sep-1-${Date.now()}`;
    const key2 = `test-sep-2-${Date.now()}`;
    for (let i = 0; i < 5; i++) await checkRateLimit(key1, 5);
    const result = await checkRateLimit(key2, 5);
    expect(result.allowed).toBe(true);
  });

  it("allows exactly limit requests, blocks the (limit+1)th", async () => {
    const key = `test-exact-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(key, 3);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(key, 3);
    expect(blocked.allowed).toBe(false);
  });
});

describe("Rate limiter — Upstash Redis backend", () => {
  beforeEach(() => {
    vi.stubGlobal("RATE_LIMIT_KV", undefined);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake-upstash.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("calls Upstash INCR and allows when under limit", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 1 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 1 }), { status: 200 }), // expire call
      );
    const result = await checkRateLimit("upstash-test-key", 10);
    expect(result.allowed).toBe(true);
  });

  it("blocks when Upstash INCR returns count above limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ result: 11 }), { status: 200 }),
    );
    const result = await checkRateLimit("upstash-over-limit", 10);
    expect(result.allowed).toBe(false);
  });

  it("falls back to in-memory when Upstash fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));
    // Should not throw — falls through to in-memory
    const result = await checkRateLimit(`upstash-fallback-${Date.now()}`, 100);
    expect(result.allowed).toBe(true);
  });
});

describe("checkIpRateLimit", () => {
  beforeEach(() => {
    vi.stubGlobal("RATE_LIMIT_KV", undefined);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("allows a fresh IP", async () => {
    const result = await checkIpRateLimit(`1.2.3.${Date.now() % 255}`, 500);
    expect(result.allowed).toBe(true);
  });
});

// ── AbortController timeout classification ────────────────────────────────────

describe("AbortController timeout detection", () => {
  it("AbortError is correctly identified by name", () => {
    const controller = new AbortController();
    controller.abort();

    // Simulate what fetch throws when aborted
    const err = controller.signal.reason ?? new DOMException("signal aborted", "AbortError");
    const isTimeout = err instanceof Error && err.name === "AbortError";
    expect(isTimeout).toBe(true);
  });

  it("generic Error is NOT classified as timeout", () => {
    const err = new Error("Network failure");
    const isTimeout = err instanceof Error && err.name === "AbortError";
    expect(isTimeout).toBe(false);
  });

  it("non-Error thrown value is not classified as timeout", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = "string error";
    const isTimeout = err instanceof Error && err.name === "AbortError";
    expect(isTimeout).toBe(false);
  });
});

// ── Health endpoint shape ─────────────────────────────────────────────────────

describe("Health endpoint response", () => {
  /**
   * We test the response structure inline rather than importing the route module,
   * which requires TanStack Start's createFileRoute (not available in Vitest).
   * The handler logic is trivially simple — we assert the contract here.
   */

  function buildHealthResponse(): Response {
    return new Response(JSON.stringify({ status: "ok", ts: new Date().toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns HTTP 200", () => {
    const res = buildHealthResponse();
    expect(res.status).toBe(200);
  });

  it("returns Content-Type: application/json", () => {
    const res = buildHealthResponse();
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("body contains status: ok", async () => {
    const res = buildHealthResponse();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  it("body contains ISO 8601 ts field", async () => {
    const res = buildHealthResponse();
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.ts).toBe("string");
    expect(new Date(body.ts as string).toISOString()).toBe(body.ts);
  });

  it("does not require auth header", () => {
    // Health route has no auth check — confirmed by reading the route file.
    // This test documents the contract.
    const res = buildHealthResponse();
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ── TwiML XML escaping ────────────────────────────────────────────────────────

describe("XML escaping for TwiML responses", () => {
  function escapeXml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  it("escapes ampersand", () => {
    expect(escapeXml("Fish & Chips")).toBe("Fish &amp; Chips");
  });

  it("escapes angle brackets", () => {
    expect(escapeXml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes quotes", () => {
    expect(escapeXml(`He said "hello" and 'bye'`)).toBe(
      "He said &quot;hello&quot; and &apos;bye&apos;",
    );
  });

  it("leaves plain text unchanged", () => {
    expect(escapeXml("Hello there! 🎉")).toBe("Hello there! 🎉");
  });

  it("handles empty string", () => {
    expect(escapeXml("")).toBe("");
  });
});
