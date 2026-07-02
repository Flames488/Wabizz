/**
 * cache.ts — Application-level cache  (v3)
 *
 * Three-tier cache:
 *  Tier 1 — In-process Map   (instant, no network; resets on worker restart)
 *  Tier 2 — Upstash Redis    (shared across PM2 cluster workers; atomic; optional)
 *  Tier 3 — Cloudflare KV    (persists across requests; shared across Workers)
 *
 * Priority on read: in-process → KV/Redis (whichever is available)
 * Priority on write: always write to all available tiers
 *
 * FIX v3: In-process Map is now size-capped at MAX_LOCAL_ENTRIES (2 000).
 *   At 5 000 concurrent users with many short-lived keys (one per conversation,
 *   per business lookup) the map would grow without limit until the Cloudflare
 *   Worker hit its 128 MB memory ceiling and was killed.
 *   When the cap is reached, the oldest 20 % of entries (by expiresAt) are
 *   evicted — cheapest strategy that avoids a hot-key thrash.
 *
 * Node/PM2 deployments:
 *   Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable
 *   shared cache invalidation across all cluster workers. Without it,
 *   each worker has an isolated in-process cache (stale reads possible
 *   after updates in a different worker).
 *
 * Cloudflare Workers deployments:
 *   KV is used automatically — Upstash config is ignored.
 */

declare const CACHE_KV: KVNamespace | undefined;

export interface CacheSetOptions {
  /** TTL in seconds. Default: 300 (5 min). */
  ttlSeconds?: number;
}

// ── Tier 1: In-process store (size-capped) ───────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const MAX_LOCAL_ENTRIES = 2_000;
const EVICT_RATIO = 0.2; // evict oldest 20 % when cap is hit

const _store = new Map<string, CacheEntry<unknown>>();

/**
 * Evict the oldest EVICT_RATIO fraction of entries by expiresAt.
 * Called only when _store.size >= MAX_LOCAL_ENTRIES.
 * O(n log n) — acceptable because it fires rarely and n ≤ MAX_LOCAL_ENTRIES.
 */
function _evictOldest(): void {
  const entries = [..._store.entries()].sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
  const toRemove = Math.ceil(entries.length * EVICT_RATIO);
  for (let i = 0; i < toRemove; i++) {
    _store.delete(entries[i][0]);
  }
}

function _getLocal<T>(key: string): T | null {
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _store.delete(key);
    return null;
  }
  return entry.value as T;
}

function _setLocal<T>(key: string, value: T, ttlSeconds: number): void {
  if (_store.size >= MAX_LOCAL_ENTRIES) _evictOldest();
  _store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
}

function _delLocal(key: string): void {
  _store.delete(key);
}

// ── Tier 2: Upstash Redis (shared across Node/PM2 workers) ───────────────────

function _upstashConfig(): { url: string; token: string } | null {
  const url = typeof process !== "undefined" ? process.env.UPSTASH_REDIS_REST_URL : undefined;
  const token = typeof process !== "undefined" ? process.env.UPSTASH_REDIS_REST_TOKEN : undefined;
  if (!url || !token) return null;
  return { url, token };
}

async function _getUpstash<T>(key: string): Promise<T | null> {
  const cfg = _upstashConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const { result } = (await res.json()) as { result: string | null };
    if (result === null) return null;
    return JSON.parse(result) as T;
  } catch {
    return null;
  }
}

// Circuit-breaker: warn once per process if Upstash writes start failing.
// Avoids log spam while still alerting operators that the shared cache tier is down.
let _upstashWarnedAt = 0;
const UPSTASH_WARN_INTERVAL_MS = 5 * 60_000; // warn at most once per 5 min

