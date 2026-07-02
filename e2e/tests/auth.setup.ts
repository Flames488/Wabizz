/**
 * auth.setup.ts — One-time auth setup
 *
 * Signs up (or signs in if the account already exists) and saves the
 * authentication cookies/localStorage to e2e/.auth/user.json.
 * All E2E test projects depend on this — they share the saved state so
 * sign-in is not repeated in every test file.
 *
 * Runs automatically before chromium/firefox projects via Playwright
 * project dependencies (see playwright.config.ts).
 */

import { test as setup, expect } from "@playwright/test";
import path from "path";

const AUTH_FILE = path.join(import.meta.dirname ?? process.cwd(), "../.auth/user.json");

const EMAIL = process.env.E2E_TEST_EMAIL ?? "e2e-test@wabizz.test";
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? "e2eTestPass123!";

setup("authenticate", async ({ page }) => {
  await page.goto("/auth");

  // ── Try sign-in first; fall back to sign-up ─────────────────────────────
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);

  // Click Sign in
  await page.getByRole("button", { name: /sign in/i }).click();

  // If the server returns an auth error, try creating the account
  const errorToast = page.locator("[data-sonner-toast][data-type=error]");
  const dashboardNav = page.getByRole("navigation");

  const result = await Promise.race([
    errorToast.waitFor({ timeout: 5_000 }).then(() => "error" as const),
    dashboardNav.waitFor({ timeout: 8_000 }).then(() => "dashboard" as const),
    page.waitForURL("**/dashboard", { timeout: 8_000 }).then(() => "dashboard" as const),
    page.waitForURL("**/onboarding", { timeout: 8_000 }).then(() => "onboarding" as const),
  ]).catch(() => "error" as const);

  if (result === "error") {
    // Account may not exist — sign up
    await page.getByRole("button", { name: /create account|sign up/i }).click();
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /sign up|create/i }).click();

    // After sign-up we land on /onboarding or /dashboard
    await page.waitForURL(/\/(onboarding|dashboard)/, { timeout: 15_000 });
  }

  // Save auth state
  await page.context().storageState({ path: AUTH_FILE });
});
