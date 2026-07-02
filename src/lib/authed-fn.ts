import { supabase } from "@/integrations/supabase/client";

/**
 * Wrap a server function call so it sends the current Supabase access token
 * as a Bearer header — required by `requireSupabaseAuth` middleware.
 *
 * Usage:
 *   const fn = useAuthedServerFn(getMyBusiness);
 *   const data = await fn();
 *   const data2 = await fn({ data: { ... } });
 */
type AuthedServerFnArg = { headers?: HeadersInit } & Record<string, unknown>;

export function useAuthedServerFn<F extends (arg?: AuthedServerFnArg) => Promise<unknown>>(fn: F) {
  return (async (arg?: AuthedServerFnArg) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return fn({
      ...(arg ?? {}),
      headers: {
        ...(arg?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  }) as F;
}
