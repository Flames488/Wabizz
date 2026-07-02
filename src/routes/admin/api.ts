/**
 * /admin/api — Admin REST API
 *
 * All routes require x-admin-token header (JWT issued at login).
 * Responds with JSON only.
 *
 * Routes:
 *   POST   /admin/api/login
 *   GET    /admin/api/metrics
 *   GET    /admin/api/queue
 *   GET    /admin/api/logs?level=&source=&since=
 *   GET    /admin/api/api-health
 *   GET    /admin/api/rate-limits
 *   POST   /admin/api/dlq/:jobId/retry
 *   POST   /admin/api/dlq/:jobId/ack
 */

import { createFileRoute } from "@tanstack/react-router";
import { adminLogin, requireAdmin, seedAdminUser } from "@/lib/server/admin/admin-auth";
import { checkRateLimit } from "@/lib/rate-limiter";
import {
  getAdminMetrics,
  getAdminTrace,
  getAdminQueue,
  getAdminLogs,
  getAdminApiHealth,
  getAdminRateLimitStats,
  retryDlqJob,
  ackDlqJob,
  grantFreeSubscription,
} from "@/lib/server/admin/admin-api";
import { getAlertHistory } from "@/lib/server/alerts/alert-engine";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function err(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// Seed admin user on first request (idempotent)
let _seeded = false;
async function ensureSeeded() {
  if (_seeded) return;
  _seeded = true;
  await seedAdminUser();
}

export const Route = createFileRoute("/admin/api")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSeeded();
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/admin\/api/, "");

        // ── POST /admin/api/login ───────────────────────────────────────────
        if (path === "/login") {
          let body: { username?: string; password?: string };
          try {
            body = await request.json();
          } catch {
            return err("Invalid JSON");
          }
          if (!body.username || !body.password) return err("username and password required");
          const ip =
            request.headers.get("cf-connecting-ip") ??
            request.headers.get("x-forwarded-for") ??
            "unknown";

          // Brute-force protection: max 10 login attempts per IP per 15 minutes.
          // After 10 failures an attacker must wait — bcrypt cost alone isn't enough
          // because it only slows each attempt, not the total attempt rate.
          const loginRl = await checkRateLimit(`admin:login:${ip}`, 10, 15 * 60_000);
          if (!loginRl.allowed) {
            return err("Too many login attempts. Please wait 15 minutes and try again.", 429);
          }

          const result = await adminLogin(body.username, body.password, ip);
          if (!result) return err("Invalid credentials", 401);
          return json({ token: result.token, expiresAt: result.expiresAt });
        }

        // All other POST routes require auth
        let admin;
        try {
          admin = await requireAdmin(request);
        } catch {
          return err("Unauthorized", 401);
        }


        // ── POST /admin/api/businesses/:id/grant-free ──────────────────────
        const grantFreeMatch = path.match(/^\/businesses\/([^/]+)\/grant-free$/);
        if (grantFreeMatch) {
          let body: { planId?: string } = {};
          try { body = await request.json(); } catch { /* use default */ }
          const planId = (body.planId ?? "pro") as "starter" | "growth" | "pro";
          try {
            const result = await grantFreeSubscription(grantFreeMatch[1], planId, admin);
            return json(result);
          } catch (e) {
            return err(String(e));
          }
        }

        // ── POST /admin/api/dlq/:jobId/retry ───────────────────────────────
        const retryMatch = path.match(/^\/dlq\/([^/]+)\/retry$/);
        if (retryMatch) {
          try {
            const result = await retryDlqJob(retryMatch[1], admin);
            return json(result);
          } catch (e) {
            return err(String(e));
          }
        }

        // ── POST /admin/api/dlq/:jobId/ack ─────────────────────────────────
        const ackMatch = path.match(/^\/dlq\/([^/]+)\/ack$/);
        if (ackMatch) {
          try {
            const result = await ackDlqJob(ackMatch[1], admin);
            return json(result);
          } catch (e) {
            return err(String(e));
          }
        }

        return err("Not found", 404);
      },

      GET: async ({ request }) => {
        await ensureSeeded();
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/admin\/api/, "");

        let admin;
        try {
          admin = await requireAdmin(request);
        } catch {
          return err("Unauthorized", 401);
        }
        void admin; // used for future per-admin filtering

        // ── GET /admin/api/metrics ──────────────────────────────────────────
        if (path === "/metrics") {
          try {
            return json(await getAdminMetrics());
          } catch (e) {
            return err(String(e), 500);
          }
        }

        // ── GET /admin/api/queue ────────────────────────────────────────────
        if (path === "/queue") {
          try {
            return json(await getAdminQueue());
          } catch (e) {
            return err(String(e), 500);
          }
        }

        // ── GET /admin/api/alerts ───────────────────────────────────────────
        if (path === "/alerts") {
          try {
            return json(await getAlertHistory(100));
          } catch (e) {
            return err(String(e), 500);
          }
        }

        // ── GET /admin/api/logs ─────────────────────────────────────────────
        if (path === "/logs") {
          const level = url.searchParams.get("level") ?? undefined;
          const source = url.searchParams.get("source") ?? undefined;
          const since = url.searchParams.get("since") ?? undefined;
          const limit = parseInt(url.searchParams.get("limit") ?? "100");
          try {
            return json(await getAdminLogs({ level, source, since, limit }));
          } catch (e) {
            return err(String(e), 500);
          }
        }

        // ── GET /admin/api/api-health ───────────────────────────────────────
        if (path === "/api-health") {
          try {
            return json(await getAdminApiHealth());
          } catch (e) {
            return err(String(e), 500);
          }
        }

        // ── GET /admin/api/trace/:traceId ──────────────────────────────────
        const traceMatch = path.match(/^\/trace\/([^/]+)$/);
        if (traceMatch) {
          try {
            return json(await getAdminTrace(traceMatch[1]));
          } catch (e) {
            return err(String(e), 500);
          }
        }

        // ── GET /admin/api/rate-limits ──────────────────────────────────────
        if (path === "/rate-limits") {
          try {
            return json(await getAdminRateLimitStats());
          } catch (e) {
            return err(String(e), 500);
          }
        }

        return err("Not found", 404);
      },
    },
  },
  component: () => null,
});
