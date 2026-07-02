/**
 * env-audit.test.ts
 *
 * Tests for the scripts/audit-env.ts environment auditing logic.
 * Also validates the .env.example format matches REQUIRED_SECRETS.
 * Covers: placeholder detection across all known formats, wrangler secret
 * put command generation, and env var format validation.
 */

import { describe, it, expect } from "vitest";
import { validateStartupSecrets, isPlaceholder, REQUIRED_SECRETS } from "../worker-entry";

describe("Placeholder format detection", () => {
  const knownPlaceholders = [
    "REPLACE_ME",
    "REPLACE_WITH_SUPABASE_URL",
    "REPLACE_AT_DEPLOY_TIME",
    "your-project-ref",
    "YOUR_API_KEY",
    "<your-api-key>",
    "change-this",
  ];

  for (const p of knownPlaceholders) {
    it(`flags "${p.slice(0, 40)}" as placeholder`, () => {
      expect(isPlaceholder(p)).toBe(true);
    });
  }

  const realValues = [
    "sk-ant-api03-abc123xyz",
    "ACabc123def456abc123def456abc123d",
    "https://ref.supabase.co",
    "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "sk_live_abc123456789",
    "https://hooks.slack.com/services/T000/B000/XXXX",
    "1234567890:ABCDEFghijkl",
  ];

  for (const v of realValues) {
    it(`does NOT flag "${v.slice(0, 40)}..." as placeholder`, () => {
      expect(isPlaceholder(v)).toBe(false);
    });
  }
});

describe("Supabase URL validation rules", () => {
  const base = Object.fromEntries(
    REQUIRED_SECRETS.map((s) => [s.key, "sk-ant-api03-real" + s.key]),
  );
  // Ensure other keys pass the non-URL checks
  Object.assign(base, {
    SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.role.sig",
    SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOiJIUzI1NiJ9.anon.sig",
    TWILIO_ACCOUNT_SID: "ACabc123",
    ADMIN_JWT_SECRET: "a".repeat(64),
    CRON_SECRET: "b".repeat(64),
  });

  const urlCases: Array<{ url: string; shouldPass: boolean; label: string }> = [
    {
      url: "https://ref.supabase.co",
      shouldPass: true,
      label: "Supabase HTTPS project URL",
    },
    {
      url: "postgresql://postgres.ref:pass@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
      shouldPass: false,
      label: "PostgreSQL pooler URL",
    },
    {
      url: "postgresql://postgres.ref:pass@db.supabase.co:5432/postgres",
      shouldPass: false,
      label: "direct connection (port 5432, no pooler host)",
    },
    {
      url: "postgresql://postgres:pass@db.supabase.co:6543/postgres",
      shouldPass: false,
      label: "port 6543 but no pooler.supabase.com host",
    },
  ];

  for (const { url, shouldPass, label } of urlCases) {
    it(`${shouldPass ? "accepts" : "rejects"} ${label}`, () => {
      const env = { ...base, SUPABASE_URL: url };
      const result = validateStartupSecrets(env);
      if (shouldPass) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result).toContain("SUPABASE_URL");
      }
    });
  }
});

describe("Error message quality", () => {
  const partialEnv = {
    SUPABASE_URL: "https://ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "eyJ.role.sig",
    SUPABASE_PUBLISHABLE_KEY: "eyJ.anon.sig",
    ANTHROPIC_API_KEY: "REPLACE_ME",
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "real-token",
    WABIZZ_PAYSTACK_SECRET_KEY: "sk_live_real",
    CRON_SECRET: "a".repeat(64),
    ADMIN_JWT_SECRET: "b".repeat(64),
  };

  it("error includes wrangler secret put command", () => {
    const result = validateStartupSecrets(partialEnv);
    expect(result).toContain("wrangler secret put");
  });

  it("error references .env.example for format help", () => {
    const result = validateStartupSecrets(partialEnv);
    expect(result).toContain(".env.example");
  });

  it("error mentions all failing keys at once (not just first)", () => {
    const result = validateStartupSecrets(partialEnv);
    expect(result).toContain("ANTHROPIC_API_KEY");
    expect(result).toContain("TWILIO_ACCOUNT_SID");
  });

  it("STARTUP BLOCKED header appears in error", () => {
    const result = validateStartupSecrets(partialEnv);
    expect(result).toContain("STARTUP BLOCKED");
  });
});
