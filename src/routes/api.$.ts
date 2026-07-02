/**
 * /api/* — Splat catch-all for top-level API sub-paths
 *
 * This file lives at src/routes/api.$.ts and handles paths like /api/anything.
 * It must NOT strip /admin/api from the pathname — that stripping belongs
 * only in src/routes/admin/api.$.ts which handles /admin/api/* paths.
 *
 * BUG (HIGH-6): The original regex /^\/admin\/api/ was applied here, so a
 * request to /api/login had its path stripped to /login correctly ONLY when
 * the URL happened to start with /admin/api — but for any URL that starts
 * with /api/ (the normal case for this route), the replace was a no-op,
 * causing all path comparisons like (path === "/login") to fail because path
 * was actually "/api/login".
 *
 * FIX: Strip /api (not /admin/api) from the pathname so that
 *   /api/login      → /login
 *   /api/metrics    → /metrics
 * etc.
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

let _seeded = false;
async function ensureSeeded() {
  if (_seeded) return;
  _seeded = true;
  await seedAdminUser();
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSeeded();
        const url = new URL(request.url);
        // Strip /api prefix (this route handles /api/* paths)
        const path = url.pathname.replace(/^\/api/, "");

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

          const loginRl = await checkRateLimit(`admin:login:${ip}`, 10, 15 * 60_000);
          if (!loginRl.allowed) {
            return err("Too many login attempts. Please wait 15 minutes and try again.", 429);
          }

          const result = await adminLogin(body.username, body.password, ip);
          if (!result) return err("Invalid credentials", 401);
          return json({ token: result.token, expiresAt: result.expiresAt });
        }

        let admin;
        try {
          admin = await requireAdmin(request);
        } catch {
          return err("Unauthorized", 401);
        }

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

        const retryMatch = path.match(/^\/dlq\/([^/]+)\/retry$/);
        if (retryMatch) {
          try {
            const result = await retryDlqJob(retryMatch[1], admin);
            return json(result);
          } catch (e) {
            return err(String(e));
          }
        }

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
        // Strip /api prefix (this route handles /api/* paths)
        const path = url.pathname.replace(/^\/api/, "");

        let admin;
        try {
          admin = await requireAdmin(request);
        } catch {
          return err("Unauthorized", 401);
        }
        void admin;

        if (path === "/metrics") {
          try { return json(await getAdminMetrics()); }
          catch (e) { return err(String(e), 500); }
        }

        if (path === "/queue") {
          try { return json(await getAdminQueue()); }
          catch (e) { return err(String(e), 500); }
        }

        if (path === "/alerts") {
          try { return json(await getAlertHistory(100)); }
          catch (e) { return err(String(e), 500); }
        }

        if (path === "/logs") {
          const level = url.searchParams.get("level") ?? undefined;
          const source = url.searchParams.get("source") ?? undefined;
          const since = url.searchParams.get("since") ?? undefined;
          const limit = parseInt(url.searchParams.get("limit") ?? "100");
          try { return json(await getAdminLogs({ level, source, since, limit })); }
          catch (e) { return err(String(e), 500); }
        }

        if (path === "/api-health") {
          try { return json(await getAdminApiHealth()); }
          catch (e) { return err(String(e), 500); }
        }

        const traceMatch = path.match(/^\/trace\/([^/]+)$/);
        if (traceMatch) {
          try { return json(await getAdminTrace(traceMatch[1])); }
          catch (e) { return err(String(e), 500); }
        }

        if (path === "/rate-limits") {
          try { return json(await getAdminRateLimitStats()); }
          catch (e) { return err(String(e), 500); }
        }

        return err("Not found", 404);
      },
    },
  },
  component: () => null,
});
