/**
 * whatsapp.ts — Client-safe WhatsApp utilities
 *
 * SECURITY FIX (Breaking Change):
 *   The previous implementation stored the 360dialog API key in localStorage
 *   under the key "wabizz_whatsapp_360dialog". This has been REMOVED.
 *   An API key in localStorage is exposed to any JavaScript on the page,
 *   browser extensions, and XSS attacks.
 *
 *   API keys are stored exclusively in Supabase Vault and accessed server-side:
 *     - getWhatsAppApiKey(businessId)  → server/keys.functions.ts
 *     - saveWhatsAppConfig(serverFn)   → server/keys.functions.ts
 *     - getWhatsAppStatus(serverFn)    → server/keys.functions.ts
 *
 *   This file contains ONLY client-safe utilities (no secrets, no localStorage).
 */

/** Normalise a phone number to the format 360dialog expects (E.164, no '+') */
export function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Validate an E.164-style phone number */
export function isValidPhone(phone: string): boolean {
  const digits = normalisePhone(phone);
  return /^\d{7,15}$/.test(digits) && !digits.startsWith("0");
}

/** Build a 360dialog plain-text message body */
export function buildTextMessageBody(to: string, text: string): Record<string, unknown> {
  return {
    recipient_type: "individual",
    to: normalisePhone(to),
    type: "text",
    text: { body: text },
  };
}

/** Build a 360dialog template message body */
export function buildTemplateMessageBody(
  to: string,
  templateName: string,
  languageCode: string,
  components: unknown[] = [],
): Record<string, unknown> {
  return {
    recipient_type: "individual",
    to: normalisePhone(to),
    type: "template",
    template: {
      namespace: "",
      name: templateName,
      language: { policy: "deterministic", code: languageCode },
      components,
    },
  };
}

/** 360dialog API base URL */
export const DIALOG_API_BASE = "https://waba.360dialog.io/v1";

/** Default per-business send rate limit (messages / minute) — enforced in queue consumer */
export const WHATSAPP_RATE_LIMIT_PER_MIN = 60;
