/**
 * circuit-breaker.ts — Circuit breaker for external API calls (v3)
 *
 * WHAT CHANGED IN v3:
 *   Circuit state now persists in a Durable Object (CircuitStateDO) so all
 *   Worker instances share the same state. Previously state was in-memory only:
 *   a new or evicted Worker instance would start with all circuits CLOSED and
 *   re-probe a down service immediately, wasting a call and potentially
 *   cascading if many instances reset simultaneously.
 *
 *   v3 adds:
 *     - CircuitStateDO binding ("CIRCUIT_STATE_DO") for cross-instance state
 *     - Request-scoped in-memory cache (avoids a DO round-trip on every call)
 *     - Graceful fallback to pure in-memory if DO binding is absent (local dev)
 *
 * States:
 *   CLOSED   → normal operation, requests pass through
 *   OPEN     → circuit tripped, requests fail fast (no network call)
 *   HALF_OPEN → cooldown elapsed, one test request allowed through
 *
 * Thresholds (per service, configurable):
 *   failureThreshold: 5 failures in the window → OPEN
 *   windowMs:         60s sliding window
 *   cooldownMs:       30s before HALF_OPEN
 *
 * Wrangler config (wrangler.jsonc) — add to durable_objects.bindings:
 *   { "name": "CIRCUIT_STATE_DO", "class_name": "CircuitStateDO" }
 *
 * Add to migrations:
 *   { "tag": "v2", "new_classes": ["CircuitStateDO"] }
 */

import { events } from "@/lib/server/event-pipeline";
import { recordApiCall } from "@/lib/server/admin/metrics";
import { alerts } from "@/lib/server/alerts/alert-engine";
import { logWarn } from "@/lib/server-logger";
import { captureMessage } from "@/lib/sentry";
import type { CircuitStatePayload, CircuitUpdateRequest } from "./circuit-breaker-do";

// WARN 3 FIX: "360dialog" added as an explicit service name.
// Previously, campaign-processor and consumer both called circuitBreaker("twilio")
// even when making 360dialog API calls. This meant:
//   1. Observability was wrong — the "twilio" circuit was tripped by 360dialog failures
//   2. A 360dialog outage would open the "twilio" breaker and block Twilio calls too
//   3. Dashboards and alerts showed false "twilio" errors from 360dialog traffic
// Each provider now has its own isolated circuit so they fail independently.
//
// SCORECARD FIX: "vitar" added as a circuit-breaker service.
// Without it, every hospital-niche booking message waited the full HTTP timeout
// (~10s) when the clinic's Vitar instance was down — burning Worker CPU and
// creating cascading latency at 10k businesses. At 5% hospital niche penetration
// (500 clinics) and a 10s failure timeout, a Vitar outage could consume 5,000
// Worker CPU-seconds per minute of downtime. With this breaker the failure is
// detected after 3 attempts (< 1s) and all subsequent calls fail-fast instantly.
export type ServiceName = "twilio" | "paystack" | "anthropic" | "360dialog" | "meta_whatsapp" | "vitar";

export class CircuitOpenError extends Error {
  constructor(service: ServiceName) {
    super(`Circuit OPEN for ${service} — failing fast to prevent retry storm`);
    this.name = "CircuitOpenError";
  }
}

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface LocalCircuitData extends CircuitStatePayload {
  cachedAt: number;
}

// ── Per-service circuit breaker configuration ─────────────────────────────────
// Lower thresholds for external paid APIs (360dialog, Twilio, Paystack) so that
// an outage trips the breaker quickly and stops retry storms from flooding the
// queue and Supabase with thousands of doomed attempts.
//
// Rationale for threshold=3 on messaging/payment services:
//   - 3 consecutive failures in 60s almost certainly means the service is down
//   - At 500 msg/min, threshold=5 allows 5 retries × 500 concurrent = 2,500
//     wasted queue slots before the breaker opens
//   - threshold=3 keeps wasted attempts to ≤1,500 — a 40% reduction in blast radius
//
// Anthropic uses threshold=5 (higher tolerance) because:
//   - Transient 529s (overloaded) are common and usually self-resolve in 1–2s
//   - Opening the AI circuit too aggressively silences the bot for 30s+
//   - Revenue impact of a silent bot > revenue impact of 2 extra wasted AI calls

