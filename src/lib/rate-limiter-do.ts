/**
 * rate-limiter-do.ts — Sharded Durable Object rate limiter
 *
 * PROBLEM WITH v1:
 *   A single Durable Object for all rate limit keys becomes a hotspot.
 *   All traffic funnels through one DO instance → serialised requests → latency.
 *
 * FIX IN v2:
 *   Shard DO instances by key hash: hash(key) % NUM_SHARDS
 *   Each shard handles ~1/N of all rate limit traffic independently.
 *   No single instance is a bottleneck.
 *
 * Sharding strategy:
 *   Per-user limits:  hash(userId)  % NUM_SHARDS → different shard per user
 *   Per-IP limits:    hash(ip)      % NUM_SHARDS → different shard per IP
 *   Per-business:     hash(bizId)   % NUM_SHARDS → different shard per business
 *
 *   Result: each DO instance handles ~1/NUM_SHARDS of traffic.
 *   At NUM_SHARDS=16 with 1000 concurrent users → ~62 users per shard.
 *
 * The key passed to the DO is "shard:{n}:{originalKey}" so each shard
 * maintains independent per-key counters without cross-shard coordination.
 *
 * Wrangler config:
 *   "durable_objects": {
 *     "bindings": [{ "name": "RATE_LIMIT_DO", "class_name": "RateLimiterDO" }]
 *   }
 */

const NUM_SHARDS = 16;

/** FNV-1a 32-bit hash — deterministic, fast, no external deps */
function _fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // unsigned 32-bit
  }
  return hash;
}

/** Route a rate-limit key to a consistent shard index */
export function shardIndex(key: string): number {
  return _fnv1a(key) % NUM_SHARDS;
}

/** Build the sharded DO name: "shard:{n}:{key}" */
export function shardedDoName(key: string): string {
  return `shard:${shardIndex(key)}:${key}`;
}

// ── Durable Object class ──────────────────────────────────────────────────────

export interface RateLimitRequest {
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResponse {
  allowed: boolean;
  remaining: number;
  reason?: string;
}

/**
 * RateLimiterDO — one instance per shard (up to NUM_SHARDS instances total).
 *
 * Each instance handles all keys that hash to its shard.
 * Per-key counters are stored in a Map in the DO's in-memory state.
 * Single-threaded execution eliminates all race conditions.
 *
 * Storage is flushed periodically — state survives worker eviction.
 */
export class RateLimiterDO {
  private state: DurableObjectState;
  // Map of key → { count, windowStart }
  private counters = new Map<string, { count: number; windowStart: number }>();
  private dirty = false;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const stored =
        await this.state.storage.get<Array<[string, { count: number; windowStart: number }]>>(
          "counters",
        );
      if (stored) {
        this.counters = new Map(stored);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as RateLimitRequest;
    const { key, limit, windowMs } = body;
    const now = Date.now();

    let entry = this.counters.get(key);

    // New window or first request for this key
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
    }

    entry.count += 1;
    this.counters.set(key, entry);
    this.dirty = true;

    // Async flush to storage (non-blocking — DO is single-threaded so state
    // is consistent; storage is for durability across evictions only)
    if (this.dirty) {
      this.dirty = false;
      // Prune stale keys before persisting
      const cutoff = now - windowMs * 2;
      for (const [k, v] of this.counters) {
        if (v.windowStart < cutoff) this.counters.delete(k);
      }
      Promise.resolve().then(() =>
        this.state.storage.put("counters", Array.from(this.counters.entries())),
      );
    }

    const allowed = entry.count <= limit;
    const response: RateLimitResponse = allowed
      ? { allowed: true, remaining: Math.max(0, limit - entry.count) }
      : { allowed: false, remaining: 0, reason: `Rate limit exceeded: ${key}` };

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