async function _setUpstash<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const cfg = _upstashConfig();
  if (!cfg) return;
  try {
    const res = await fetch(`${cfg.url}/set/${encodeURIComponent(key)}?ex=${ttlSeconds}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const now = Date.now();
    if (now - _upstashWarnedAt > UPSTASH_WARN_INTERVAL_MS) {
      _upstashWarnedAt = now;
      console.warn(
        JSON.stringify({
          level: "warn",
          source: "cache",
          message:
            "Upstash cache write failed — shared cache tier may be down, falling back to in-process only",
          error: String(e),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}

async function _delUpstash(key: string): Promise<void> {
  const cfg = _upstashConfig();
  if (!cfg) return;
  try {
    const res = await fetch(`${cfg.url}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const now = Date.now();
    if (now - _upstashWarnedAt > UPSTASH_WARN_INTERVAL_MS) {
      _upstashWarnedAt = now;
      console.warn(
        JSON.stringify({
          level: "warn",
          source: "cache",
          message:
            "Upstash cache delete failed — shared cache tier may be down, falling back to in-process only",
          error: String(e),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    // 1. In-process (fastest)
    const local = _getLocal<T>(key);
    if (local !== null) return local;

    // 2a. Cloudflare KV (Workers)
    if (typeof CACHE_KV !== "undefined") {
      try {
        const raw = await CACHE_KV.get(key);
        if (raw) {
          const value = JSON.parse(raw) as T;
          _setLocal(key, value, 60);
          return value;
        }
      } catch (e) {
        console.error("[cache] KV get error:", String(e));
      }
      return null;
    }

    // 2b. Upstash Redis (Node/PM2 with Redis configured)
    const upstash = await _getUpstash<T>(key);
    if (upstash !== null) {
      _setLocal(key, upstash, 60); // warm local cache
      return upstash;
    }

    return null;
  },

  async set<T>(key: string, value: T, opts: CacheSetOptions = {}): Promise<void> {
    const ttl = opts.ttlSeconds ?? 300;
    _setLocal(key, value, ttl);

    if (typeof CACHE_KV !== "undefined") {
      try {
        await CACHE_KV.put(key, JSON.stringify(value), { expirationTtl: ttl });
      } catch (e) {
        console.error("[cache] KV set error:", String(e));
      }
    } else {
      await _setUpstash(key, value, ttl);
    }
  },

  async del(key: string): Promise<void> {
    _delLocal(key);
    if (typeof CACHE_KV !== "undefined") {
      try {
        await CACHE_KV.delete(key);
      } catch (e) {
        console.error("[cache] KV delete error:", String(e));
      }
    } else {
      await _delUpstash(key);
    }
  },

  delPattern(prefix: string): void {
    for (const key of _store.keys()) {
      if (key.startsWith(prefix)) _store.delete(key);
    }
  },

  async getOrSet<T>(key: string, loader: () => Promise<T>, opts: CacheSetOptions = {}): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await loader();
    if (value !== null && value !== undefined) await this.set(key, value, opts);
    return value;
  },

  /** Returns the number of non-expired entries in the local in-process store. */
  localSize(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of _store.values()) {
      if (entry.expiresAt > now) count++;
    }
    return count;
  },

  /** Maximum in-process entries before eviction fires. Exposed for tests. */
  get maxLocalEntries(): number {
    return MAX_LOCAL_ENTRIES;
  },
};

// ── Cache key builders ────────────────────────────────────────────────────────

export const CacheKeys = {
  business: (id: string) => `biz:${id}`,
  businessByOwner: (ownerId: string) => `biz_owner:${ownerId}`,
  subscription: (businessId: string) => `sub:${businessId}`,
  whatsappConfig: (businessNumber: string) => `wa_cfg:${businessNumber}`,
  // SCALE FIX 1: cache API keys by businessId — these are fetched on every
  // inbound webhook but change essentially never. Without caching, each message
  // makes 2 Supabase round-trips (whatsapp_config + vault.decrypted_secrets).
  whatsappApiKey: (businessId: string) => `wa_key:${businessId}`,
  paystackSecretKey: (businessId: string) => `psk_key:${businessId}`,
  paystackKey: (businessId: string) => `psk:${businessId}`,
  conversation: (businessId: string, customerNumber: string) =>
    `conv:${businessId}:${customerNumber}`,
  // PERF FIX: niche configs + Vault secrets are cached for 1 hour.
  // vault_read_secret fires on EVERY message for hospital businesses without this.
  // API keys effectively never change — cache invalidation happens on explicit config save.
  nicheConfigs: (businessId: string) => `niche_cfg:${businessId}`,
} as const;

export const CacheTTL = {
  business: 300,
  subscription: 120,
  whatsappConfig: 600,
  whatsappApiKey: 600, // API keys change only on key rotation
  paystackSecretKey: 600,
  paystackKey: 600,
  conversation: 30,
  nicheConfigs: 3600, // 1-hour TTL — Vault secrets and niche config change rarely
} as const;
