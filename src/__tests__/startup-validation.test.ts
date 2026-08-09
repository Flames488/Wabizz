/**
 * startup-validation.test.ts
 *
 * Tests for the worker-entry.ts startup validation logic.
 * Covers: env var presence, placeholder detection, Supabase project URL check.
 *
 * These tests protect against regressions in the critical boot-time guard
 * that prevents the worker from serving traffic when secrets are unconfigured.
 */

import { describe, it, expect } from "vitest";
import { validateStartupSecrets, isPlaceholder, REQUIRED_SECRETS } from "../worker-entry";

// ── isPlaceholder ─────────────────────────────────────────────────────────────

describe("isPlaceholder()", () => {
  it("detects REPLACE_ME values", () => {
    expect(isPlaceholder("REPLACE_ME")).toBe(true);
  });

  it("detects REPLACE_WITH_ prefix variants", () => {
    expect(isPlaceholder("REPLACE_WITH_SUPABASE_URL")).toBe(true);
  });

  it("detects REPLACE_AT_ prefix variants", () => {
    expect(isPlaceholder("REPLACE_AT_DEPLOY_TIME")).toBe(true);
  });

  it("detects your- prefix", () => {
    expect(isPlaceholder("your-project-ref")).toBe(true);
  });

  it("detects <your> style placeholders", () => {
    expect(isPlaceholder("<your-api-key>")).toBe(true);
  });

  it("does NOT flag a real Supabase URL as placeholder", () => {
    expect(isPlaceholder("https://abc123.supabase.co")).toBe(false);
  });

  it("does NOT flag a real Groq key as placeholder", () => {
    expect(isPlaceholder("gsk_realkey123456")).toBe(false);
  });

  it("does NOT flag a real JWT as placeholder", () => {
    expect(isPlaceholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.abc")).toBe(
      false,
    );
  });
});

// ── validateStartupSecrets ────────────────────────────────────────────────────

const VALID_ENV: Record<string, string> = {
  SUPABASE_URL: "https://ref123.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.realkey",
  SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.realanon",
  GROQ_API_KEY: "gsk_realgroqkey",
  TWILIO_ACCOUNT_SID: "AC1234567890abcdef1234567890abcdef",
  TWILIO_AUTH_TOKEN: "abc123_real_twilio_auth_token",
  TWILIO_API_KEY_SID: "SK_test_fixture_not_a_real_key",
  TWILIO_API_KEY_SECRET: "real_twilio_api_key_secret",
  TWILIO_PHONE_NUMBER: "whatsapp:+14155238886",
  WABIZZ_PAYSTACK_SECRET_KEY: "sk_live_realpaystack123456",
  WABIZZ_PAYSTACK_PUBLIC_KEY: "pk_live_realpaystack123456",
  CRON_SECRET: "a".repeat(64),
  ADMIN_JWT_SECRET: "b".repeat(128),
};

describe("validateStartupSecrets()", () => {
  it("returns null when all required secrets are properly set", () => {
    expect(validateStartupSecrets(VALID_ENV)).toBeNull();
  });

  it("reports MISSING when a required key is absent", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string>).GROQ_API_KEY;
    const result = validateStartupSecrets(env);
    expect(result).not.toBeNull();
    expect(result).toContain("GROQ_API_KEY");
    expect(result).toContain("MISSING");
  });

  it("reports MISSING when a required key is empty string", () => {
    const env = { ...VALID_ENV, TWILIO_AUTH_TOKEN: "" };
    const result = validateStartupSecrets(env);
    expect(result).toContain("TWILIO_AUTH_TOKEN");
    expect(result).toContain("MISSING");
  });

  it("reports PLACEHOLDER when a value is REPLACE_ME", () => {
    const env = { ...VALID_ENV, GROQ_API_KEY: "REPLACE_ME" };
    const result = validateStartupSecrets(env);
    expect(result).not.toBeNull();
    expect(result).toContain("GROQ_API_KEY");
    expect(result).toContain("PLACEHOLDER");
  });

  it("reports PLACEHOLDER for REPLACE_WITH_SUPABASE_URL variant", () => {
    const env = { ...VALID_ENV, SUPABASE_URL: "REPLACE_WITH_SUPABASE_URL" };
    const result = validateStartupSecrets(env);
    expect(result).toContain("SUPABASE_URL");
    expect(result).toContain("PLACEHOLDER");
  });

  it("reports URL error when SUPABASE_URL is a PostgreSQL connection string", () => {
    const env = {
      ...VALID_ENV,
      SUPABASE_URL: "postgresql://postgres.ref@db.supabase.co:5432/postgres",
    };
    const result = validateStartupSecrets(env);
    expect(result).toContain("SUPABASE_URL");
    expect(result).toContain("HTTPS");
  });

  it("accepts a valid Supabase HTTPS project URL", () => {
    const env = {
      ...VALID_ENV,
      SUPABASE_URL: "https://ref123.supabase.co",
    };
    expect(validateStartupSecrets(env)).toBeNull();
  });

  it("reports multiple issues at once", () => {
    const env = {
      ...VALID_ENV,
      GROQ_API_KEY: "REPLACE_ME",
      CRON_SECRET: "",
      ADMIN_JWT_SECRET: "your-admin-secret",
    };
    const result = validateStartupSecrets(env);
    expect(result).toContain("GROQ_API_KEY");
    expect(result).toContain("CRON_SECRET");
    expect(result).toContain("ADMIN_JWT_SECRET");
    // Should show both MISSING and PLACEHOLDER sections
    expect(result).toContain("MISSING");
    expect(result).toContain("PLACEHOLDER");
  });

  it("includes wrangler secret put instructions in error output", () => {
    const env = { ...VALID_ENV, GROQ_API_KEY: "REPLACE_ME" };
    const result = validateStartupSecrets(env);
    expect(result).toContain("wrangler secret put");
  });

  it("covers all REQUIRED_SECRETS keys", () => {
    // Ensure every key listed in REQUIRED_SECRETS is actually checked
    for (const { key } of REQUIRED_SECRETS) {
      const env = { ...VALID_ENV };
      delete (env as Record<string, string>)[key];
      const result = validateStartupSecrets(env);
      expect(result, `Expected ${key} to be flagged when missing`).toContain(key);
    }
  });
});

// ── REQUIRED_SECRETS registry ─────────────────────────────────────────────────

describe("REQUIRED_SECRETS registry", () => {
  it("has at least 8 entries covering all critical external services", () => {
    expect(REQUIRED_SECRETS.length).toBeGreaterThanOrEqual(8);
  });

  it("includes SUPABASE_URL", () => {
    expect(REQUIRED_SECRETS.some((s) => s.key === "SUPABASE_URL")).toBe(true);
  });

  it("includes GROQ_API_KEY", () => {
    expect(REQUIRED_SECRETS.some((s) => s.key === "GROQ_API_KEY")).toBe(true);
  });

  it("includes TWILIO_ACCOUNT_SID", () => {
    expect(REQUIRED_SECRETS.some((s) => s.key === "TWILIO_ACCOUNT_SID")).toBe(true);
  });

  it("includes payment provider key", () => {
    expect(
      REQUIRED_SECRETS.some((s) => s.key.includes("PAYSTACK") || s.key.includes("STRIPE")),
    ).toBe(true);
  });

  it("every entry has a non-empty hint", () => {
    for (const { key, hint } of REQUIRED_SECRETS) {
      expect(hint, `${key} must have a hint`).toBeTruthy();
      expect(hint.length).toBeGreaterThan(10);
    }
  });
});
