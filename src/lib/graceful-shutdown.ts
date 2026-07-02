/**
 * graceful-shutdown.ts — Process signal handling for clean container exits
 *
 * Handles SIGTERM and SIGINT to ensure:
 *  - In-flight requests are allowed to complete
 *  - DB connections are drained
 *  - Logs are flushed
 *  - Container exits with code 0 (not a crash)
 *
 * Why this matters:
 *  - Docker / Kubernetes send SIGTERM before killing the process
 *  - Without handling it, requests mid-flight are dropped (502/503 to users)
 *  - PM2 sends SIGINT on `pm2 stop` — same issue
 *
 * Usage (in your server entry point or startup file):
 *   import { registerGracefulShutdown } from "@/lib/graceful-shutdown";
 *   registerGracefulShutdown();
 *
 * Or with custom cleanup:
 *   registerGracefulShutdown({
 *     onShutdown: async () => {
 *       await myDbPool.end();
 *       await myQueue.close();
 *     },
 *   });
 */

import { logInfo, logWarn } from "@/lib/server-logger";

export interface GracefulShutdownOptions {
  /** Called before process.exit — use for DB / queue / connection teardown. */
  onShutdown?: () => Promise<void>;
  /**
   * Maximum time (ms) to wait for in-flight requests to drain before forcing exit.
   * Default: 10 000 ms (10 seconds — Kubernetes default termination grace period).
   */
  timeoutMs?: number;
}

let _isShuttingDown = false;
let _activeRequests = 0;
let _drainResolve: (() => void) | null = null;

/** Increment active request counter — call at start of each request handler. */
export function requestStart(): void {
  _activeRequests++;
}

/** Decrement active request counter — call at end of each request handler. */
export function requestEnd(): void {
  if (_activeRequests > 0) _activeRequests--;
  if (_activeRequests === 0 && _drainResolve) {
    _drainResolve();
    _drainResolve = null;
  }
}

/** Returns true if the process is in shutdown mode — reject new work early. */
export function isShuttingDown(): boolean {
  return _isShuttingDown;
}

/**
 * Register SIGTERM and SIGINT handlers.
 * Safe to call multiple times — only registers once.
 */
let _registered = false;
export function registerGracefulShutdown(opts: GracefulShutdownOptions = {}): void {
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  if (_registered) return;
  _registered = true;

  const { onShutdown, timeoutMs = 10_000 } = opts;

  const shutdown = async (signal: string) => {
    if (_isShuttingDown) return; // Already shutting down
    _isShuttingDown = true;

    await logInfo("graceful-shutdown", `Received ${signal} — beginning graceful shutdown`, {
      activeRequests: _activeRequests,
    });

    // Wait for active requests to drain using a Promise signal instead of polling.
    // requestEnd() resolves _drainResolve when the counter hits zero.
    if (_activeRequests > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          _drainResolve = resolve;
        }),
        _sleep(timeoutMs),
      ]);
    }

    if (_activeRequests > 0) {
      await logWarn("graceful-shutdown", "Shutdown timeout exceeded, forcing exit", {
        remainingRequests: _activeRequests,
      });
    } else {
      await logInfo("graceful-shutdown", "All requests drained — exiting cleanly", {});
    }

    // Run custom teardown
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (err) {
        console.error("[graceful-shutdown] onShutdown error:", String(err));
      }
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Catch unhandled promise rejections — log them before they crash the process
  process.on("unhandledRejection", (reason) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        source: "process",
        message: "Unhandled promise rejection",
        timestamp: new Date().toISOString(),
        reason: String(reason),
      }),
    );
    // Don't exit — let the request fail naturally
  });

  process.on("uncaughtException", (err) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        source: "process",
        message: "Uncaught exception",
        timestamp: new Date().toISOString(),
        error: err.message,
        stack: err.stack?.slice(0, 1000),
      }),
    );
    // Uncaught exceptions corrupt process state — exit and let PM2/K8s restart
    process.exit(1);
  });
}

function _sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
