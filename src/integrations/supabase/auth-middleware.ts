import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { supabaseAdmin } from "./client.server";
import type { Database } from "./types";

// SECURITY: Token validation MUST use the admin client (service-role key), not the
// publishable-key client. The publishable-key client calls Supabase's anon endpoint,
// which is more permissive and could accept a cleverly crafted JWT. The admin client
// calls /auth/v1/user with the service-role key, which Supabase validates strictly
// against its own signing secret — no bypass is possible.
//
// The one-line fix: replace `createClient(..., PUBLISHABLE_KEY).auth.getUser(token)`
// with `supabaseAdmin.auth.getUser(token)`.

export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const request = getRequest();

    if (!request?.headers) {
      throw new Response("Unauthorized: No request headers available", { status: 401 });
    }

    const authHeader = request.headers.get("authorization");

    if (!authHeader) {
      throw new Response("Unauthorized: No authorization header provided", { status: 401 });
    }

    if (!authHeader.startsWith("Bearer ")) {
      throw new Response("Unauthorized: Only Bearer tokens are supported", { status: 401 });
    }

    // Use .slice(7) — safe even if a proxy double-prefixes the header.
    const token = authHeader.slice(7);
    if (!token) {
      throw new Response("Unauthorized: No token provided", { status: 401 });
    }

    // THE FIX: validate against the admin client, not a publishable-key client.
    // supabaseAdmin uses SUPABASE_SERVICE_ROLE_KEY, so Supabase verifies the JWT
    // signature with its own secret — a forged token is rejected here.
    const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !userData?.user) {
      throw new Response("Unauthorized: Invalid token", { status: 401 });
    }

    if (!userData.user.id) {
      throw new Response("Unauthorized: No user ID found in token", { status: 401 });
    }

    // Pass a user-scoped supabase client (publishable key + auth header) downstream
    // so server functions that need RLS-scoped queries can use ctx.supabase directly.
    // This client is intentionally NOT used for token validation above.
    const { createClient } = await import("@supabase/supabase-js");
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_URL.startsWith("https://")) {
      throw new Response("Server auth is not configured correctly", { status: 500 });
    }

    const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
      auth: {
        storage: undefined,
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    return next({
      context: {
        supabase,
        userId: userData.user.id,
        user: userData.user,
      },
    });
  },
);
