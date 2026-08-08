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

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Supabase admin client ────────────────────────────────────────────────

// NOTE: vi.mock factories are hoisted above all other module-level code, so a
// plain `const mockSupabaseAdmin = {...}` referenced inside the factory below
// used to throw "Cannot access 'mockSupabaseAdmin' before initialization" —
// the factory ran before the const was ever assigned. vi.hoisted() runs the
// initializer in that same hoisted position so the reference is safe.
const mockSupabaseAdmin = vi.hoisted(() => ({
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  lt: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

vi.mock("@/lib/server/event-pipeline", () => ({
  events: { jobDuplicate: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { acquireIdempotencyKey, pruneIdempotencyKeys } from "@/lib/server/idempotency";

// ── Helpers ───────────────────────────────────────────────────────────────────
// The mock chain methods default to mockReturnThis() so any chain of them
// resolves to `mockSupabaseAdmin` itself when awaited (destructuring
// properties like `error`/`data` off of it yields undefined, i.e. "no error").
// Each helper below overrides just the terminal call of one specific chain
// with a real resolved value for a single invocation.

function mockKeyNotFound() {
  mockSupabaseAdmin.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
}

function mockKeyFound(status: "success" | "processing", updatedAt = new Date().toISOString()) {
  mockSupabaseAdmin.maybeSingle.mockResolvedValueOnce({
    data: { status, updated_at: updatedAt },
    error: null,
  });
}

function mockInsertSuccess() {
  mockSupabaseAdmin.insert.mockResolvedValueOnce({ error: null });
}

function mockInsertConflict() {
  mockSupabaseAdmin.insert.mockResolvedValueOnce({ error: { code: "23505" } });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("acquireIdempotencyKey", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default chain setup — every intermediate chain call returns `this`;
    // reset here (not just cleared) so a leftover *Once() queued value from a
    // previous test can never bleed into the next one and break chaining.
    mockSupabaseAdmin.from.mockReturnThis();
    mockSupabaseAdmin.select.mockReturnThis();
    mockSupabaseAdmin.eq.mockReturnThis();
    mockSupabaseAdmin.lt.mockReturnThis();
    mockSupabaseAdmin.insert.mockReturnThis();
    mockSupabaseAdmin.update.mockReturnThis();
    mockSupabaseAdmin.delete.mockReturnThis();
  });

  it("returns alreadySeen:false when the key does not exist (first acquisition)", async () => {
    mockInsertSuccess();

    const guard = await acquireIdempotencyKey("send_whatsapp:+2348012345678:abc123", "trace-1");
    expect(guard.alreadySeen).toBe(false);
  });

  it("returns alreadySeen:true when the key was already marked success (duplicate detected)", async () => {
    mockInsertConflict();
    mockKeyFound("success");

    const guard = await acquireIdempotencyKey("send_whatsapp:+2348012345678:abc123", "trace-1");
    expect(guard.alreadySeen).toBe(true);
  });

  it("returns alreadySeen:true when another worker holds a fresh 'processing' lock", async () => {
    mockInsertConflict();
    mockKeyFound("processing"); // updated_at defaults to "now" — well within the stale threshold

    const guard = await acquireIdempotencyKey("send_payment_link:biz123:conv456:15000", "trace-1");
    expect(guard.alreadySeen).toBe(true);
  });

  it("recovers a stale 'processing' lock (crashed worker) and re-acquires", async () => {
    const staleUpdatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    mockInsertConflict();
    mockKeyFound("processing", staleUpdatedAt);
    // eq() is called 3 times total: select(...).eq() [chain], then
    // delete().eq().eq() — only the last of those three resolves the delete.
    mockSupabaseAdmin.eq
      .mockReturnValueOnce(mockSupabaseAdmin)
      .mockReturnValueOnce(mockSupabaseAdmin)
      .mockResolvedValueOnce({ error: null });
    mockInsertSuccess(); // re-insert after clearing the stale lock

    const guard = await acquireIdempotencyKey("send_payment_link:biz123:conv456:15000", "trace-1");
    expect(guard.alreadySeen).toBe(false);
  });

  it("does not deduplicate log_event jobs across different job ids", async () => {
    mockInsertSuccess();
    const r1 = await acquireIdempotencyKey("log_event:job-uuid-1", "trace-1");

    mockInsertSuccess();
    const r2 = await acquireIdempotencyKey("log_event:job-uuid-2", "trace-2");

    expect(r1.alreadySeen).toBe(false);
    expect(r2.alreadySeen).toBe(false);
  });

  it("prevents double payment link for same conversation + amount", async () => {
    const key = "send_payment_link:biz-001:conv-001:5000";

    // First acquisition succeeds
    mockInsertSuccess();
    const first = await acquireIdempotencyKey(key, "trace-1");
    expect(first.alreadySeen).toBe(false);

    // Second acquisition (e.g. Cloudflare retry) is blocked — the key already
    // exists; simulate it having been marked success by the first attempt.
    mockInsertConflict();
    mockKeyFound("success");
    const second = await acquireIdempotencyKey(key, "trace-2");
    expect(second.alreadySeen).toBe(true);
  });

  describe("guard.markSuccess / guard.markFailed", () => {
    it("markSuccess resolves without throwing when the update succeeds", async () => {
      mockInsertSuccess();
      const guard = await acquireIdempotencyKey("send_whatsapp:+234:abc", "trace-1");

      mockSupabaseAdmin.eq.mockResolvedValueOnce({ error: null });
      await expect(guard.markSuccess()).resolves.not.toThrow();
    });

    it("markSuccess throws if the DB update reports an error (avoids a silently stuck lock)", async () => {
      mockInsertSuccess();
      const guard = await acquireIdempotencyKey("send_whatsapp:+234:abc", "trace-1");

      mockSupabaseAdmin.eq.mockResolvedValueOnce({ error: { message: "db down" } });
      await expect(guard.markSuccess()).rejects.toThrow(/db down/);
    });

    it("markFailed deletes the row so the next retry can re-acquire", async () => {
      mockInsertSuccess();
      const guard = await acquireIdempotencyKey("send_whatsapp:+234:abc", "trace-1");

      await expect(guard.markFailed("network error")).resolves.not.toThrow();
      expect(mockSupabaseAdmin.delete).toHaveBeenCalled();
    });
  });
});

describe("pruneIdempotencyKeys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSupabaseAdmin.from.mockReturnThis();
    mockSupabaseAdmin.delete.mockReturnThis();
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
