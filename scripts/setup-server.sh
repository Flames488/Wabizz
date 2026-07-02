#!/usr/bin/env bash
# =============================================================================
# setup-server.sh — Wabizz VPS first-time setup
#
# Run ONCE on a fresh VPS after `bun run build`. Automates every manual step
# that was previously comment-only documentation:
#
#   1. Creates the logs directory
#   2. Installs + configures pm2-logrotate (eliminates disk-filling log files)
#   3. Registers PM2 as a system service (auto-start on reboot)
#   4. Registers an uptime monitor via Better Uptime API (or UptimeRobot)
#   5. Starts the app and saves the process list
#
# Usage:
#   chmod +x scripts/setup-server.sh
#   APP_URL=https://your-domain.com \
#   BETTERUPTIME_API_KEY=your_key \       # get free key at betteruptime.com
#   HEALTH_CHECK_SECRET=your_secret \    # must match your .env
#   bash scripts/setup-server.sh
#
# Environment variables:
#   APP_URL                  (required) — your app's public URL
#   BETTERUPTIME_API_KEY     (optional) — enables Better Uptime monitor creation
#   UPTIMEROBOT_API_KEY      (optional) — enables UptimeRobot monitor creation (fallback)
#   HEALTH_CHECK_SECRET      (optional) — passed as header to authenticated health endpoint
#   SKIP_MONITOR             (optional) — set to "1" to skip monitor registration
#
# =============================================================================

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

info()    { echo -e "${GREEN}[setup]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET}  $*"; }
error()   { echo -e "${RED}[error]${RESET} $*" >&2; }
section() { echo -e "\n${BOLD}── $* ──────────────────────────────────────────${RESET}"; }

# ── Prerequisite checks ────────────────────────────────────────────────────────

section "Checking prerequisites"

if ! command -v pm2 &>/dev/null; then
  error "pm2 not found. Install with: npm install -g pm2"
  exit 1
fi

if ! command -v bun &>/dev/null; then
  error "bun not found. Install from: https://bun.sh"
  exit 1
fi

if [[ ! -f ".output/server/index.mjs" ]]; then
  error "Build output not found at .output/server/index.mjs"
  error "Run 'bun run build' first."
  exit 1
fi

if [[ -z "${APP_URL:-}" ]]; then
  error "APP_URL is required. Export it before running this script."
  error "  export APP_URL=https://your-domain.com"
  exit 1
fi

info "Prerequisites OK"

# ── 1. Create logs directory ──────────────────────────────────────────────────

section "Step 1/5 — Logs directory"
mkdir -p logs
info "logs/ directory ready"

# ── 2. PM2 log rotation ───────────────────────────────────────────────────────
#
# Without pm2-logrotate, PM2 writes to a single unbounded log file.
# On a busy server, this fills the disk in days and crashes the app.
# pm2-logrotate is a PM2 module — install it exactly once per server.

section "Step 2/5 — PM2 log rotation"

if pm2 list --no-color 2>&1 | grep -q "pm2-logrotate"; then
  info "pm2-logrotate already installed — skipping"
else
  info "Installing pm2-logrotate..."
  pm2 install pm2-logrotate

  # Configure rotation: 50 MB max per file, 14 days retention, gzip archives.
  pm2 set pm2-logrotate:max_size 50M
  pm2 set pm2-logrotate:retain 14
  pm2 set pm2-logrotate:compress true
  pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
  pm2 set pm2-logrotate:rotateInterval "0 0 * * *"   # daily at midnight
  pm2 set pm2-logrotate:workerInterval 3600            # check every hour

  info "pm2-logrotate installed and configured ✅"
  info "  max_size=50M  retain=14 days  compress=true"
fi

# ── 3. PM2 system startup hook ────────────────────────────────────────────────
#
# `pm2 startup` prints a command that installs a systemd/launchd/rc.d service.
# We capture and execute it automatically so the app survives server reboots.

section "Step 3/5 — PM2 startup hook"

STARTUP_CMD=$(pm2 startup 2>&1 | grep "sudo " | tail -1 || true)
if [[ -n "$STARTUP_CMD" ]]; then
  info "Running startup hook: $STARTUP_CMD"
  eval "$STARTUP_CMD" || warn "Startup hook failed — you may need to run it manually as root."
else
  info "PM2 startup hook already registered (or not needed on this OS)"
fi

# ── 4. Start app + save process list ─────────────────────────────────────────

section "Step 4/5 — Start application"

if pm2 list --no-color 2>&1 | grep -q "wabizz"; then
  info "Wabizz process already running — reloading for zero-downtime update..."
  pm2 reload ecosystem.config.cjs --env production
else
  info "Starting Wabizz..."
  pm2 start ecosystem.config.cjs --env production
fi

pm2 save
info "Process list saved ✅"

# Wait for the app to be ready before registering the monitor
info "Waiting 10s for the app to come up..."
sleep 10

HEALTH_URL="${APP_URL}/api/public/health"
HEALTH_ARGS=("-s" "-o" "/dev/null" "-w" "%{http_code}")
if [[ -n "${HEALTH_CHECK_SECRET:-}" ]]; then
  HEALTH_ARGS+=("-H" "x-health-secret: ${HEALTH_CHECK_SECRET}")
fi

HTTP_STATUS=$(curl "${HEALTH_ARGS[@]}" "${HEALTH_URL}?deep=1" || echo "000")
if [[ "$HTTP_STATUS" == "200" ]]; then
  info "Health check passed (HTTP 200) ✅"
else
  warn "Health check returned HTTP $HTTP_STATUS — check your .env and logs."
  warn "  pm2 logs wabizz --lines 50"
