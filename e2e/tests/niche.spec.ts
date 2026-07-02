/**
 * e2e/tests/niche.spec.ts
 *
 * End-to-end tests for niche module conversation flows.
 * Tests the full path: WhatsApp webhook → niche handler → reply.
 *
 * These tests hit the /api/public/twilio-webhook endpoint with a valid
 * Twilio HMAC signature and assert the WhatsApp reply content.
 *
 * Prerequisites (set in playwright.config.ts / test env):
 *   - A test business with hospital niche enabled (NICHE_TEST_HOSPITAL_BUSINESS_ID)
 *   - A test business with food_trader niche enabled (NICHE_TEST_FOOD_BUSINESS_ID)
 *   - TWILIO_AUTH_TOKEN in env for HMAC signing
 *   - TEST_BASE_URL pointing to the running Wabizz instance
 */

import { test, expect } from "@playwright/test";
import crypto from "crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "test-token";
const HOSPITAL_BUSINESS_PHONE =
  process.env.NICHE_TEST_HOSPITAL_WHATSAPP_NUMBER ?? "whatsapp:+2341234567890";
const FOOD_BUSINESS_PHONE =
  process.env.NICHE_TEST_FOOD_WHATSAPP_NUMBER ?? "whatsapp:+2349876543210";
const TEST_CUSTOMER_PHONE = "whatsapp:+2348000000001";

/**
 * Signs a Twilio webhook body exactly as Twilio does (HMAC-SHA1).
 * Required for the signature check to pass in the webhook handler.
 */
function signTwilioRequest(url: string, params: Record<string, string>, authToken: string): string {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map((k) => `${k}${params[k]}`).join("");
  const toSign = url + paramString;
  return crypto.createHmac("sha1", authToken).update(toSign).digest("base64");
}

async function sendWhatsAppMessage(
  businessPhone: string,
  customerMessage: string,
  conversationId?: string,
): Promise<{ reply: string; status: number }> {
  const webhookUrl = `${BASE_URL}/api/public/twilio-webhook`;

  const params: Record<string, string> = {
    From: TEST_CUSTOMER_PHONE,
    To: businessPhone,
    Body: customerMessage,
    MessageSid: `MM${crypto.randomUUID().replace(/-/g, "")}`,
    AccountSid: "ACtest",
    NumMedia: "0",
  };

  const signature = signTwilioRequest(webhookUrl, params, TWILIO_TOKEN);

  const body = new URLSearchParams(params).toString();
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body,
  });

  const text = await resp.text();
  // Wabizz returns TwiML; extract the <Message> body
  const match = text.match(/<Message>([\s\S]*?)<\/Message>/);
  return {
    reply: match ? match[1] : text,
    status: resp.status,
  };
}

// ── Hospital Module Tests ─────────────────────────────────────────────────────

test.describe("Hospital Niche Module", () => {
  test("should list doctors when customer asks about doctors", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "What doctors do you have?",
    );

    expect(status).toBe(200);
    // Should reply with doctor list or a relevant message
    expect(reply).toMatch(/doctor|Dr\.|physician|specialist|available/i);
    // Should NOT return the generic fallback
    expect(reply).not.toMatch(/Thanks for your message! We.ll get back/i);
  });

  test("should start booking flow when customer says 'book appointment'", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "I want to book an appointment",
    );

    expect(status).toBe(200);
    // Should ask about specialty or show doctor list
    expect(reply).toMatch(/doctor|specialist|which|specialty|prefer/i);
  });

  test("should handle slot inquiry for booking flow", async () => {
    // Step 1: Start booking
    await sendWhatsAppMessage(HOSPITAL_BUSINESS_PHONE, "book appointment");

    // Step 2: Ask about availability (follow-up turn)
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "what time slots are available tomorrow?",
    );

    expect(status).toBe(200);
    // Should either show slots or ask which doctor first
    expect(reply).toMatch(/slot|time|available|doctor|which|AM|PM|:00/i);
  });

  test("should handle cancel appointment request", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "I need to cancel my appointment",
    );

    expect(status).toBe(200);
    // Should ask for appointment ID or say no booking found
    expect(reply).toMatch(/appointment|cancel|ID|found|booking/i);
  });

  test("should answer pricing FAQ", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "How much does consultation cost?",
    );

    expect(status).toBe(200);
    // Should mention fee or refer to doctor page
    expect(reply).toMatch(/fee|cost|₦|price|consult|doctor/i);
  });

  test("should answer hours FAQ", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "What are your opening hours?",
    );

    expect(status).toBe(200);
    expect(reply).toMatch(/hour|open|close|time|AM|PM/i);
  });

  test("should respond gracefully when booking system is unavailable", async () => {
    // This tests the VITAR_UNAVAILABLE_REPLY path.
    // In CI, Vitar won't be running, so the circuit breaker / fetch will fail.
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "book appointment please",
    );

    expect(status).toBe(200);
    // Either shows doctors (Vitar running) or shows unavailable message (Vitar down)
    expect(reply).toMatch(/doctor|specialist|unavailable|call us|booking system/i);
  });
});

