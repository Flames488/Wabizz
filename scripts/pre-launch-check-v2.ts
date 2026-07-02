#!/usr/bin/env node
/**
 * Backward-compatible entrypoint for the v2 pre-launch command.
 *
 * The active checks live in pre-launch-check.ts. Keeping this file prevents
 * older runbooks and package scripts from breaking while avoiding duplicate,
 * stale environment validation logic.
 */

await import("./pre-launch-check.ts");
