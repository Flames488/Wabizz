/**
 * campaigns.page.ts — Page Object Model for the /campaigns route
 */

import type { Page, Locator } from "@playwright/test";

export class CampaignsPage {
  readonly page: Page;

  readonly heading: Locator;
  readonly newCampaignButton: Locator;
  readonly campaignDialog: Locator;
  readonly campaignNameInput: Locator;
  readonly messageTemplateInput: Locator;
  readonly saveButton: Locator;
  readonly campaignList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page
      .getByRole("heading", { name: /campaigns/i })
      .or(page.getByText(/campaigns/i).first());
    this.newCampaignButton = page
      .getByRole("button", { name: /new campaign|create campaign|\+ campaign|add campaign/i })
      .first();
    this.campaignDialog = page.getByRole("dialog");
    this.campaignNameInput = page
      .getByLabel(/campaign name|name/i)
      .or(page.getByPlaceholder(/campaign name/i))
      .first();
    this.messageTemplateInput = page
      .getByLabel(/message|template/i)
      .or(page.getByRole("textbox", { name: /message/i }))
      .first();
    this.saveButton = page.getByRole("button", { name: /save|create|add campaign/i }).first();
    this.campaignList = page
      .locator("[data-testid=campaign-list], [role=table], .campaign-list")
      .first();
  }

  async goto() {
    await this.page.goto("/campaigns");
    await this.page.waitForLoadState("networkidle");
  }

  async openNewCampaignDialog() {
    await this.newCampaignButton.click();
    await this.campaignDialog.waitFor({ state: "visible", timeout: 5_000 });
  }

  async fillCampaignName(name: string) {
    const input = this.campaignDialog
      .getByLabel(/campaign name|name/i)
      .or(this.campaignDialog.getByPlaceholder(/campaign name/i))
      .first();
    await input.fill(name);
  }

  async fillMessageTemplate(template: string) {
    const input = this.campaignDialog
      .getByLabel(/message|template/i)
      .or(this.campaignDialog.getByRole("textbox", { name: /message/i }))
      .first();
    if ((await input.count()) > 0) await input.fill(template);
  }

  async save() {
    const saveBtn = this.campaignDialog
      .getByRole("button", { name: /save|create|add campaign/i })
      .first();
    await saveBtn.click();
  }

  async createCampaign(name: string, message: string) {
    await this.openNewCampaignDialog();
    await this.fillCampaignName(name);
    await this.fillMessageTemplate(message);
    await this.save();
    // Dialog should close
    await this.campaignDialog.waitFor({ state: "hidden", timeout: 8_000 });
  }

  async findCampaignRow(name: string) {
    return this.page
      .locator("[data-testid=campaign-row], tr, [role=row]")
      .filter({ hasText: name })
      .first();
  }

  async getLaunchButtonForCampaign(campaignName: string) {
    const row = await this.findCampaignRow(campaignName);
    return row
      .getByRole("button", { name: /launch|play|start/i })
      .or(row.locator("button[aria-label*=launch], button[aria-label*=play]"))
      .first();
  }

  async waitForCampaignInList(name: string, timeout = 10_000) {
    await this.page.getByText(name).waitFor({ state: "visible", timeout });
  }
}