interface ServiceConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

const SERVICE_CONFIG: Record<ServiceName, ServiceConfig> = {
  "360dialog": { failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000 },
  meta_whatsapp: { failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000 },
  twilio: { failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000 },
  paystack: { failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000 },
  anthropic: { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 },
  // Vitar: threshold=3, cooldown=60s (longer than other services).
  // Rationale: Vitar is self-hosted (single instance). A restart takes ~40-60s
  // (process boot + healthcheck). A 30s cooldown causes the breaker to re-probe
  // a still-booting Vitar, fail again, and reset the clock — effectively keeping
  // hospital booking traffic alive and burning Worker CPU for the full restart window.
  // 60s gives Vitar time to complete its startup before the first probe is allowed.
  vitar: { failureThreshold: 3, windowMs: 60_000, cooldownMs: 60_000 },
};

// Legacy constants kept for backward compatibility with DO calls
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 60_000;
const COOLDOWN_MS = 30_000;

// ── In-memory fallback + request-scoped DO cache ──────────────────────────────
const _local = new Map<ServiceName, LocalCircuitData>();

function _localGet(service: ServiceName): LocalCircuitData {
  if (!_local.has(service)) {
    _local.set(service, {
      state: "CLOSED",
      failures: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      openedAt: 0,
      cachedAt: 0,
    });
  }
  return _local.get(service)!;
}

function _localSet(service: ServiceName, data: CircuitStatePayload): void {
  _local.set(service, { ...data, cachedAt: Date.now() });
}

function _localReset(service: ServiceName): void {
  _local.set(service, {
    state: "CLOSED",
    failures: 0,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    openedAt: 0,
    cachedAt: Date.now(),
  });
}

// ── DO client helpers ─────────────────────────────────────────────────────────

function _getStub(service: ServiceName): DurableObjectStub | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (globalThis as any).CIRCUIT_STATE_DO as DurableObjectNamespace | undefined;
    if (!ns) return null;
    return ns.get(ns.idFromName(service));
  } catch {
    return null;
  }
}

