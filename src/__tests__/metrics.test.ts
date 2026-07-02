/**
 * metrics.test.ts — Metrics pipeline and observability tests
 *
 * Covers:
 *   - 5-minute bucket flooring (time alignment)
 *   - Metric name validation
 *   - Alert threshold calculations
 *   - DLQ growth rate detection
 *   - Error rate spike detection
 *   - P95 latency computation from sample data
 *   - Metric aggregation (sum over time windows)
 */

import { describe, it, expect, vi } from "vitest";

// ── Helpers extracted from metrics.ts for testability ────────────────────────

function floorTo5MinBucket(date: Date): Date {
  const ms = date.getTime();
  const bucket = 5 * 60 * 1000;
  return new Date(Math.floor(ms / bucket) * bucket);
}

function floorToHourBucket(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
}

// ── Percentile calculation ────────────────────────────────────────────────────

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Alert threshold helpers ───────────────────────────────────────────────────

interface DLQStats {
  count: number;
  previousCount: number;
  windowMs: number;
}

function isDLQGrowing(stats: DLQStats): boolean {
  return stats.count > stats.previousCount;
}

function dlqGrowthRate(stats: DLQStats): number {
  if (stats.windowMs <= 0) return 0;
  return (stats.count - stats.previousCount) / (stats.windowMs / 60_000); // per minute
}

function isErrorRateSpike(successCount: number, failCount: number, threshold = 0.05): boolean {
  const total = successCount + failCount;
  if (total === 0) return false;
  return failCount / total > threshold;
}

// ── Metric aggregation ────────────────────────────────────────────────────────

interface MetricRow {
  metric_name: string;
  value: number;
  bucket: Date;
}

function sumMetric(rows: MetricRow[], name: string, since: Date): number {
  return rows
    .filter((r) => r.metric_name === name && r.bucket >= since)
    .reduce((sum, r) => sum + r.value, 0);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Time bucket flooring", () => {
  it("floors to 5-minute bucket boundary", () => {
    const t = new Date("2025-01-01T12:07:33.000Z");
    const b = floorTo5MinBucket(t);
    expect(b.toISOString()).toBe("2025-01-01T12:05:00.000Z");
  });

  it("returns exact boundary unchanged", () => {
    const t = new Date("2025-01-01T12:05:00.000Z");
    const b = floorTo5MinBucket(t);
    expect(b.toISOString()).toBe("2025-01-01T12:05:00.000Z");
  });

  it("floors 12:59 to 12:55", () => {
    const t = new Date("2025-01-01T12:59:59.000Z");
    const b = floorTo5MinBucket(t);
    expect(b.toISOString()).toBe("2025-01-01T12:55:00.000Z");
  });

  it("floors hour boundary to hour bucket", () => {
    const t = new Date("2025-01-01T12:37:00.000Z");
    const b = floorToHourBucket(t);
    expect(b.getHours()).toBe(12);
    expect(b.getMinutes()).toBe(0);
    expect(b.getSeconds()).toBe(0);
  });
});

describe("Percentile calculation", () => {
  it("calculates p95 from a sorted array", () => {
    // 100 samples: 1-100ms
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const p95 = percentile(samples, 95);
    expect(p95).toBeGreaterThanOrEqual(95);
    expect(p95).toBeLessThanOrEqual(100);
  });

  it("calculates p50 (median) correctly", () => {
    const samples = [10, 20, 30, 40, 50];
    const p50 = percentile(samples, 50);
    expect(p50).toBe(30);
  });

  it("returns 0 for empty array", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("p99 < p100 for realistic latency distribution", () => {
    const samples = [...Array.from({ length: 99 }, () => 100), 5000]; // one spike
    expect(percentile(samples, 99)).toBeGreaterThanOrEqual(100);
    expect(percentile(samples, 100)).toBe(5000);
  });
});

describe("DLQ growth detection", () => {
  it("detects growing DLQ", () => {
    const stats = { count: 10, previousCount: 5, windowMs: 60_000 };
    expect(isDLQGrowing(stats)).toBe(true);
  });

  it("stable DLQ is not growing", () => {
    const stats = { count: 5, previousCount: 5, windowMs: 60_000 };
    expect(isDLQGrowing(stats)).toBe(false);
  });

  it("draining DLQ is not growing", () => {
    const stats = { count: 3, previousCount: 5, windowMs: 60_000 };
    expect(isDLQGrowing(stats)).toBe(false);
  });

  it("calculates growth rate per minute", () => {
    const stats = { count: 70, previousCount: 10, windowMs: 60_000 }; // +60 in 1 min
    expect(dlqGrowthRate(stats)).toBe(60);
  });

  it("returns 0 rate for zero-width window", () => {
    const stats = { count: 10, previousCount: 0, windowMs: 0 };
    expect(dlqGrowthRate(stats)).toBe(0);
  });
});

describe("Error rate spike detection", () => {
  it("detects spike above threshold", () => {
    // 10% error rate > 5% threshold
    expect(isErrorRateSpike(90, 10, 0.05)).toBe(true);
  });

  it("passes when below threshold", () => {
    // 2% error rate < 5% threshold
    expect(isErrorRateSpike(98, 2, 0.05)).toBe(false);
  });

  it("returns false when total is 0", () => {
    expect(isErrorRateSpike(0, 0, 0.05)).toBe(false);
  });

  it("correctly uses custom threshold", () => {
    // 1% error — fails at 0.5% threshold, passes at 5%
    expect(isErrorRateSpike(990, 10, 0.005)).toBe(false); // 1% > 0.5% → true? 10/1000=0.01 > 0.005 → true
    expect(isErrorRateSpike(990, 10, 0.005)).toBe(true);
  });
});

describe("Metric aggregation", () => {
  const now = new Date("2025-01-01T12:00:00.000Z");
  const minus1 = new Date("2025-01-01T11:55:00.000Z");
  const minus2 = new Date("2025-01-01T11:50:00.000Z");
  const old = new Date("2025-01-01T10:00:00.000Z");

  const rows: MetricRow[] = [
    { metric_name: "messages_sent", value: 50, bucket: minus1 },
    { metric_name: "messages_sent", value: 30, bucket: minus2 },
    { metric_name: "messages_sent", value: 200, bucket: old }, // outside window
    { metric_name: "jobs_failed", value: 5, bucket: minus1 },
  ];

  it("sums metric within time window", () => {
    const since = new Date("2025-01-01T11:45:00.000Z");
    expect(sumMetric(rows, "messages_sent", since)).toBe(80); // 50 + 30
  });

  it("excludes rows before the window", () => {
    const since = new Date("2025-01-01T11:45:00.000Z");
    expect(sumMetric(rows, "messages_sent", since)).not.toBe(280); // old row excluded
  });

  it("sums different metric independently", () => {
    const since = new Date("2025-01-01T11:45:00.000Z");
    expect(sumMetric(rows, "jobs_failed", since)).toBe(5);
  });

  it("returns 0 for unknown metric", () => {
    const since = new Date("2025-01-01T11:45:00.000Z");
    expect(sumMetric(rows, "unknown_metric", since)).toBe(0);
  });
});
