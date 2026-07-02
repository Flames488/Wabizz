import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/__tests__/setup/route-mock.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      // Include worker entry point so startup validation is measured
      include: [
        "src/lib/server/**/*.ts",
        "src/routes/api.public.*.ts",
        "src/lib/server-logger.ts",
        "src/lib/rate-limiter.ts",
        "src/lib/rate-limiter-do.ts",
        "src/lib/dead-letter-queue.ts",
        "src/lib/queue.ts",
        "src/worker-entry.ts",
      ],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/__tests__/**", "src/**/__mocks__/**"],
      thresholds: {
        // Raised from 80/80/75 → 85/85/80 (target: 85-90%)
        lines: 85,
        functions: 85,
        branches: 80,
        // Per-file floor — prevents a single well-tested file from masking
        // an untested one that drags the aggregate above threshold
        perFile: {
          lines: 60,
          functions: 60,
          branches: 55,
        },
      },
      // Watermarks: colour code coverage in the HTML report
      watermarks: {
        lines: [70, 85],
        functions: [70, 85],
        branches: [65, 80],
        statements: [70, 85],
      },
    },
    // Increase timeout for integration-style tests that call external stubs
    testTimeout: 15000,
    hookTimeout: 10000,
    // Retry flaky tests once before failing (useful for timing-sensitive tests)
    retry: 1,
    // Parallel execution with bounded concurrency (avoids port conflicts)
    pool: "threads",
    poolOptions: {
      threads: {
        maxThreads: 4,
        minThreads: 1,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