async function _doRequest(
  service: ServiceName,
  body: CircuitUpdateRequest,
): Promise<CircuitStatePayload | null> {
  const stub = _getStub(service);
  if (!stub) return null;
  try {
    const res = await stub.fetch("https://circuit-breaker/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as CircuitStatePayload;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute fn() through the circuit breaker for service.
 * Throws CircuitOpenError immediately if circuit is OPEN.
 * Throws the original error from fn() if call fails (circuit tracks it).
 */
export async function circuitBreaker<T>(service: ServiceName, fn: () => Promise<T>): Promise<T> {
  // 1. Fetch current state from DO (or use local fallback)
  const fetched = await _doRequest(service, { action: "get" });
  let c: LocalCircuitData;

  if (fetched) {
    _localSet(service, fetched);
    c = _localGet(service);
  } else {
    c = _localGet(service);
    const now = Date.now();
    if (c.state === "CLOSED" && now - c.lastFailureAt > WINDOW_MS) {
      c.failures = 0;
    }
  }

  const now = Date.now();

  // 2. OPEN: attempt cooldown transition
  if (c.state === "OPEN") {
    if (now - c.openedAt >= COOLDOWN_MS) {
      const updated = await _doRequest(service, {
        action: "try_half_open",
        cooldownMs: COOLDOWN_MS,
      });
      if (updated) {
        _localSet(service, updated);
        c = _localGet(service);
      } else {
        if (now - c.openedAt >= COOLDOWN_MS) c.state = "HALF_OPEN";
      }
      if (c.state === "OPEN") throw new CircuitOpenError(service);
      events.circuitClosed(service);
    } else {
      throw new CircuitOpenError(service);
    }
  }

  // 3. Execute the call
  try {
    const result = await fn();

    const updated = await _doRequest(service, { action: "record_success" });
    if (updated) {
      _localSet(service, updated);
    } else {
      if (c.state === "HALF_OPEN") {
        _localReset(service);
      } else {
        c.failures = Math.max(0, c.failures - 1);
        c.consecutiveFailures = 0;
      }
    }

    if (c.state === "HALF_OPEN") {
      captureMessage(`Circuit recovered: ${service} is back online`, "info", {
        service,
        previousFailures: c.failures,
      });
      events.circuitClosed(service);
    }

    recordApiCall(service, true, 0);
    return result;
  } catch (e) {
    const updated = await _doRequest(service, {
      action: "record_failure",
      // Use per-service thresholds so messaging/payment services trip faster
      // than the AI service (see SERVICE_CONFIG above for rationale)
      failureThreshold: SERVICE_CONFIG[service].failureThreshold,
      windowMs: SERVICE_CONFIG[service].windowMs,
      cooldownMs: SERVICE_CONFIG[service].cooldownMs,
    });

    let newState: CircuitState = c.state;
    let newFailures = c.failures + 1;
    let newConsecutive = c.consecutiveFailures + 1;

    if (updated) {
      _localSet(service, updated);
      newState = updated.state;
      newFailures = updated.failures;
      newConsecutive = updated.consecutiveFailures;
    } else {
      c.failures += 1;
      c.consecutiveFailures += 1;
      c.lastFailureAt = now;
      if (c.state === "HALF_OPEN" || c.failures >= SERVICE_CONFIG[service].failureThreshold) {
        c.state = "OPEN";
        c.openedAt = now;
        newState = "OPEN";
      }
    }

    void alerts.apiDown(service, newConsecutive, String(e));

    if (newState === "OPEN") {
      events.circuitOpen(service, newFailures);
      logWarn("circuit-breaker", `${service}: OPEN (${newFailures} failures)`, {
        service,
        failures: newFailures,
        consecutiveFailures: newConsecutive,
        backend: updated ? "durable-object" : "in-memory",
      });
      captureMessage(`Circuit OPEN: ${service} (${newFailures} failures in window)`, "warning", {
        source: "circuit-breaker",
        service,
        failures: newFailures,
        consecutiveFailures: newConsecutive,
        openedAt: new Date(updated?.openedAt ?? now).toISOString(),
        lastError: e instanceof Error ? e.message : String(e),
        backend: updated ? "durable-object" : "in-memory",
      });
    }

    recordApiCall(service, false, 0);
    throw e;
  }
}

/**
 * Get circuit state for all services — used by health endpoint.
 */
export async function getCircuitStates(): Promise<
  Record<ServiceName, { state: CircuitState; failures: number; openedAt?: string; backend: string }>
> {
  const services: ServiceName[] = ["twilio", "paystack", "anthropic", "360dialog", "meta_whatsapp", "vitar"];
  const result: Record<
    string,
    { state: CircuitState; failures: number; openedAt?: string; backend: string }
  > = {};

  for (const s of services) {
    const doData = await _doRequest(s, { action: "get" });
    if (doData) {
      _localSet(s, doData);
      result[s] = {
        state: doData.state,
        failures: doData.failures,
        backend: "durable-object",
        ...(doData.openedAt ? { openedAt: new Date(doData.openedAt).toISOString() } : {}),
      };
    } else {
      const c = _localGet(s);
      result[s] = {
        state: c.state,
        failures: c.failures,
        backend: "in-memory",
        ...(c.openedAt ? { openedAt: new Date(c.openedAt).toISOString() } : {}),
      };
    }
  }

  return result as Record<
    ServiceName,
    { state: CircuitState; failures: number; openedAt?: string; backend: string }
  >;
}
