import { defineConfig, devices } from "@playwright/test";

/**
 * playwright.config.ts — Wabizz E2E test configuration
 *
 * Tests live in e2e/tests/. Three critical flows are covered:
 *   1. auth.spec.ts      — sign-up, sign-in, sign-out
 *   2. onboarding.spec.ts — business profile setup post-auth
 *   3. campaigns.spec.ts  — create → launch → verify campaign flow
 *
 * Run locally:
 *   bunx playwright test
 *   bunx playwright test --ui           # interactive UI mode
 *   bunx playwright test --headed       # watch the browser
 *
 * Run in CI (headless, single project):
 *   bunx playwright test --project=chromium
 *
 * Environment variables:
 *   BASE_URL          — app URL (default: http://localhost:5173)
 *   E2E_TEST_EMAIL    — test account email (avoid real prod accounts)
 *   E2E_TEST_PASSWORD — test account password
 */

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false, // auth state is shared — keep sequential
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // serial: each test builds on the last (sign-up → onboard → campaign)
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ...(process.env.CI ? [["github"] as [string]] : []),
  ],

  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    // ── Setup: create auth state once, share across tests ──────────────────
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },

    // ── Chromium (primary CI target) ───────────────────────────────────────
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },

    // ── Firefox (optional — run locally, not in CI by default) ────────────
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],

  // Start the dev server automatically when running locally
  webServer: process.env.CI
    ? undefined
    : {
        command: "bun run dev",
        url: "http://localhost:5173",
        reuseExistingServer: true,
        timeout: 30_000,
      },
});
