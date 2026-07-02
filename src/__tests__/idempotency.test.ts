/**
 * idempotency.test.ts — Unit tests for the idempotency module
 *
 * Guards against:
 *   - Duplicate WhatsApp messages sent under retry storms
 *   - Duplicate Paystack payment links for the same order
 *   - Double-firing of scheduled reminders
 *
 * These tests mock Supabase so no live DB is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock Supabase admin client ────────────────────────────────────────────────

const _store = new Map<string, { key: string; expires_at: string }>();

const mockSupabaseAdmin = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  lt: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: vi.fn(),
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  acquireIdempotencyKey,
  releaseIdempotencyKey,
  pruneIdempotencyKeys,
} from "@/lib/server/idempotency";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockKeyNotFound() {
  mockSupabaseAdmin.single.mockResolvedValueOnce({ data: null, error: { code: "PGRST116" } });
}

function mockKeyFound(key: string) {
  mockSupabaseAdmin.single.mockResolvedValueOnce({
    data: { key, expires_at: new Date(Date.now() + 60_000).toISOString() },
    error: null,
  });
}

function mockInsertSuccess() {
  mockSupabaseAdmin.insert.mockResolvedValueOnce({ error: null });
}

function mockInsertConflict() {
  mockSupabaseAdmin.insert.mockResolvedValueOnce({ error: { code: "23505" } });
}

function mockDeleteSuccess() {
  mockSupabaseAdmin.delete.mockResolvedValueOnce({ error: null });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("acquireIdempotencyKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default chain setup — from().select().eq().single() pattern
    mockSupabaseAdmin.from.mockReturnThis();
    mockSupabaseAdmin.select.mockReturnThis();
    mockSupabaseAdmin.eq.mockReturnThis();
    mockSupabaseAdmin.lt.mockReturnThis();
    mockSupabaseAdmin.insert.mockReturnThis();
    mockSupabaseAdmin.delete.mockReturnThis();
  });

  it("returns true when the key does not exist (first acquisition)", async () => {
    mockKeyNotFound();
    mockInsertSuccess();

    const result = await acquireIdempotencyKey("send_whatsapp:+2348012345678:abc123");
    expect(result).toBe(true);
  });

  it("returns false when the key already exists (duplicate detected)", async () => {
    mockKeyFound("send_whatsapp:+2348012345678:abc123");

    const result = await acquireIdempotencyKey("send_whatsapp:+2348012345678:abc123");
    expect(result).toBe(false);
  });

  it("returns false on insert conflict (race condition — two workers acquired simultaneously)", async () => {
    mockKeyNotFound();
    mockInsertConflict();

    const result = await acquireIdempotencyKey("send_payment_link:biz123:conv456:15000");
    expect(result).toBe(false);
  });

  it("does not deduplicate log_event jobs (they use unique job ids)", async () => {
    const key1 = "log_event:job-uuid-1";
    const key2 = "log_event:job-uuid-2";

    mockKeyNotFound();
    mockInsertSuccess();
    const r1 = await acquireIdempotencyKey(key1);

    mockKeyNotFound();
    mockInsertSuccess();
    const r2 = await acquireIdempotencyKey(key2);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it("prevents double payment link for same conversation + amount", async () => {
    const key = "send_payment_link:biz-001:conv-001:5000";

    // First acquisition succeeds
    mockKeyNotFound();
    mockInsertSuccess();
    expect(await acquireIdempotencyKey(key)).toBe(true);

    // Second acquisition (e.g. Cloudflare retry) is blocked
    mockKeyFound(key);
    expect(await acquireIdempotencyKey(key)).toBe(false);
  });
});

describe("releaseIdempotencyKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabaseAdmin.from.mockReturnThis();
    mockSupabaseAdmin.delete.mockReturnThis();
    mockSupabaseAdmin.eq.mockReturnThis();
  });

  it("deletes the key so the next retry can re-acquire", async () => {
    mockDeleteSuccess();
    await expect(
      releaseIdempotencyKey("send_whatsapp:+2348012345678:abc123"),
    ).resolves.not.toThrow();
    expect(mockSupabaseAdmin.delete).toHaveBeenCalled();
  });

  it("does not throw if the key does not exist (idempotent release)", async () => {
    mockSupabaseAdmin.delete.mockResolvedValueOnce({ error: { code: "PGRST116" } });
    await expect(releaseIdempotencyKey("nonexistent-key")).resolves.not.toThrow();
  });
});

describe("pruneIdempotencyKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabaseAdmin.from.mockReturnThis();
    mockSupabaseAdmin.delete.mockReturnThis();
    mockSupabaseAdmin.lt.mockReturnThis();
  });

  it("deletes rows with expires_at in the past", async () => {
    mockSupabaseAdmin.lt.mockResolvedValueOnce({ error: null, count: 42 });
    await expect(pruneIdempotencyKeys()).resolves.not.toThrow();
    expect(mockSupabaseAdmin.delete).toHaveBeenCalled();
    expect(mockSupabaseAdmin.lt).toHaveBeenCalledWith("expires_at", expect.any(String));
  });

  it("does not throw if the prune query returns an error", async () => {
    mockSupabaseAdmin.lt.mockResolvedValueOnce({ error: new Error("DB error"), count: 0 });
    await expect(pruneIdempotencyKeys()).resolves.not.toThrow();
  });
});
