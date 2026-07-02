/**
 * request-tracker.ts — Request lifecycle middleware
 *
 * Wraps route handlers with:
 *  1. In-flight request counting for graceful drain on shutdown
 *  2. Early rejection when the process is shutting down (returns 503)
 *  3. Composable with withRequestTimeout
 *
 * Usage — wrap every server handler that should participate in graceful drain:
 *
 *   POST: async ({ request }) =>
 *     withRequestTracking(() =>
 *       withRequestTimeout(request, 25_000, async () => { ... })
 *     )
 *
 * Why this matters:
 *   Without this, the graceful shutdown drain in graceful-shutdown.ts
 *   polls _activeRequests which is always 0 — meaning SIGTERM causes
 *   the process to exit immediately, dropping any in-flight requests.
 *   With this wrapper, the drain waits until all active handlers complete
 *   before exiting (up to the 10s timeout configured in server-init.ts).
 */

import { requestStart, requestEnd, isShuttingDown } from "@/lib/graceful-shutdown";

/**
 * Wrap an async response handler with graceful-drain request tracking.
 *
 * - Returns 503 immediately if a shutdown is in progress.
 * - Increments the active request counter before calling the handler.
 * - Decrements it in a finally block so it always runs, even on throws.
 */
export async function withRequestTracking(handler: () => Promise<Response>): Promise<Response> {
  // Reject new requests during shutdown window so the drain can complete
  if (isShuttingDown()) {
    return new Response(
      JSON.stringify({ ok: false, error: "Server is shutting down. Please retry in a moment." }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "10",
        },
      },
    );
  }

  requestStart();
  try {
    return await handler();
  } finally {
    requestEnd();
  }
}
