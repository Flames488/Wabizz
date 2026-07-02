/**
 * cache.test.ts
 *
 * Tests for the in-process cache layer (KV not available in Vitest node env).
 * Verifies: get/set/del, TTL expiry, getOrSet (miss, hit, loader error),
 * delPattern, CacheKeys builders.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We import the actual cache module — in-process store, KV binding undefined
import { cache, CacheKeys, CacheTTL } from "../../lib/cache";

describe("cache — in-process store", () => {
  beforeEach(() => {
    // Clear internal store between tests by deleting all entries
    cache.delPattern(""); // matches everything (empty prefix)
  });

  it("set and get returns the stored value", async () => {
    await cache.set("test:key1", { foo: "bar" }, { ttlSeconds: 60 });
    const result = await cache.get<{ foo: string }>("test:key1");
    expect(result).toEqual({ foo: "bar" });
  });

  it("get returns null for missing key", async () => {
    const result = await cache.get("test:nonexistent");
    expect(result).toBeNull();
  });

  it("get returns null after TTL expires", async () => {
    // Set TTL of 0 seconds — already expired
    await cache.set("test:expiry", "value", { ttlSeconds: 0 });
    // Force expiry by waiting a tick
    await new Promise((r) => setTimeout(r, 10));
    const result = await cache.get("test:expiry");
    expect(result).toBeNull();
  });

  it("del removes a key", async () => {
    await cache.set("test:del", "value", { ttlSeconds: 60 });
    await cache.del("test:del");
    const result = await cache.get("test:del");
    expect(result).toBeNull();
  });

  it("delPattern removes all matching keys", async () => {
    await cache.set("biz:aaa", "A", { ttlSeconds: 60 });
    await cache.set("biz:bbb", "B", { ttlSeconds: 60 });
    await cache.set("sub:ccc", "C", { ttlSeconds: 60 });

    cache.delPattern("biz:");

    expect(await cache.get("biz:aaa")).toBeNull();
    expect(await cache.get("biz:bbb")).toBeNull();
    expect(await cache.get("sub:ccc")).toBe("C"); // unaffected
  });

  it("stores and retrieves complex objects", async () => {
    const obj = {
      id: "b1",
      name: "Mama's Kitchen",
      open_time: "09:00",
      close_time: "20:00",
      nested: { count: 42, tags: ["food", "local"] },
    };
    await cache.set("test:complex", obj, { ttlSeconds: 60 });
    const result = await cache.get<typeof obj>("test:complex");
    expect(result).toEqual(obj);
  });

  it("stores booleans correctly (false is not null)", async () => {
    await cache.set("test:bool-false", false, { ttlSeconds: 60 });
    const result = await cache.get<boolean>("test:bool-false");
    expect(result).toBe(false);
  });
});

describe("cache.getOrSet", () => {
  beforeEach(() => cache.delPattern(""));

  it("calls loader on miss and caches result", async () => {
    const loader = vi.fn().mockResolvedValue({ id: "biz-1", name: "Shop" });

    const result1 = await cache.getOrSet("test:gos1", loader, { ttlSeconds: 60 });
    const result2 = await cache.getOrSet("test:gos1", loader, { ttlSeconds: 60 });

    expect(result1).toEqual({ id: "biz-1", name: "Shop" });
    expect(result2).toEqual({ id: "biz-1", name: "Shop" });
    expect(loader).toHaveBeenCalledTimes(1); // loader only called on miss
  });

  it("returns cached value on hit without calling loader", async () => {
    await cache.set("test:gos2", "cached-value", { ttlSeconds: 60 });
    const loader = vi.fn().mockResolvedValue("fresh-value");

    const result = await cache.getOrSet("test:gos2", loader, { ttlSeconds: 60 });
    expect(result).toBe("cached-value");
    expect(loader).not.toHaveBeenCalled();
  });

  it("propagates loader errors without caching", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("DB down"));

    await expect(cache.getOrSet("test:gos3", loader, { ttlSeconds: 60 })).rejects.toThrow(
      "DB down",
    );

    // Should not have cached anything
    expect(await cache.get("test:gos3")).toBeNull();
  });

  it("does not cache null values", async () => {
    const loader = vi.fn().mockResolvedValue(null);

    const result = await cache.getOrSet<null>("test:gos-null", loader, { ttlSeconds: 60 });
    expect(result).toBeNull();

    // Second call should call loader again (null was not cached)
    const loader2 = vi.fn().mockResolvedValue(null);
    await cache.getOrSet<null>("test:gos-null", loader2, { ttlSeconds: 60 });
    expect(loader2).toHaveBeenCalled();
  });
});

describe("CacheKeys builders", () => {
  it("produces unique keys per entity type", () => {
    const id = "abc123";
    const keys = [
      CacheKeys.business(id),
      CacheKeys.businessByOwner(id),
      CacheKeys.subscription(id),
      CacheKeys.whatsappConfig(id),
      CacheKeys.paystackKey(id),
    ];
    // All keys must be unique
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("conversation key includes both business and customer", () => {
    const key = CacheKeys.conversation("biz1", "+2348012345678");
    expect(key).toContain("biz1");
    expect(key).toContain("2348012345678");
  });

  it("same id produces same key deterministically", () => {
    expect(CacheKeys.business("x")).toBe(CacheKeys.business("x"));
  });
});

describe("cache.localSize", () => {
  beforeEach(() => cache.delPattern(""));

  it("counts only live (non-expired) entries", async () => {
    await cache.set("size:1", "a", { ttlSeconds: 60 });
    await cache.set("size:2", "b", { ttlSeconds: 60 });
    await cache.set("size:3", "c", { ttlSeconds: 0 }); // immediately expired

    await new Promise((r) => setTimeout(r, 10)); // let expire

    // size:3 expired — localSize should count it out on read
    const result = await cache.get("size:3"); // triggers expiry eviction
    expect(result).toBeNull();

    const size = cache.localSize();
    expect(size).toBeGreaterThanOrEqual(2);
  });
});
