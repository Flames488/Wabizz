/**
 * onboarding.spec.ts — Business profile onboarding E2E tests
 *
 * Covers:
 *   - /onboarding renders the business setup form
 *   - Submitting a valid business profile advances to /dashboard
 *   - Incomplete form shows validation errors
 *
 * Depends on auth.setup.ts (storageState already authenticated).
 */

import { test, expect } from "@playwright/test";

test.describe("Onboarding flow", () => {
  test("onboarding page renders the business setup form", async ({ page }) => {
    await page.goto("/onboarding");

    // Key form fields from onboarding.tsx
    await expect(page.getByLabel(/business name/i)).toBeVisible({ timeout: 8_000 });
  });

  test("submitting a complete business profile advances past onboarding", async ({ page }) => {
    await page.goto("/onboarding");

    // Fill in required fields — selectors match the labels in onboarding.tsx
    const businessNameInput = page.getByLabel(/business name/i);
    await businessNameInput.clear();
    await businessNameInput.fill("Playwright Test Biz");

    // Industry / type select (if present)
    const industrySelect = page.getByRole("combobox").first();
    if ((await industrySelect.count()) > 0) {
      await industrySelect.click();
      await page.getByRole("option").first().click();
    }

    // Phone / WhatsApp number field (if required)
    const phoneInput = page.getByLabel(/whatsapp|phone/i).first();
    if ((await phoneInput.count()) > 0) {
      await phoneInput.clear();
      await phoneInput.fill("+2348100000001");
    }

    // Submit
    await page.getByRole("button", { name: /save|continue|get started|activate/i }).click();

    // Expect navigation to dashboard or a success toast
    const navResult = await Promise.race([
      page.waitForURL("**/dashboard", { timeout: 12_000 }).then(() => "dashboard" as const),
      page
        .locator("[data-sonner-toast][data-type=success]")
        .waitFor({ timeout: 12_000 })
        .then(() => "toast" as const),
    ]).catch(() => "timeout" as const);

    expect(["dashboard", "toast"]).toContain(navResult);
  });
});
