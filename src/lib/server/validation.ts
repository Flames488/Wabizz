/**
 * validation.ts — Centralized input validation schemas
 *
 * All Zod schemas used across server functions live here for:
 *  - Single source of truth (change in one place, applies everywhere)
 *  - Reuse in tests
 *  - Consistent error messages
 *
 * Usage:
 *   import { BusinessSchema, PlanIdSchema } from "@/lib/server/validation";
 *   .inputValidator((input: unknown) => BusinessSchema.parse(input))
 */

import { z } from "zod";

// ── Primitives ────────────────────────────────────────────────────────────────

export const UUIDSchema = z.string().uuid("Invalid ID format");

export const PhoneSchema = z
  .string()
  .trim()
  .min(7, "Phone number too short")
  .max(40, "Phone number too long")
  .regex(/^\+?[\d\s\-().]+$/, "Invalid phone number format");

export const EmailSchema = z
  .string()
  .trim()
  .email("Invalid email address")
  .max(255, "Email too long")
  .toLowerCase();

export const TimeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format (e.g. 09:00)")
  .refine((t) => {
    const [h, m] = t.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }, "Invalid time value");

// ── Enums ─────────────────────────────────────────────────────────────────────

export const ToneSchema = z.enum(["Professional", "Friendly", "Pidgin"]);

export const PlanIdSchema = z.enum(["starter", "growth", "pro"]);

// ── Business ──────────────────────────────────────────────────────────────────

// Base object schema kept separate from BusinessSchema's .refine() below —
// .refine() returns a ZodEffects wrapper, which has no .partial() method.
// UpdateBusinessSchema needs .partial() on the plain ZodObject, so it's
// derived from this base rather than from the refined BusinessSchema.
const BusinessObjectSchema = z.object({
  name: z.string().trim().min(1, "Business name is required").max(200, "Business name too long"),
  type: z.string().trim().min(1, "Business type is required").max(100, "Business type too long"),
  email: EmailSchema,
  whatsapp: PhoneSchema,
  open_time: TimeSchema,
  close_time: TimeSchema,
  products_list: z.string().max(10_000, "Products list too long").default(""),
  tone: ToneSchema.default("Friendly"),
  custom_message: z.string().max(2_000, "Custom message too long").optional().default(""),
  // FIX BUG 6: timezone field was in the DB (migration 012) and read by the
  // webhook, but was never included in the schema — making it impossible for
  // business owners to set their timezone through any UI or API path.
  timezone: z.string().max(100, "Timezone string too long").optional().default("Africa/Lagos"),
});

export const BusinessSchema = BusinessObjectSchema.refine(
  (d) => {
    // Allow midnight-crossing schedules (e.g. 22:00 – 02:00)
    // Only reject identical times
    return d.open_time !== d.close_time;
  },
  { message: "Open and close time cannot be the same", path: ["close_time"] },
);

export const UpdateBusinessSchema = BusinessObjectSchema.partial();

// ── Paystack keys ─────────────────────────────────────────────────────────────

export const PaystackKeysSchema = z.object({
  publicKey: z
    .string()
    .trim()
    .regex(
      /^pk_(test|live)_[A-Za-z0-9]{10,}$/,
      "Invalid Paystack public key format (should start with pk_live_ or pk_test_)",
    ),
  secretKey: z
    .string()
    .trim()
    .regex(
      /^sk_(test|live)_[A-Za-z0-9]{10,}$/,
      "Invalid Paystack secret key format (should start with sk_live_ or sk_test_)",
    ),
});

// ── Chat / AI ─────────────────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1, "Message cannot be empty").max(4_000, "Message too long"),
});

export const ChatInputSchema = z.object({
  businessName: z.string().trim().min(1).max(200),
  businessType: z.string().trim().min(1).max(100),
  productsList: z.string().max(5_000),
  businessHours: z.string().max(200),
  tone: ToneSchema,
  customMessage: z.string().max(1_000).optional(),
  messages: z
    .array(ChatMessageSchema)
    .min(1, "At least one message required")
    .max(50, "Too many messages in context"),
});

// ── Subscription ──────────────────────────────────────────────────────────────

export const StartTrialSchema = z.object({
  planId: PlanIdSchema,
});

export const ActivatePaidSchema = z.object({
  planId: PlanIdSchema,
  paystackReference: z.string().min(1).max(100),
  periodEnd: z.string().datetime("Invalid period end date"),
});

// ── Orders / Payment links ────────────────────────────────────────────────────

export const GeneratePaymentLinkSchema = z.object({
  amountNaira: z
    .number()
    .int("Amount must be a whole number")
    .positive("Amount must be positive")
    .max(100_000_000, "Amount exceeds maximum"),
  customerNumber: PhoneSchema.optional(),
});

// ── Twilio webhook ────────────────────────────────────────────────────────────

/**
 * Validates the decoded form fields from a Twilio inbound webhook.
 * All fields are strings (URL-encoded form data).
 */
export const TwilioWebhookBodySchema = z.object({
  From: z
    .string()
    .min(1, "From number missing")
    .max(40)
    .regex(/^(whatsapp:)?\+?\d/, "Invalid From number"),
  To: z
    .string()
    .min(1, "To number missing")
    .max(40)
    .regex(/^(whatsapp:)?\+?\d/, "Invalid To number"),
  Body: z.string().max(4_096, "Message body too long"),
  ProfileName: z.string().max(200).optional(),
  NumMedia: z.string().optional(),
});

// ── Health check ──────────────────────────────────────────────────────────────

export const HealthCheckQuerySchema = z.object({
  deep: z.enum(["0", "1"]).optional(),
});

// ── Helper: safe parse with structured error ──────────────────────────────────

import { WabizzError } from "@/lib/server/error-handler";

/**
 * Parse and validate input with Zod. Throws a WabizzError on failure.
 * Use this inside withErrorHandling() to get automatic logging.
 */
export function validateInput<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const field = firstIssue.path.join(".");
    const msg = field
      ? `Validation error on "${field}": ${firstIssue.message}`
      : firstIssue.message;
    throw new WabizzError("VALIDATION_ERROR", msg, msg, {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), msg: i.message })),
    });
  }
  return result.data;
}
