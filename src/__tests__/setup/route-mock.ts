// src/__tests__/setup/route-mock.ts
// Stubs out TanStack Start's createFileRoute so route modules can be
// imported in a plain Node/Vitest environment without the full framework.
import { vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: () => null,
  useNavigate: () => () => {},
  useRouter: () => ({}),
}));

// NOTE: route modules (e.g. api.public.twilio-webhook.ts) `import
// "@/lib/server-init"` for its side effects, which validates required env
// vars at module-load time and calls process.exit(1)/throws if any are
// missing. Don't "fix" that here by stubbing in fake-but-present secrets —
// that was tried and made things worse: with the env vars present but
// pointing nowhere real, supabaseAdmin-backed code (e.g. getNicheConfigs)
// stops failing fast and instead tries real network calls against a fake
// host, turning instant synchronous failures into ~7s per-test timeouts
// across the whole suite. The actual fix is for tests to import pure
// helpers (e.g. verifyTwilioSignature) from their real, non-side-effecting
// module instead of through a route file — see security.test.ts.
