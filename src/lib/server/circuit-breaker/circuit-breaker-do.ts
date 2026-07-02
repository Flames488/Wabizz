/**
 * circuit-breaker-do.ts — Durable Object for cross-instance circuit breaker state
 *
 * WHY THIS EXISTS:
 *   The original in-memory circuit breaker stores state in a Map on each Worker
 *   instance. When Cloudflare evicts an instance (or routes a request to a new
 *   instance), that instance starts with all circuits CLOSED and will re-probe a
 *   down service immediately — wasting one call and potentially cascading if many
 *   instances restart simultaneously.
 *
 *   This DO gives all instances a single source of truth for circuit state.
 *   A circuit tripped by instance A stays tripped for instances B, C, D …
 *
 * DESIGN:
 *   - One DO instance per service name ("twilio", "paystack", "anthropic")
 *   - State persisted to DO storage → survives instance eviction
 *   - Single-threaded DO execution → no race conditions on state transitions
 *   - circuitBreaker() in circuit-breaker.ts now calls this DO for state
 *     reads/writes; in-memory Map is a request-scoped cache (avoids a DO call
 *     on every outbound API call in a hot path)
 *
 * FALLBACK:
 *   If the DO binding is unavailable (local dev, missing binding), the circuit
 *   breaker falls back to in-memory state silently. This means local dev
 *   behaviour is unchanged.
 *
 * WRANGLER CONFIG REQUIRED (add to wrangler.jsonc):
 *   "durable_objects": {
 *     "bindings": [
 *       { "name": "RATE_LIMIT_DO",    "class_name": "RateLimiterDO" },
 *       { "name": "CIRCUIT_STATE_DO", "class_name": "CircuitStateDO" }  ← NEW
 *     ]
 *   }
 *   "migrations": [
 *     { "tag": "v1", "new_classes": ["RateLimiterDO"] },
 *     { "tag": "v2", "new_classes": ["CircuitStateDO"] }               ← NEW
 *   ]
 */

export interface CircuitStatePayload {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  openedAt: number;
}

export interface CircuitUpdateRequest {
  action:
    | "get" // read current state
    | "record_failure" // increment failure counters, trip if threshold reached
    | "record_success" // reset on HALF_OPEN recovery
    | "try_half_open"; // transition OPEN → HALF_OPEN if cooldown elapsed
  failureThreshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * CircuitStateDO — one instance per service name.
 *
 * The DO name should be the service name ("twilio", "paystack", "anthropic").
 * Use: env.CIRCUIT_STATE_DO.idFromName("twilio")
 */
export class CircuitStateDO {
  private state: DurableObjectState;
  private data: CircuitStatePayload = {
    state: "CLOSED",
    failures: 0,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    openedAt: 0,
  };
  private loaded = false;

  constructor(state: DurableObjectState) {
    this.state = state;
    // Load persisted state before handling any requests
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<CircuitStatePayload>("circuit");
      if (stored) {
        this.data = stored;
      }
      this.loaded = true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.loaded) {
      return new Response(JSON.stringify({ error: "DO not ready" }), { status: 503 });
    }

    const body = (await request.json()) as CircuitUpdateRequest;
    const {
      action,
      failureThreshold = DEFAULT_FAILURE_THRESHOLD,
      windowMs = DEFAULT_WINDOW_MS,
      cooldownMs = DEFAULT_COOLDOWN_MS,
    } = body;

    const now = Date.now();

    switch (action) {
      case "get": {
        break; // just return current state
      }

      case "try_half_open": {
        if (this.data.state === "OPEN" && now - this.data.openedAt >= cooldownMs) {
          this.data.state = "HALF_OPEN";
          await this._persist();
        }
        break;
      }

      case "record_failure": {
        // Reset stale failure window if we're CLOSED
        if (this.data.state === "CLOSED" && now - this.data.lastFailureAt > windowMs) {
          this.data.failures = 0;
        }

        this.data.failures += 1;
        this.data.consecutiveFailures += 1;
        this.data.lastFailureAt = now;

        if (this.data.state === "HALF_OPEN" || this.data.failures >= failureThreshold) {
          this.data.state = "OPEN";
          this.data.openedAt = now;
        }

        await this._persist();
        break;
      }

      case "record_success": {
        if (this.data.state === "HALF_OPEN") {
          // Full recovery
          this.data = {
            state: "CLOSED",
            failures: 0,
            consecutiveFailures: 0,
            lastFailureAt: 0,
            openedAt: 0,
          };
        } else {
          // Normal success — decay failure count
          this.data.failures = Math.max(0, this.data.failures - 1);
          this.data.consecutiveFailures = 0;
        }
        await this._persist();
        break;
      }
    }

    return new Response(JSON.stringify(this.data), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async _persist(): Promise<void> {
    await this.state.storage.put("circuit", this.data);
  }
}
