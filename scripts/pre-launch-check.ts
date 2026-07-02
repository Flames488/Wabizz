#!/usr/bin/env node
/**
 * Pre-launch checklist runner.
 *
 * Checks the highest-risk deploy prerequisites that can be verified from the
 * repository without live credentials.
 *
 * Flags:
 *   --local   Skip the KV placeholder check (safe for `wrangler dev --local`)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? process.cwd(), "..");
const isLocal = process.argv.includes("--local");

interface CheckResult {
  name: string;
  passed: boolean;
  critical: boolean;
  message: string;
  fix?: string;
}

const results: CheckResult[] = [];

function check(
  name: string,
  critical: boolean,
  fn: () => { passed: boolean; message: string; fix?: string },
) {
  try {
    results.push({ name, critical, ...fn() });
  } catch (error) {
    results.push({ name, critical, passed: false, message: `Check threw: ${String(error)}` });
  }
}

check("SUPABASE_URL uses HTTPS project URL", true, () => {
  const envExamplePath = join(ROOT, ".env.example");
  if (!existsSync(envExamplePath)) {
    return { passed: false, message: ".env.example not found" };
  }

  const envExample = readFileSync(envExamplePath, "utf8");
  const urlLine = envExample.split("\n").find((line) => line.startsWith("SUPABASE_URL="));
  if (!urlLine) {
    return { passed: false, message: "SUPABASE_URL is missing from .env.example" };
  }

  if (!urlLine.includes("https://")) {
    return {
      passed: false,
      message: "SUPABASE_URL must be the Supabase HTTPS project URL",
      fix: "Use https://[project-ref].supabase.co. Put PostgreSQL URLs in SUPABASE_DB_URL only.",
    };
  }

  return { passed: true, message: "SUPABASE_URL documentation uses HTTPS project URL" };
});

check("Migrations 023 and 024 are present", true, () => {
  const migrationsDir = join(ROOT, "supabase", "migrations");
  if (!existsSync(migrationsDir)) {
    return {
      passed: false,
      message: `supabase/migrations directory not found at ${migrationsDir}`,
    };
  }

  const files = readdirSync(migrationsDir);
  const has023 = files.some((file) => file.includes("023"));
  const has024 = files.some((file) => file.includes("024"));

  if (!has023 || !has024) {
    return {
      passed: false,
      message: `Missing migration(s): ${!has023 ? "023 " : ""}${!has024 ? "024" : ""}`.trim(),
      fix: "Run Supabase migrations before deploying.",
    };
  }

  return { passed: true, message: "Required migrations are present" };
});

check("Load test assets exist", false, () => {
  const required = [
    "load-tests/k6-webhook.js",
    "load-tests/k6-advanced.js",
    "load-tests/artillery-config.yml",
    "load-tests/artillery-smoke.yml",
  ];
  const missing = required.filter((file) => !existsSync(join(ROOT, file)));

  if (missing.length > 0) {
    return { passed: false, message: `Missing load test assets: ${missing.join(", ")}` };
  }

  return { passed: true, message: "Load test assets are present" };
});

check(
  isLocal
    ? "Wrangler KV placeholder check (SKIPPED — --local flag)"
    : "Wrangler config has no obvious placeholders",
  true,
  () => {
    if (isLocal) {
      return {
        passed: true,
        message:
          "Skipped for local dev — zero-ID KV sentinels are expected when running wrangler dev --local",
      };
    }

    const wranglerPath = join(ROOT, "wrangler.jsonc");
    if (!existsSync(wranglerPath)) {
      return { passed: false, message: "wrangler.jsonc not found" };
    }

    const wrangler = readFileSync(wranglerPath, "utf8");
    const placeholderPatterns = [
      "REPLACE_ME",
      "your-",
      "change-this",
      "00000000000000000000000000000000",
    ];
    const found = placeholderPatterns.filter((pattern) => wrangler.includes(pattern));

    if (found.length > 0) {
      return {
        passed: false,
        message: `wrangler.jsonc contains placeholder values: ${found.join(", ")}`,
        fix: "Run: wrangler kv namespace create RATE_LIMIT_KV && wrangler kv namespace create CACHE_KV (plus --preview variants). Paste the printed IDs into wrangler.jsonc before deploying. See CLOUDFLARE_KV_SETUP.md.",
      };
    }

    return { passed: true, message: "No obvious Wrangler placeholders found" };
  },
);

check("ADMIN_JWT_SECRET is set", true, () => {
  // Check .env.local or .env if present
  const envPaths = [join(ROOT, ".env.local"), join(ROOT, ".env")];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      const line = content.split("\n").find((l) => l.startsWith("ADMIN_JWT_SECRET="));
      if (line) {
        const val = line.split("=").slice(1).join("=").trim();
        if (val && val.length >= 32) {
          return { passed: true, message: `ADMIN_JWT_SECRET is set (${val.length} chars)` };
        }
        return {
          passed: false,
          message: "ADMIN_JWT_SECRET is set but too short (minimum 32 chars, recommend 64)",
          fix: "Generate with: openssl rand -hex 32",
        };
      }
    }
  }
  // If no .env files exist, skip (CI/CD — secrets set via wrangler secret put)
  return {
    passed: true,
    message: "No local .env file found — assuming secrets set via wrangler secret put",
  };
});

let failures = 0;
let criticalFailures = 0;

if (isLocal) {
  console.log("ℹ️  Running in --local mode: KV placeholder check is skipped.\n");
}

for (const result of results) {
  const status = result.passed ? "✅ PASS" : result.critical ? "❌ FAIL" : "⚠️  WARN";
  console.log(`[${status}] ${result.name}: ${result.message}`);
  if (result.fix && !result.passed) console.log(`       Fix: ${result.fix}`);
  if (!result.passed) failures++;
  if (!result.passed && result.critical) criticalFailures++;
}

console.log(`\nSummary: ${results.length - failures}/${results.length} checks passed.`);
if (criticalFailures > 0) {
  console.error("\n🚫 Critical failures detected. Fix the above before deploying.");
  process.exit(1);
} else if (failures > 0) {
  console.warn("\n⚠️  Warnings present, but no critical blockers.");
}
