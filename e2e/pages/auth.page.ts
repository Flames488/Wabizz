/**
 * auth.page.ts — Page Object Model for the /auth route
 *
 * Encapsulates all selectors and actions for the authentication page so
 * test specs stay declarative and maintainable.
 */

import type { Page, Locator } from "@playwright/test";

export class AuthPage {
  readonly page: Page;

  // Form elements
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly modeToggle: Locator;

  // Feedback
  readonly errorToast: Locator;
  readonly successToast: Locator;
  readonly loadingSpinner: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i)).first();
    this.passwordInput = page
      .getByLabel(/password/i)
      .or(page.getByPlaceholder(/password/i))
      .first();
    this.submitButton = page
      .getByRole("button", { name: /sign in|sign up|log in|create account/i })
      .first();
    this.modeToggle = page
      .getByRole("button", { name: /sign up|create account|already have an account/i })
      .first();
    this.errorToast = page.locator(
      "[data-sonner-toast][data-type=error], [role=alert][aria-live=assertive]",
    );
    this.successToast = page.locator("[data-sonner-toast][data-type=success]");
    this.loadingSpinner = page.locator("[data-testid=loader], .animate-spin, [aria-label=loading]");
  }

  async goto() {
    await this.page.goto("/auth");
    await this.page.waitForLoadState("networkidle");
  }

  async fillEmail(email: string) {
    await this.emailInput.fill(email);
  }

  async fillPassword(password: string) {
    await this.passwordInput.fill(password);
  }

  async submit() {
    await this.submitButton.click();
  }

  async signIn(email: string, password: string) {
    await this.fillEmail(email);
    await this.fillPassword(password);
    await this.submit();
  }

  async switchToSignUp() {
    const toggle = this.page.getByText(/don't have an account|sign up|create account/i).first();
    if ((await toggle.count()) > 0) await toggle.click();
  }

  async waitForRedirect(pattern: RegExp, timeout = 12_000) {
    await this.page.waitForURL(pattern, { timeout });
  }

  async waitForError(timeout = 8_000) {
    await this.errorToast.first().waitFor({ state: "visible", timeout });
  }
}
