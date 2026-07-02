/**
 * /admin/api/* — Splat catch-all for Admin REST API sub-paths
 *
 * TanStack Start's `server: { handlers }` only fires on an exact route match.
 * Requests to /admin/api/login, /admin/api/metrics, etc. do NOT match the
 * /admin/api route — they need their own route entry.
 *
 * This splat route ($) catches all /admin/api/* paths and delegates to the
 * same handler logic so login, metrics, queue, logs, etc. all work.
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

export const Route = createFileRoute("/admin/api/$")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSeeded();
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/admin\/api/, "");

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
        const path = url.pathname.replace(/^\/admin\/api/, "");

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
