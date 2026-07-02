/**
 * auth.spec.ts — Authentication flow E2E tests
 *
 * Covers:
 *   - Unauthenticated redirect to /auth
 *   - Sign-in with valid credentials → dashboard/onboarding
 *   - Sign-in with bad credentials → visible error
 *   - Sign-out → redirected to /auth
 */

import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_TEST_EMAIL ?? "e2e-test@wabizz.test";
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? "e2eTestPass123!";

test.describe("Auth flow", () => {
  test("unauthenticated user is redirected to /auth from /dashboard", async ({ browser }) => {
    // Use a fresh context with no stored auth
    const ctx = await browser.newContext({ storageState: undefined });
    const page = await ctx.newPage();

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth/);
    await ctx.close();
  });

  test("shows error for invalid credentials", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: undefined });
    const page = await ctx.newPage();

    await page.goto("/auth");
    await page.getByLabel(/email/i).fill("notreal@example.com");
    await page.getByLabel(/password/i).fill("wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Expect an error toast or inline error message
    const error = page.locator("[data-sonner-toast][data-type=error], [role=alert]");
    await expect(error.first()).toBeVisible({ timeout: 8_000 });

    await ctx.close();
  });

  test("signed-in user lands on dashboard or onboarding", async ({ page }) => {
    // page already has storageState from auth.setup.ts
    await page.goto("/");
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
  });

  test("sign-out redirects to /auth", async ({ page }) => {
    await page.goto("/dashboard");

    // Click user menu / sign-out button — selector may vary; try common patterns
    const signOutButton = page.getByRole("button", { name: /sign out|log out/i });
    if ((await signOutButton.count()) === 0) {
      // Try opening a dropdown first
      const userMenu = page.getByRole("button", { name: /account|profile|settings/i }).first();
      if ((await userMenu.count()) > 0) {
        await userMenu.click();
      }
    }

    await signOutButton.click();
    await expect(page).toHaveURL(/\/auth/, { timeout: 8_000 });
  });
});
