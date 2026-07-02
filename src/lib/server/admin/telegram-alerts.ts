/**
 * telegram-alerts.ts — Telegram bot alert delivery for Wabizz
 *
 * Fastest alert channel to implement — one HTTP call, no SDK needed.
 * Works alongside the existing Slack webhook in alerting.ts.
 *
 * Setup:
 *   1. Message @BotFather on Telegram → /newbot → get BOT_TOKEN
 *   2. Start a chat with your bot, then call:
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *      to find your CHAT_ID
 *   3. Add to .env / Cloudflare secrets:
 *      TELEGRAM_BOT_TOKEN=<your token>
 *      TELEGRAM_CHAT_ID=<your chat or group id>
 *
 * Alert types mirroring alerting.ts:
 *   - DLQ job moved (critical)
 *   - Queue backlog > 500 jobs
 *   - Failure rate spike > 10%
 *   - External API down (consecutive failures)
 *   - Webhook stall (stuck in processing > 5min)
 *   - System error / worker crash
 *
 * All alerts are rate-limited: one per (type + key) per hour to prevent spam.
 * Fire-and-forget — never blocks the main request path.
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN ?? null;
const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID ?? null;

// Rate-limit dedup — one alert per key per hour
const _alertedAt = new Map<string, number>();
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function _shouldAlert(key: string): boolean {
  const last = _alertedAt.get(key) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return false;
  _alertedAt.set(key, Date.now());
  return true;
}

/**
 * Send a raw Telegram message. Escape MarkdownV2 special chars.
 * Fire-and-forget — errors are logged to stdout only.
 */
async function _send(text: string): Promise<void> {
  const token = BOT_TOKEN();
  const chatId = CHAT_ID();
  if (!token || !chatId) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — alert skipped");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    console.error("[telegram] Failed to send alert:", String(e));
  }
}

// ── Alert: DLQ job ────────────────────────────────────────────────────────────

export async function tgAlertDlqJob(args: {
  jobId: string;
  jobType: string;
  attempts: number;
  error: string;
}): Promise<void> {
  if (!_shouldAlert(`dlq:${args.jobType}`)) return;
  await _send(
    `🚨 <b>DLQ Alert — Wabizz</b>\n\n` +
      `A job exhausted all retries and was moved to the Dead Letter Queue.\n\n` +
      `<b>Type:</b> <code>${args.jobType}</code>\n` +
      `<b>Job ID:</b> <code>${args.jobId.slice(0, 16)}…</code>\n` +
      `<b>Attempts:</b> ${args.attempts}\n` +
      `<b>Error:</b> <code>${args.error.slice(0, 200)}</code>\n\n` +
      `<b>Action:</b> Open admin → Queue tab to retry or acknowledge.`,
  );
}

// ── Alert: Queue backlog ──────────────────────────────────────────────────────

export async function tgAlertQueueBacklog(args: {
  total: number;
  ready: number;
  deferred: number;
  threshold?: number;
}): Promise<void> {
  const threshold = args.threshold ?? 500;
  if (args.total < threshold) return;
  if (!_shouldAlert("queue_backlog")) return;
  await _send(
    `⚠️ <b>Queue Backlog Alert — Wabizz</b>\n\n` +
      `Queue size has exceeded the alert threshold.\n\n` +
      `<b>Total jobs:</b> ${args.total.toLocaleString()}\n` +
      `<b>Ready:</b> ${args.ready} &nbsp;|&nbsp; <b>Deferred:</b> ${args.deferred}\n` +
      `<b>Threshold:</b> ${threshold}\n` +
      `<b>Time:</b> ${new Date().toUTCString()}\n\n` +
      `<b>Action:</b> Check worker health and processQueue() invocation rate.`,
  );
}

// ── Alert: Failure rate spike ─────────────────────────────────────────────────

