/**
 * error-handler.ts — Global error handling middleware
 *
 * Wraps any async server function with:
 *  - Structured error logging (requestId, source, context)
 *  - Consistent error response shape { ok: false, error: string }
 *  - Fatal alert for unexpected errors (via logFatal → Slack + Telegram)
 *  - Sentry error reporting with full context (source, requestId, userId)
 *  - Never leaks internal stack traces to clients
 *
 * Enhancement v2:
 *  - WabizzErrors also forwarded to Sentry at "warning" level so you can
 *    see validation/auth errors in your Sentry dashboard without noise
 *  - captureMessage() used for expected domain errors (not captureException)
 *    so they show as messages in Sentry, not as exceptions
 *  - userId + businessId passed to Sentry context when available in context
 *
 * Usage:
 *   const result = await withErrorHandling("my-fn", requestId, async () => {
 *     return { ok: true, data: "..." };
 *   });
 */

import { logError, logFatal } from "@/lib/server-logger";
import { captureException, captureFatal, captureMessage } from "@/lib/sentry";

export interface ErrorResult {
  ok: false;
  error: string;
}

export type HandlerResult<T> = T | ErrorResult;

/**
 * Wraps an async handler with global error handling.
 * - WabizzErrors are logged at "error" level with their message surfaced to caller.
 *   They are also sent to Sentry as messages (not exceptions) at "warning" level.
 * - Unknown errors are logged at "fatal" level and captured in Sentry as exceptions.
 *   Only a generic message is returned to the caller.
 */
export async function withErrorHandling<T>(
  source: string,
  requestId: string,
  handler: () => Promise<T>,
): Promise<HandlerResult<T>> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof WabizzError) {
      logError(source, err.message, { code: err.code, ...err.context }, requestId);

      // Forward domain errors to Sentry as messages so you can track
      // validation/auth error patterns without polluting the exceptions feed
      captureMessage(`[${err.code}] ${err.message}`, "warning", {
        source,
        requestId,
        userId: String(err.context.userId ?? ""),
        businessId: String(err.context.businessId ?? ""),
        code: err.code,
        ...err.context,
      });

      return { ok: false, error: err.clientMessage ?? err.message };
    }

    // Unexpected error — capture exception in Sentry + fatal alert via Slack/Telegram
    const _sentryErr = err instanceof Error ? err : new Error(String(err));
    captureFatal(_sentryErr, { source, requestId });

    logFatal(
      source,
      "Unexpected server error",
      {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
      },
      requestId,
    );

    return { ok: false, error: "An unexpected error occurred. Please try again." };
  }
}

// ── Custom error class ────────────────────────────────────────────────────────

export type WabizzErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "EXTERNAL_API_ERROR"
  | "DB_ERROR"
  | "SUBSCRIPTION_REQUIRED"
  | "ALREADY_EXISTS";

/**
 * Domain error class. Throw this anywhere in server code to produce
 * a structured, loggable error with a controlled client-facing message.
 *
 * @param code - machine-readable error code
 * @param message - internal message (logged, NOT sent to client)
 * @param clientMessage - safe message to return to the client (optional)
 * @param context - additional structured context for logging + Sentry
 */
export class WabizzError extends Error {
  constructor(
    public readonly code: WabizzErrorCode,
    message: string,
    public readonly clientMessage?: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WabizzError";
  }

  static notFound(resource: string): WabizzError {
    return new WabizzError("NOT_FOUND", `${resource} not found`, `${resource} not found.`);
  }

  static unauthorized(): WabizzError {
    return new WabizzError("UNAUTHORIZED", "Unauthorized", "You must be logged in.");
  }

  static forbidden(reason?: string): WabizzError {
    return new WabizzError(
      "FORBIDDEN",
      reason ?? "Forbidden",
      "You do not have permission to do this.",
    );
  }

  static subscriptionRequired(): WabizzError {
    return new WabizzError(
      "SUBSCRIPTION_REQUIRED",
      "No active subscription",
      "Your subscription has expired. Visit Pricing to continue.",
    );
  }

  static externalApi(service: string, detail: string): WabizzError {
    return new WabizzError(
      "EXTERNAL_API_ERROR",
      `${service} API error: ${detail}`,
      `Could not reach ${service}. Please try again.`,
      { service, detail },
    );
  }

  static db(operation: string, detail: string): WabizzError {
    return new WabizzError(
      "DB_ERROR",
      `DB error during ${operation}: ${detail}`,
      "A database error occurred. Please try again.",
      { operation, detail },
    );
  }

  static alreadyExists(resource: string): WabizzError {
    return new WabizzError(
      "ALREADY_EXISTS",
      `${resource} already exists`,
      `${resource} already exists.`,
    );
  }
}
