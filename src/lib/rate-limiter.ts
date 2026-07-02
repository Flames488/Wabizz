/**
 * rate-limiter.ts — v7 (rate limit event recording + Sentry on sustained abuse)
 *
 * Changes vs v6:
 *   - Rate limit hits are now recorded to the rate_limit_events table
 *     (added in migration 021) so you can see exactly which IPs/endpoints
 *     are hitting limits in the admin dashboard
 *   - Sustained abuse (same key blocked 10+ times in a window) triggers a
 *     Sentry warning so you get alerted to potential attack patterns
 *   - Recording is fire-and-forget — never blocks the request path
 *   - Endpoint label passed through to checkRateLimit() for richer analytics
 *
 * Backend priority (unchanged):
 *   1. Sharded Durable Objects (Workers) — atomic, no hotspot
 *   2. Upstash Redis (Node/PM2)          — atomic INCR
 *   3. In-memory Map                     — per-process fallback
 */

import { shardedDoName } from "@/lib/rate-limiter-do";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { captureMessage } from "@/lib/sentry";

declare const RATE_LIMIT_DO: DurableObjectNamespace | undefined;

const WINDOW_MS = 60_000;

// Track block counts per key in memory to detect sustained abuse
const _blockCounts = new Map<string, { count: number; windowStart: number }>();
const ABUSE_THRESHOLD = 10; // blocks in one window before Sentry alert

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: string; remaining: 0 };

// ── Backend 1: Sharded Durable Objects ───────────────────────────────────────

async function _checkDurableObjectRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult | null> {
  if (typeof RATE_LIMIT_DO === "undefined") return null;

  try {
    const doName = shardedDoName(key);
    const id = RATE_LIMIT_DO.idFromName(doName);
    const stub = RATE_LIMIT_DO.get(id);

    const res = await stub.fetch("https://internal/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, limit, windowMs }),
      signal: AbortSignal.timeout(3_000),
    } as RequestInit);

    if (!res.ok) return null;
    const data = (await res.json()) as { allowed: boolean; remaining: number; reason?: string };

    return data.allowed
      ? { allowed: true, remaining: data.remaining }
      : { allowed: false, reason: data.reason ?? `Rate limit exceeded`, remaining: 0 };
  } catch (e) {
    console.error("[rate-limiter] DO error, falling through:", String(e));
    return null;
  }
}

// ── Backend 2: Upstash Redis (Node/PM2) ──────────────────────────────────────

async function _checkUpstashRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult | null> {
  const url = typeof process !== "undefined" ? process.env.UPSTASH_REDIS_REST_URL : undefined;
  const token = typeof process !== "undefined" ? process.env.UPSTASH_REDIS_REST_TOKEN : undefined;
  if (!url || !token) return null;

  const windowKey = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
  const windowTtl = Math.ceil(windowMs / 1000) * 2;

  try {
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(windowKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!incrRes.ok) return null;
    const { result: count } = (await incrRes.json()) as { result: number };

    if (count === 1) {
      void fetch(`${url}/expire/${encodeURIComponent(windowKey)}/${windowTtl}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    return count > limit
      ? { allowed: false, reason: `Rate limit exceeded: ${key}`, remaining: 0 }
      : { allowed: true, remaining: limit - count };
  } catch {
    return null;
  }
}

// ── Backend 3: In-memory Map fallback ────────────────────────────────────────

interface MemBucket {
  count: number;
  windowStart: number;
}
const _memStore = new Map<string, MemBucket>();
let _lastPurge = Date.now();

function _checkMemRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (now - _lastPurge > 5 * 60_000) {
    _lastPurge = now;
    for (const [k, b] of _memStore) {
      if (now - b.windowStart > windowMs * 2) _memStore.delete(k);
    }
  }
  const existing = _memStore.get(key);
  if (!existing || now - existing.windowStart > windowMs) {
    _memStore.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit - 1 };
  }
  if (existing.count >= limit) {
    return { allowed: false, reason: `Rate limit exceeded: ${key}`, remaining: 0 };
  }
  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count };
}

// ── Rate limit event recording (fire-and-forget) ──────────────────────────────

function _recordBlock(key: string, endpoint: string, ip?: string): void {
  // Write to rate_limit_events for analytics — never awaited
  void supabaseAdmin.from("rate_limit_events").insert({
    key,
    endpoint,
    ip: ip ?? null,
    occurred_at: new Date().toISOString(),
  });

  // Track sustained abuse — alert to Sentry if same key is blocked repeatedly
  const now = Date.now();

  // WARN 1 FIX: _blockCounts is an unbounded in-memory Map. Under sustained load
  // (DDoS, traffic spike) unique IPs accumulate indefinitely — the Map grows until
  // the Worker OOMs and crashes. Fix: when the Map exceeds 5 000 entries, evict
  // all entries older than 10 minutes. This is O(n) but runs rarely (only when the
  // Map is already large) and never on the hot request path (it's fire-and-forget).
  if (_blockCounts.size > 5000) {
    const EVICT_AGE_MS = 10 * 60 * 1000; // 10 minutes
    for (const [k, v] of _blockCounts) {
      if (now - v.windowStart > EVICT_AGE_MS) {
        _blockCounts.delete(k);
      }
    }
  }

  const existing = _blockCounts.get(key);
  if (!existing || now - existing.windowStart > WINDOW_MS) {
    _blockCounts.set(key, { count: 1, windowStart: now });
  } else {
    existing.count += 1;
    if (existing.count === ABUSE_THRESHOLD) {
      // Only alert once per window at the threshold — not on every subsequent hit
      captureMessage(
        `Sustained rate limit abuse: ${key} blocked ${existing.count} times`,
        "warning",
        { source: "rate-limiter", key, endpoint, blockCount: existing.count },
      );
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs = WINDOW_MS,
  endpoint = "unknown",
  ip?: string,
): Promise<RateLimitResult> {
  const doResult = await _checkDurableObjectRateLimit(key, limit, windowMs);
  const result =
    doResult !== null
      ? doResult
      : ((await _checkUpstashRateLimit(key, limit, windowMs)) ??
        _checkMemRateLimit(key, limit, windowMs));

  if (!result.allowed) {
    _recordBlock(key, endpoint, ip);
  }

  return result;
}

export async function checkIpRateLimit(
  ip: string,
  limit = 500,
  endpoint = "unknown",
): Promise<RateLimitResult> {
  return checkRateLimit(`ip:${ip}`, limit, WINDOW_MS, endpoint, ip);
}

export function _resetMemStoreForTests(): void {
  _memStore.clear();
  _blockCounts.clear();
  _lastPurge = Date.now();
}
