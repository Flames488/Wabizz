# Wabizz Backup Strategy

## Overview

Three layers of backup protection, from simplest to most robust:

| Layer                     | What                   | Frequency                 | Retention                     | Effort             |
| ------------------------- | ---------------------- | ------------------------- | ----------------------------- | ------------------ |
| 1. Supabase built-in      | Full project + storage | Daily (auto)              | 7 days (free) / 30 days (Pro) | Zero — just enable |
| 2. `backup-supabase.sh`   | Postgres-only dump     | Daily (cron)              | 7 days locally + offsite      | 30 min setup       |
| 3. Point-in-Time Recovery | Any moment in the past | Continuous (Supabase Pro) | 7 days                        | Upgrade plan       |

**Minimum viable before launch:** Layer 1 (Supabase built-in) + Layer 2 (daily script).

---

## Layer 1 — Supabase Built-in Backups (Zero effort)

Supabase automatically backs up your database daily.

**Enable and verify:**

1. Go to your Supabase project → **Settings → Backups**
2. Confirm "Daily backups" shows a green status
3. On the free plan you get 7 days. On Pro you get 30 days + PITR

**To restore from Supabase dashboard:**

1. Settings → Backups → pick a date → "Restore to this backup"
2. Wait ~5–15 minutes for restoration to complete

This is your first line of defence. It requires no maintenance.

---

## Layer 2 — Automated pg_dump Script

The script `scripts/backup-supabase.sh` runs `pg_dump` in custom format,
verifies the output is non-empty and readable, prunes old backups, and
optionally uploads to S3 or Cloudflare R2.

### Setup

**1. Install on your VPS/server:**

```bash
# Set required environment variable (add to /etc/environment)
SUPABASE_DB_URL="postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres"

# Optional — offsite upload to Cloudflare R2
BACKUP_BUCKET="wabizz-backups"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
AWS_ENDPOINT_URL="https://[account-id].r2.cloudflarestorage.com"
```

Get the direct DB URL from: Supabase → Settings → Database → Connection string.
Use **port 5432** (direct, not pooler). The pooler (6543) doesn't support `pg_dump`.

**2. Schedule with cron:**

```bash
crontab -e
# Add:
0 2 * * * /path/to/wabizz/scripts/backup-supabase.sh >> /var/log/wabizz-backup.log 2>&1
```

This runs every night at 2am server time.

**3. Verify the first run:**

```bash
./scripts/backup-supabase.sh
# Should print: [backup] Done. 1 backup(s) retained locally in /var/backups/wabizz.
```

**4. Test restore to a staging DB:**

```bash
# NEVER test restores against production — use staging or a local Postgres
pg_restore --clean --no-acl --no-owner -d "$STAGING_DB_URL" /var/backups/wabizz/wabizz_20260503_020000.dump
```

Untested restores don't count. Run a test restore before launch.

### What's backed up

`pg_dump --format=custom` captures:

- All tables and their data
- All indexes
- All functions and triggers
- Row Level Security policies
- Foreign key constraints

It does **not** capture:

- Supabase Storage (file uploads) — back these up via the Storage API or bucket sync
- Auth users — these live in `auth.users` (backed up by Supabase built-in)
- Realtime subscriptions — configuration only, not state

---

## Layer 3 — Point-in-Time Recovery (Supabase Pro)

PITR lets you restore to any second in the past 7 days.

**When you need it:**

- Accidental `DELETE FROM orders` with no `WHERE` clause
- A bad migration that corrupts data
- Recovering a specific record that was deleted 3 hours ago

**Enable:** Supabase → Settings → Backups → Enable PITR

Cost: included in Supabase Pro ($25/month). Worth it once you have paying customers.

---

## Supabase Storage Backups

If your app uses Supabase Storage (file uploads, voice notes, etc.):

```bash
# Sync Storage bucket to local or S3
# Install: pip install supabase-storage-cli (or use rclone)
rclone sync supabase:your-bucket /var/backups/wabizz/storage/ --progress
```

Or configure an S3-compatible sync from the Supabase Storage UI.

---

## Monitoring

Backup failures should alert you. Two options:

**Option A: Log monitoring (Better Stack / Logtail)**
Point your log drain at the cron job output. Set an alert if no
`[backup] Done.` line appears after 3am each day.

**Option B: Simple heartbeat**
Add to the end of `backup-supabase.sh`:

```bash
# Ping a heartbeat URL (e.g. Better Stack / Cronitor / Healthchecks.io)
curl -s "${BACKUP_HEARTBEAT_URL}" > /dev/null || true
```

Set BACKUP_HEARTBEAT_URL in your env and configure an alert if the heartbeat
is missed for 25 hours.

---

## Recovery Runbook

If production data is lost or corrupted:

1. **Assess scope** — How much data? Which tables? What time did it happen?
2. **Stop writes** — Set app to maintenance mode to prevent more damage
3. **Choose recovery method:**
   - < 7 days ago, approximate time OK → Supabase built-in backup
   - < 7 days ago, exact time needed → PITR (requires Pro)
   - Recent hours, local backup exists → `pg_restore` from `backup-supabase.sh` output
4. **Restore to staging first** — verify data looks right before touching production
5. **Apply to production** — Supabase dashboard → Restore, or `pg_restore` to prod URL
6. **Verify** — spot-check key tables (businesses, subscriptions, orders)
7. **Resume writes** — disable maintenance mode
8. **Post-mortem** — document what happened and how to prevent it

---

## Pre-Launch Checklist

- [ ] Supabase built-in daily backups are enabled and green
- [ ] `SUPABASE_DB_URL` is set on the server (direct port 5432, not pooler)
- [ ] `backup-supabase.sh` runs successfully at least once
- [ ] A test restore to staging has been completed and verified
- [ ] Cron job is scheduled (`crontab -l` shows it)
- [ ] (Optional) `BACKUP_BUCKET` + cloud credentials are configured for offsite copies
- [ ] (Recommended) Heartbeat URL is configured and alerting on missed backups
