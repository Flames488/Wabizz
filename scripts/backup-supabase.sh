#!/usr/bin/env bash
# =============================================================================
# backup-supabase.sh — Automated Supabase database backup
#
# Usage:
#   ./scripts/backup-supabase.sh
#
# Environment variables required (set in server /etc/environment or secrets manager):
#   SUPABASE_DB_URL     — Direct Postgres URL (port 5432, NOT pooler)
#                         Format: postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres
#   BACKUP_BUCKET       — (optional) S3/R2 bucket name for offsite upload
#   AWS_ACCESS_KEY_ID   — (optional) AWS/R2 credentials for offsite upload
#   AWS_SECRET_ACCESS_KEY
#   AWS_ENDPOINT_URL    — (optional) Cloudflare R2 endpoint if using R2
#
# Schedule (add to crontab via crontab -e):
#   0 2 * * * /path/to/wabizz/scripts/backup-supabase.sh >> /var/log/wabizz-backup.log 2>&1
#
# What this does:
#   1. pg_dump to a compressed local file (gzip)
#   2. Keeps the last 7 daily backups locally (auto-prunes older ones)
#   3. Uploads to S3/R2 if BACKUP_BUCKET is set (offsite copy)
#   4. Verifies the backup is non-empty and restoreable (pg_restore --list)
#   5. Prints a summary — suitable for log monitoring (Logtail/Better Stack)
#
# Restore:
#   pg_restore --clean --no-acl --no-owner -d "$TARGET_DB_URL" backup.dump
#
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

BACKUP_DIR="${BACKUP_DIR:-/var/backups/wabizz}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="wabizz_${TIMESTAMP}.dump"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILE}"

# ── Validation ────────────────────────────────────────────────────────────────

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "[backup] ERROR: SUPABASE_DB_URL is not set. Backup aborted."
  exit 1
fi

# ── Setup ─────────────────────────────────────────────────────────────────────

mkdir -p "$BACKUP_DIR"
echo "[backup] Starting backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[backup] Output: ${BACKUP_PATH}.gz"

# ── pg_dump ───────────────────────────────────────────────────────────────────

# --format=custom: binary format, supports partial restore and is smaller than SQL
# --no-acl: skip GRANT/REVOKE (Supabase manages these)
# --no-owner: skip SET OWNER (not needed when restoring to Supabase)
# --compress=6: gzip compression level (good balance of size vs speed)

pg_dump \
  --format=custom \
  --no-acl \
  --no-owner \
  --compress=6 \
  --file="${BACKUP_PATH}" \
  "${SUPABASE_DB_URL}" 2>&1

# ── Verify ────────────────────────────────────────────────────────────────────

BACKUP_SIZE=$(stat -c%s "${BACKUP_PATH}" 2>/dev/null || stat -f%z "${BACKUP_PATH}")

if [[ "$BACKUP_SIZE" -lt 1024 ]]; then
  echo "[backup] ERROR: Backup file is suspiciously small (${BACKUP_SIZE} bytes). Something went wrong."
  rm -f "${BACKUP_PATH}"
  exit 1
fi

# Verify the dump is readable (pg_restore --list reads the table of contents)
if ! pg_restore --list "${BACKUP_PATH}" > /dev/null 2>&1; then
  echo "[backup] ERROR: pg_restore --list failed — backup file may be corrupt."
  rm -f "${BACKUP_PATH}"
  exit 1
fi

echo "[backup] Backup verified: $(du -sh "${BACKUP_PATH}" | cut -f1) (${BACKUP_SIZE} bytes)"

# ── Offsite upload (optional) ─────────────────────────────────────────────────

if [[ -n "${BACKUP_BUCKET:-}" ]]; then
  if command -v aws &> /dev/null; then
    DEST="s3://${BACKUP_BUCKET}/wabizz/$(date +%Y/%m)/${BACKUP_FILE}"
    EXTRA_ARGS=""
    if [[ -n "${AWS_ENDPOINT_URL:-}" ]]; then
      EXTRA_ARGS="--endpoint-url ${AWS_ENDPOINT_URL}"
    fi
    echo "[backup] Uploading to ${DEST} ..."
    aws s3 cp "${BACKUP_PATH}" "${DEST}" ${EXTRA_ARGS} --quiet
    echo "[backup] Offsite upload complete: ${DEST}"
  else
    echo "[backup] WARNING: BACKUP_BUCKET is set but 'aws' CLI not found. Skipping offsite upload."
  fi
else
  echo "[backup] INFO: BACKUP_BUCKET not set — skipping offsite upload (local backup only)."
  echo "[backup]       Set BACKUP_BUCKET + AWS credentials to enable offsite copies."
fi

# ── Prune old backups ─────────────────────────────────────────────────────────

PRUNED=$(find "${BACKUP_DIR}" -name "wabizz_*.dump" -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l)
if [[ "$PRUNED" -gt 0 ]]; then
  echo "[backup] Pruned ${PRUNED} backup(s) older than ${RETENTION_DAYS} days."
fi

# ── Summary ───────────────────────────────────────────────────────────────────

REMAINING=$(find "${BACKUP_DIR}" -name "wabizz_*.dump" | wc -l)
echo "[backup] Done. ${REMAINING} backup(s) retained locally in ${BACKUP_DIR}."
echo "[backup] Completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