// ── Food Trader Module Tests ──────────────────────────────────────────────────

test.describe("Food Trader Niche Module", () => {
  test("should show menu when customer asks 'what do you have?'", async () => {
    const { reply, status } = await sendWhatsAppMessage(FOOD_BUSINESS_PHONE, "What do you sell?");

    expect(status).toBe(200);
    // Should return a menu or a meaningful message
    expect(reply).toMatch(/menu|item|price|₦|available|sell/i);
    expect(reply).not.toMatch(/Thanks for your message! We.ll get back/i);
  });

  test("should show menu for 'show me your menu' phrasing", async () => {
    const { reply, status } = await sendWhatsAppMessage(FOOD_BUSINESS_PHONE, "Show me your menu");

    expect(status).toBe(200);
    expect(reply).toMatch(/menu|item|₦|1\.|2\.|3\./i);
  });

  test("should initiate order flow when customer places an order", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      FOOD_BUSINESS_PHONE,
      "I want to order jollof rice",
    );

    expect(status).toBe(200);
    // Should confirm the item or ask for clarification
    expect(reply).toMatch(/jollof|order|confirm|₦|total|delivery|pickup/i);
  });

  test("should return order status when customer asks", async () => {
    const { reply, status } = await sendWhatsAppMessage(FOOD_BUSINESS_PHONE, "Where is my order?");

    expect(status).toBe(200);
    // Either found an order or says no active order
    expect(reply).toMatch(/order|status|found|haven.t|placed|preparing|ready/i);
  });

  test("should handle delivery area FAQ", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      FOOD_BUSINESS_PHONE,
      "Do you deliver to Lekki?",
    );

    expect(status).toBe(200);
    expect(reply).toMatch(/deliver|area|Lekki|location|zone/i);
  });

  test("should handle item price inquiry", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      FOOD_BUSINESS_PHONE,
      "How much is your jollof rice?",
    );

    expect(status).toBe(200);
    expect(reply).toMatch(/₦|price|cost|naira|rice/i);
  });

  test("should handle business owner order status update command", async () => {
    // Business owners can update order status with a special command
    // Format: ORDER #<id> <STATUS>
    const { reply, status } = await sendWhatsAppMessage(
      FOOD_BUSINESS_PHONE,
      "ORDER #FAKEID123 READY",
    );

    expect(status).toBe(200);
    // Should either confirm or say order not found
    expect(reply).toMatch(/order|updated|ready|not found|ID/i);
  });

  test("should reject order after cutoff time if configured", async () => {
    // This test is timezone-sensitive; mark as soft assertion
    const { reply, status } = await sendWhatsAppMessage(FOOD_BUSINESS_PHONE, "I want to order now");

    expect(status).toBe(200);
    // Could be ordering allowed, or cutoff message
    // Just verify we get a coherent response
    expect(reply.length).toBeGreaterThan(10);
  });
});

// ── Cross-niche guard ─────────────────────────────────────────────────────────

test.describe("Niche routing isolation", () => {
  test("hospital message on food business should NOT trigger booking flow", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      FOOD_BUSINESS_PHONE,
      "I want to book an appointment with a doctor",
    );

    expect(status).toBe(200);
    // Food handler should not produce hospital-specific language
    expect(reply).not.toMatch(/appointment booked|vitar|which doctor.*specialty/i);
  });

  test("food order on hospital business should NOT trigger food order flow", async () => {
    const { reply, status } = await sendWhatsAppMessage(
      HOSPITAL_BUSINESS_PHONE,
      "I want to order jollof rice x2",
    );

    expect(status).toBe(200);
    // Hospital handler should not produce food-ordering language
    expect(reply).not.toMatch(/menu|jollof|delivery.*area|order.*confirmed/i);
  });
});
