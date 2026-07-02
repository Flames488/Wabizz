/**
 * logging.test.ts
 *
 * Validates that:
 *   - No raw console.warn/console.error calls exist in server-side source files
 *   - All server-side logs go through logError (or the two documented intentional exceptions)
 *   - logError always accepts and forwards request_id
 *   - Log payloads are structured (object, not string)
 *   - request_id is included in error context when provided
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Filesystem audit ──────────────────────────────────────────────────────────

const SRC_ROOT = path.resolve(__dirname, "../../");

/**
 * Recursively collect all .ts files under a directory,
 * excluding test files and node_modules.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Server-side files: routes/api.* and lib/server* and lib/rate-limiter.ts
 */
function isServerFile(filePath: string): boolean {
  const rel = path.relative(SRC_ROOT, filePath);
  return (
    rel.startsWith("routes/api.") || rel.startsWith("lib/server") || rel === "lib/rate-limiter.ts"
  );
}

describe("No raw console.warn / console.error in server-side source", () => {
  const serverFiles = collectSourceFiles(SRC_ROOT).filter(isServerFile);

  // Three intentional exceptions are documented:
  //   1. server-logger.ts itself (IS the logging implementation)
  //   2. rate-limiter.ts (pre-request context, no supabaseAdmin available)
  //   3. server-init.ts (startup bootstrap — warns about missing optional env vars
  //      and KV bindings before the logger is available; intentional by design)
  const INTENTIONAL_EXCEPTIONS = new Set([
    path.join(SRC_ROOT, "lib/server-logger.ts"),
    path.join(SRC_ROOT, "lib/rate-limiter.ts"),
    path.join(SRC_ROOT, "lib/server-init.ts"),
  ]);

  for (const file of serverFiles) {
    if (INTENTIONAL_EXCEPTIONS.has(file)) continue;

    it(`${path.relative(SRC_ROOT, file)} has no raw console.warn or console.error`, () => {
      const content = fs.readFileSync(file, "utf-8");
      const matches = content.match(/console\.(warn|error)\s*\(/g);
      expect(matches, `Found raw console calls in ${file}: ${matches?.join(", ")}`).toBeNull();
    });
  }

  it("server-logger.ts only uses console.error (never console.warn)", () => {
    const content = fs.readFileSync(path.join(SRC_ROOT, "lib/server-logger.ts"), "utf-8");
    expect(content).not.toContain("console.warn");
    expect(content).toContain("console.error"); // intentional use
  });
});

// ── logError unit behaviour ───────────────────────────────────────────────────

// We test the real logError implementation with a mocked supabaseAdmin
vi.mock("../../integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  },
}));

import { logError } from "../../lib/server-logger";
import { supabaseAdmin } from "../../integrations/supabase/client.server";

describe("logError", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("calls console.error with structured JSON output", async () => {
    await logError("test-source", "something failed", { key: "value" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const [jsonStr] = consoleSpy.mock.calls[0];
    const parsed = JSON.parse(jsonStr);
    expect(parsed.source).toBe("test-source");
    expect(parsed.message).toBe("something failed");
    expect(parsed.level).toBe("error");
    expect(parsed.key).toBe("value");
  });

  it("includes request_id in the structured JSON log", async () => {
    await logError("src", "msg", {}, "req-abc");
    const [jsonStr] = consoleSpy.mock.calls[0];
    const parsed = JSON.parse(jsonStr);
    expect(parsed.request_id).toBe("req-abc");
  });

  it("includes request_id in the persisted context object", async () => {
    const fromMock = vi.mocked(supabaseAdmin.from);
    await logError("src", "msg", { extra: "data" }, "req-xyz");

    expect(fromMock).toHaveBeenCalledWith("error_logs");
    const insertMock = fromMock.mock.results[0].value.insert;
    const insertedRow = vi.mocked(insertMock).mock.calls[0][0] as Record<string, unknown>;
    expect((insertedRow.context as Record<string, unknown>).request_id).toBe("req-xyz");
    expect((insertedRow.context as Record<string, unknown>).extra).toBe("data");
  });

  it("omits request_id from context when not provided", async () => {
    const fromMock = vi.mocked(supabaseAdmin.from);
    await logError("src", "msg", { only: "this" });

    const insertMock = fromMock.mock.results[0].value.insert;
    const insertedRow = vi.mocked(insertMock).mock.calls[0][0] as Record<string, unknown>;
    expect((insertedRow.context as Record<string, unknown>).request_id).toBeUndefined();
  });

  it("never throws even if DB insert fails", async () => {
    const fromMock = vi.mocked(supabaseAdmin.from);
    fromMock.mockReturnValueOnce({
      insert: vi.fn().mockRejectedValue(new Error("DB down")),
    } as ReturnType<typeof supabaseAdmin.from>);

    // Should not throw
    await expect(logError("src", "msg", {})).resolves.toBeUndefined();
    // stdout fallback should fire twice: once for the original error, once for the DB failure
    expect(consoleSpy).toHaveBeenCalledTimes(2);
  });

  it("persists correct fields to error_logs table", async () => {
    const fromMock = vi.mocked(supabaseAdmin.from);
    await logError("payment", "init failed", { ref: "abc123" }, "req-001");

    const insertMock = fromMock.mock.results[0].value.insert;
    const row = vi.mocked(insertMock).mock.calls[0][0] as Record<string, unknown>;
    expect(row.source).toBe("payment");
    expect(row.message).toBe("init failed");
    expect(row.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
