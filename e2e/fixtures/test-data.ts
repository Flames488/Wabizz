/**
 * e2e/fixtures/test-data.ts — Shared test fixtures for E2E tests
 *
 * Provides:
 *   - Test credentials (from env or sensible defaults for local)
 *   - Factory functions for unique campaign/contact names
 *   - Reusable wait helpers
 */

export const TEST_CREDENTIALS = {
  email: process.env.E2E_TEST_EMAIL ?? "e2e-test@wabizz.test",
  password: process.env.E2E_TEST_PASSWORD ?? "e2eTestPass123!",
};

export const INVALID_CREDENTIALS = {
  email: "definitely-not-real@nowhere.invalid",
  password: "wrongpassword999",
};

/** Generate a unique campaign name for each test run to avoid collisions */
export function uniqueCampaignName(prefix = "E2E Campaign") {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Standard E2E message template used in campaign creation tests */
export const SAMPLE_TEMPLATE =
  "Hello {{name}}! This is an automated E2E test message from Wabizz. Reply STOP to unsubscribe.";

/** Timeouts used across specs — centralised so they're easy to tune */
export const TIMEOUTS = {
  navigation: 12_000,
  dialog: 5_000,
  toast: 8_000,
  listUpdate: 10_000,
  pageLoad: 15_000,
} as const;
