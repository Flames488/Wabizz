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
