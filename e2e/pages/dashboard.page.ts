/**
 * dashboard.page.ts — Page Object Model for the /dashboard route
 */

import type { Page, Locator } from "@playwright/test";

export class DashboardPage {
  readonly page: Page;

  readonly conversationList: Locator;
  readonly statsCards: Locator;
  readonly signOutButton: Locator;
  readonly userMenu: Locator;
  readonly planBadge: Locator;

  constructor(page: Page) {
    this.page = page;
    this.conversationList = page
      .locator("[data-testid=conversation-list], .conversation-list, [role=list]")
      .first();
    this.statsCards = page.locator("[data-testid=stat-card], .stat-card").first();
    this.signOutButton = page.getByRole("button", { name: /sign out|log out/i }).first();
    this.userMenu = page.getByRole("button", { name: /account|profile|user|settings/i }).first();
    this.planBadge = page.locator("[data-testid=plan-badge], .plan-badge").first();
  }

  async goto() {
    await this.page.goto("/dashboard");
    await this.page.waitForLoadState("networkidle");
  }

  async signOut() {
    // Try direct sign-out button first
    if ((await this.signOutButton.count()) > 0) {
      await this.signOutButton.click();
      return;
    }
    // Otherwise open user menu first
    if ((await this.userMenu.count()) > 0) {
      await this.userMenu.click();
      await this.signOutButton.waitFor({ state: "visible", timeout: 3_000 });
      await this.signOutButton.click();
    }
  }

  async waitForLoad(timeout = 10_000) {
    await this.page.waitForLoadState("networkidle", { timeout });
  }

  async isOnDashboard() {
    return this.page.url().includes("/dashboard");
  }
}
