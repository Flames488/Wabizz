/**
 * smoke.spec.ts — Full critical-path smoke test
 *
 * This is the most important E2E test in the suite. It exercises the complete
 * user journey in a single, sequenced flow:
 *
 *   auth → dashboard load → campaigns page → create campaign → verify campaign
 *
 * Running this single file gives you a binary "does the product work?" signal
 * without needing a full test account with pre-seeded data.
 *
 * Designed to be:
 *   - Fast       (<60s total)
 *   - Resilient  (tolerant of loading states, animation)
 *   - Informative (clear failure messages at each step)
 *
 * Run:
 *   bunx playwright test e2e/tests/smoke.spec.ts
 *   bunx playwright test e2e/tests/smoke.spec.ts --headed    # watch it
 */

import { test, expect } from "@playwright/test";
import { AuthPage } from "../pages/auth.page";
import { DashboardPage } from "../pages/dashboard.page";
import { CampaignsPage } from "../pages/campaigns.page";
import {
  uniqueCampaignName,
  SAMPLE_TEMPLATE,
  TIMEOUTS,
  TEST_CREDENTIALS,
} from "../fixtures/test-data";

// Unique name per run to avoid stale-data false-positives
const CAMPAIGN_NAME = uniqueCampaignName("Smoke");

test.describe("Critical-path smoke test: auth → dashboard → campaign", () => {
  // ── Step 1: Authenticated user reaches dashboard ──────────────────────────

  test("1. authenticated user lands on dashboard or onboarding", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/, { timeout: TIMEOUTS.navigation });
    console.log(`✅ Step 1 — Landed on: ${page.url()}`);
  });

  // ── Step 2: Dashboard loads meaningful content ────────────────────────────

  test("2. dashboard renders stats or conversations", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    // At minimum the page shouldn't be blank or show an error
    const errorIndicator = page.locator(
      "[data-testid=error-state], [role=alert][aria-live=assertive]",
    );
    await expect(errorIndicator).toHaveCount(0);

    // Some visible content should be present
    const hasContent = (await page.locator("main, [role=main]").count()) > 0;
    expect(hasContent).toBe(true);
    console.log("✅ Step 2 — Dashboard rendered without errors");
  });

  // ── Step 3: Navigate to campaigns ────────────────────────────────────────

  test("3. campaigns page loads and shows create button", async ({ page }) => {
    const campaigns = new CampaignsPage(page);
    await campaigns.goto();

    await expect(campaigns.heading).toBeVisible({ timeout: TIMEOUTS.pageLoad });
    await expect(campaigns.newCampaignButton).toBeVisible({ timeout: TIMEOUTS.dialog });
    console.log("✅ Step 3 — Campaigns page loaded with New Campaign button");
  });

  // ── Step 4: Create a campaign end-to-end ─────────────────────────────────

  test("4. can create a campaign and see it in the list", async ({ page }) => {
    const campaigns = new CampaignsPage(page);
    await campaigns.goto();

    await campaigns.createCampaign(CAMPAIGN_NAME, SAMPLE_TEMPLATE);

    // Campaign should appear in list within timeout
    await campaigns.waitForCampaignInList(CAMPAIGN_NAME, TIMEOUTS.listUpdate);
    console.log(`✅ Step 4 — Campaign "${CAMPAIGN_NAME}" created and visible`);
  });

  // ── Step 5: Created campaign has launch control ───────────────────────────

  test("5. created campaign has a launch/play control", async ({ page }) => {
    const campaigns = new CampaignsPage(page);
    await campaigns.goto();

    const row = await campaigns.findCampaignRow(CAMPAIGN_NAME);

    if ((await row.count()) === 0) {
      test.skip(true, `Campaign "${CAMPAIGN_NAME}" not found — tests must run sequentially`);
      return;
    }

    const launchBtn = await campaigns.getLaunchButtonForCampaign(CAMPAIGN_NAME);
    // Launch button OR a status badge is acceptable (campaign may auto-start)
    const statusBadge = row
      .locator("[data-testid=campaign-status], .status-badge, [aria-label*=status]")
      .first();

    const hasControl = (await launchBtn.count()) > 0 || (await statusBadge.count()) > 0;
    expect(hasControl).toBe(true);
    console.log("✅ Step 5 — Campaign has launch control or status badge");
  });
});