fi

# ── 5. Register uptime monitor ────────────────────────────────────────────────
#
# An external uptime monitor is the safety net when PM2 exhausts max_restarts
# and stops trying. Without one, a dead app is invisible until a user complains.
#
# Priority order:
#   1. Better Uptime (BETTERUPTIME_API_KEY set)
#   2. UptimeRobot   (UPTIMEROBOT_API_KEY set)
#   3. Print manual instructions

section "Step 5/5 — Uptime monitor registration"

MONITOR_NAME="Wabizz Health (${APP_URL})"
MONITOR_URL="${APP_URL}/api/public/health"

if [[ "${SKIP_MONITOR:-0}" == "1" ]]; then
  warn "SKIP_MONITOR=1 — skipping monitor registration"

elif [[ -n "${BETTERUPTIME_API_KEY:-}" ]]; then
  # ── Better Uptime ────────────────────────────────────────────────────────────
  # Docs: https://betterstack.com/docs/uptime/api/monitors/
  # Free plan: 10 monitors, 3-min check interval

  info "Registering Better Uptime monitor..."

  BU_PAYLOAD=$(cat <<EOF
{
  "monitor_type": "status",
  "url": "${MONITOR_URL}",
  "friendly_name": "${MONITOR_NAME}",
  "check_frequency": 180,
  "request_timeout": 30,
  "expected_status_codes": [200],
  "http_method": "GET",
  "follow_redirects": true,
  "remember_cookies": false,
  "request_headers": [
    { "name": "x-health-secret", "value": "${HEALTH_CHECK_SECRET:-}" }
  ]
}
EOF
)

  BU_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "https://uptime.betterstack.com/api/v2/monitors" \
    -H "Authorization: Bearer ${BETTERUPTIME_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$BU_PAYLOAD")

  BU_HTTP=$(echo "$BU_RESPONSE" | tail -1)
  BU_BODY=$(echo "$BU_RESPONSE" | head -1)

  if [[ "$BU_HTTP" == "201" ]] || [[ "$BU_HTTP" == "200" ]]; then
    MONITOR_ID=$(echo "$BU_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "unknown")
    info "Better Uptime monitor created ✅ (id: $MONITOR_ID)"
    info "  URL: https://betterstack.com/dashboard — configure escalation policies there"
  else
    warn "Better Uptime API returned HTTP $BU_HTTP"
    warn "Response: $BU_BODY"
    warn "Monitor NOT created — register manually at https://betterstack.com"
  fi

elif [[ -n "${UPTIMEROBOT_API_KEY:-}" ]]; then
  # ── UptimeRobot ──────────────────────────────────────────────────────────────
  # Docs: https://uptimerobot.com/api/
  # Free plan: 50 monitors, 5-min check interval

  info "Registering UptimeRobot monitor..."

  UR_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "https://api.uptimerobot.com/v2/newMonitor" \
    -H "Content-Type: application/json" \
    -d "{
      \"api_key\": \"${UPTIMEROBOT_API_KEY}\",
      \"friendly_name\": \"${MONITOR_NAME}\",
      \"url\": \"${MONITOR_URL}\",
      \"type\": 1,
      \"interval\": 300,
      \"alert_contacts\": \"\"
    }")

  UR_HTTP=$(echo "$UR_RESPONSE" | tail -1)
  UR_BODY=$(echo "$UR_RESPONSE" | head -1)
  UR_STAT=$(echo "$UR_BODY" | grep -o '"stat":"[a-z]*"' | cut -d'"' -f4 || echo "unknown")

  if [[ "$UR_STAT" == "ok" ]]; then
    MONITOR_ID=$(echo "$UR_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "unknown")
    info "UptimeRobot monitor created ✅ (id: $MONITOR_ID)"
    info "  URL: https://dashboard.uptimerobot.com — configure alerts there"
  else
    warn "UptimeRobot returned stat=$UR_STAT (HTTP $UR_HTTP)"
    warn "Response: $UR_BODY"
    warn "Monitor NOT created — register manually at https://uptimerobot.com"
  fi

else
  # ── Manual instructions ───────────────────────────────────────────────────────
  warn "No uptime monitor API key provided."
  warn "Set up a free monitor manually at one of these services:"
  warn ""
  warn "  Better Uptime (recommended — 3-min checks, Slack/PagerDuty alerts):"
  warn "    https://betterstack.com/uptime"
  warn "    Monitor URL : ${MONITOR_URL}"
  warn "    Method      : GET"
  warn "    Header      : x-health-secret: \${HEALTH_CHECK_SECRET}"
  warn "    Interval    : 3 minutes"
  warn "    Alert on    : non-200 response"
  warn ""
  warn "  UptimeRobot (free, 5-min checks):"
  warn "    https://uptimerobot.com"
  warn "    Monitor URL : ${MONITOR_URL}"
  warn "    Type        : HTTP(S)"
  warn ""
  warn "  Re-run with BETTERUPTIME_API_KEY=<key> to register automatically."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

section "Setup complete"

pm2 status

echo ""
info "✅ Wabizz is running. Next steps:"
info "   1. Verify health: curl ${HEALTH_URL}?deep=1"
info "   2. Watch logs:    pm2 logs wabizz --lines 100"
info "   3. Check status:  pm2 status"
if [[ -z "${BETTERUPTIME_API_KEY:-}" ]] && [[ -z "${UPTIMEROBOT_API_KEY:-}" ]] && [[ "${SKIP_MONITOR:-0}" != "1" ]]; then
  info "   4. ⚠ Register an uptime monitor — instructions printed above."
fi