export async function tgAlertFailureRate(args: {
  failureRatePct: number;
  failedCount: number;
  totalCount: number;
  windowMinutes?: number;
}): Promise<void> {
  if (args.failureRatePct < 10) return;
  if (!_shouldAlert("failure_rate")) return;
  const window = args.windowMinutes ?? 5;
  await _send(
    `🔥 <b>Failure Rate Spike — Wabizz</b>\n\n` +
      `Job failure rate exceeded 10% in the last ${window} minutes.\n\n` +
      `<b>Failure rate:</b> ${args.failureRatePct}%\n` +
      `<b>Failed / Total:</b> ${args.failedCount} / ${args.totalCount}\n` +
      `<b>Time:</b> ${new Date().toUTCString()}\n\n` +
      `<b>Action:</b> Check error_logs in Supabase or the admin Logs tab.`,
  );
}

// ── Alert: External API down ──────────────────────────────────────────────────

export async function tgAlertApiDown(args: {
  service: "twilio" | "paystack" | "anthropic";
  consecutiveFailures: number;
  lastError?: string;
}): Promise<void> {
  const threshold = 3;
  if (args.consecutiveFailures < threshold) return;
  if (!_shouldAlert(`api_down:${args.service}`)) return;
  const emoji = { twilio: "📱", paystack: "💳", anthropic: "🤖" }[args.service];
  await _send(
    `${emoji} <b>API Down Alert — Wabizz</b>\n\n` +
      `<b>${args.service.toUpperCase()}</b> has failed ${args.consecutiveFailures} consecutive times.\n\n` +
      `<b>Last error:</b> <code>${(args.lastError ?? "unknown").slice(0, 200)}</code>\n` +
      `<b>Time:</b> ${new Date().toUTCString()}\n\n` +
      `<b>Action:</b> Check ${args.service} dashboard for outages. ` +
      `Failed jobs are retrying with exponential backoff.`,
  );
}

// ── Alert: Webhook stall ──────────────────────────────────────────────────────

export async function tgAlertWebhookStall(args: {
  count: number;
  stalledEvents: Array<{ source: string; event_id: string; received_at: string }>;
}): Promise<void> {
  if (args.count === 0) return;
  if (!_shouldAlert("webhook_stall")) return;
  const lines = args.stalledEvents
    .slice(0, 5)
    .map(
      (e) =>
        `  • [${e.source}] <code>${e.event_id.slice(0, 16)}</code> — stuck since ${new Date(e.received_at).toLocaleTimeString()}`,
    )
    .join("\n");
  await _send(
    `🕐 <b>Webhook Stall Alert — Wabizz</b>\n\n` +
      `${args.count} webhook(s) have been stuck in "processing" for over 5 minutes.\n` +
      `This likely means a worker crashed mid-processing.\n\n` +
      `${lines}\n\n` +
      `<b>Action:</b> Check webhook_events table in Supabase. Events may need manual replay.`,
  );
}

// ── Alert: System error / uncaught exception ──────────────────────────────────

export async function tgAlertSystemError(args: {
  source: string;
  message: string;
  requestId?: string;
}): Promise<void> {
  if (!_shouldAlert(`system_error:${args.source}`)) return;
  await _send(
    `💥 <b>System Error — Wabizz</b>\n\n` +
      `An unhandled error occurred in <b>${args.source}</b>.\n\n` +
      `<b>Message:</b> <code>${args.message.slice(0, 300)}</code>\n` +
      `${args.requestId ? `<b>Request ID:</b> <code>${args.requestId}</code>\n` : ""}` +
      `<b>Time:</b> ${new Date().toUTCString()}\n\n` +
      `<b>Action:</b> Check admin Logs tab immediately.`,
  );
}

// ── Alert: DLQ growth (called from cron) ─────────────────────────────────────

export async function tgAlertDlqGrowth(args: {
  currentCount: number;
  previousCount: number;
}): Promise<void> {
  // Alert if DLQ grew by 3+ jobs since last check
  if (args.currentCount - args.previousCount < 3) return;
  if (!_shouldAlert("dlq_growth")) return;
  await _send(
    `📈 <b>DLQ Growth Alert — Wabizz</b>\n\n` +
      `The Dead Letter Queue is growing continuously.\n\n` +
      `<b>Current:</b> ${args.currentCount} jobs\n` +
      `<b>Previous:</b> ${args.previousCount} jobs\n` +
      `<b>Delta:</b> +${args.currentCount - args.previousCount}\n` +
      `<b>Time:</b> ${new Date().toUTCString()}\n\n` +
      `<b>Action:</b> Open admin → Queue tab to review and retry failed jobs.`,
  );
}
