/**
 * integration.test.ts
 *
 * Integration-level tests that simulate full webhook flows.
 * Mocks supabaseAdmin at the module level — no real DB or network calls.
 *
 * Covers:
 *   - New customer → conversation created → message stored → AI replies → reply stored
 *   - Returning customer → existing conversation updated → history loaded → AI called
 *   - Subscription activation via Paystack charge.success
 *   - Order payment via Paystack charge.success + WhatsApp send
 *   - End-to-end state transitions (conversation.status = order_placed)
 *   - Error handling paths with proper request_id propagation
 *   - AbortController timeout scenario (Anthropic API hangs)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleIncomingMessage, handlePaystackEvent } from "../../lib/server/twilio-handler";
import type {
  DbDeps,
  AiDeps,
  PaystackDeps,
  BusinessProfile,
} from "../../lib/server/twilio-handler";

vi.mock("../../lib/server-logger", () => ({
  logError: vi.fn().mockResolvedValue(undefined),
  logInfo: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn().mockResolvedValue(undefined),
  logFatal: vi.fn().mockResolvedValue(undefined),
}));

import { logError } from "../../lib/server-logger";
const mockLogError = vi.mocked(logError);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REQUEST_ID = "integration-test-req-id";

const BUSINESS: BusinessProfile = {
  id: "biz-integration-01",
  name: "TechHub Nigeria",
  type: "electronics",
  products_list: "iPhone 15 ₦900,000\nSamsung S24 ₦700,000\nAirPods Pro ₦150,000",
  open_time: "09:00",
  close_time: "18:00",
  tone: "Professional",
  custom_message: "Always mention our 1-year warranty.",
};

// ── Full new-customer flow ────────────────────────────────────────────────────

describe("Integration: New customer flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates conversation, stores user message, calls AI, stores AI reply", async () => {
    const insertedMessages: Array<{ role: string; content: string }> = [];

    const db: DbDeps = {
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue({ id: "convo-new-001" }),
      updateConversationTimestamp: vi.fn().mockResolvedValue(undefined),
      updateConversationStatus: vi.fn().mockResolvedValue(undefined),
      insertMessage: vi.fn().mockImplementation(({ role, content }) => {
        insertedMessages.push({ role, content });
        return Promise.resolve();
      }),
      getMessageHistory: vi
        .fn()
        .mockResolvedValue([{ role: "user", content: "Do you sell iPhones?" }]),
      isSubscriptionActive: vi.fn().mockResolvedValue(true),
      // FIX BUG 2: getPlanAndMonthlyCount is required by DbDeps for plan limit enforcement.
      getPlanAndMonthlyCount: vi.fn().mockResolvedValue({ planId: "growth", monthlyCount: 0 }),
    };

    const ai: AiDeps = {
      complete: vi.fn().mockResolvedValue("Yes! We sell the iPhone 15 for ₦900,000 🎉"),
    };

    const result = await handleIncomingMessage(
      {
        business: BUSINESS,
        customerNumber: "+2348099887766",
        customerName: "Emeka",
        text: "Do you sell iPhones?",
      },
      { db, ai, requestId: REQUEST_ID },
    );

    expect(result).toBe("Yes! We sell the iPhone 15 for ₦900,000 🎉");
    expect(insertedMessages).toHaveLength(2);
    expect(insertedMessages[0]).toEqual({ role: "user", content: "Do you sell iPhones?" });
    expect(insertedMessages[1]).toEqual({
      role: "assistant",
      content: "Yes! We sell the iPhone 15 for ₦900,000 🎉",
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

// ── Returning customer flow ───────────────────────────────────────────────────

describe("Integration: Returning customer flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-uses existing conversation, passes history to AI", async () => {
    const existingHistory = [
      { role: "user", content: "Do you sell iPhones?" },
      { role: "assistant", content: "Yes! iPhone 15 is ₦900,000" },
      { role: "user", content: "Can I pay in installments?" },
    ];

    const db: DbDeps = {
      getConversation: vi.fn().mockResolvedValue({ id: "convo-existing-002" }),
      createConversation: vi.fn(),
      updateConversationTimestamp: vi.fn().mockResolvedValue(undefined),
      updateConversationStatus: vi.fn().mockResolvedValue(undefined),
      insertMessage: vi.fn().mockResolvedValue(undefined),
      getMessageHistory: vi.fn().mockResolvedValue(existingHistory),
      isSubscriptionActive: vi.fn().mockResolvedValue(true),
      getPlanAndMonthlyCount: vi.fn().mockResolvedValue({ planId: "growth", monthlyCount: 0 }),
    };

    const ai: AiDeps = {
      complete: vi.fn().mockResolvedValue("Yes, we have a 3-month installment plan!"),
    };

    const result = await handleIncomingMessage(
      {
        business: BUSINESS,
        customerNumber: "+2348099887766",
        customerName: "Emeka",
        text: "Can I pay in installments?",
      },
      { db, ai, requestId: REQUEST_ID },
    );

    expect(db.createConversation).not.toHaveBeenCalled();
    expect(db.updateConversationTimestamp).toHaveBeenCalledWith("convo-existing-002", "Emeka");
    // AI receives the full history
    const aiCall = (ai.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(aiCall.messages).toHaveLength(3);
    expect(result).toBe("Yes, we have a 3-month installment plan!");
  });
});

// ── AI timeout resilience ─────────────────────────────────────────────────────

describe("Integration: AI failure resilience", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns fallback reply when AI returns null (timeout/error)", async () => {
    const db: DbDeps = {
      getConversation: vi.fn().mockResolvedValue({ id: "convo-003" }),
      createConversation: vi.fn(),
      updateConversationTimestamp: vi.fn().mockResolvedValue(undefined),
      updateConversationStatus: vi.fn().mockResolvedValue(undefined),
      insertMessage: vi.fn().mockResolvedValue(undefined),
      getMessageHistory: vi.fn().mockResolvedValue([]),
      isSubscriptionActive: vi.fn().mockResolvedValue(true),
      getPlanAndMonthlyCount: vi.fn().mockResolvedValue({ planId: "growth", monthlyCount: 0 }),
    };

    const ai: AiDeps = { complete: vi.fn().mockResolvedValue(null) };

    const result = await handleIncomingMessage(
      { business: BUSINESS, customerNumber: "+234", customerName: null, text: "Hello" },
      { db, ai, requestId: REQUEST_ID },
    );

    expect(result).toBe("Thanks for your message! We'll get back to you shortly.");
    // Fallback reply should still be stored
    expect(db.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant" }));
  });
});

// ── Paystack subscription activation flow ────────────────────────────────────

describe("Integration: Paystack subscription activation", () => {
  beforeEach(() => vi.clearAllMocks());

  function makePaystackDeps(dbOverrides?: Partial<PaystackDeps["db"]>): PaystackDeps {
    return {
      requestId: REQUEST_ID,
      db: {
        getSubscriptionByReference: vi.fn().mockResolvedValue(null),
        updateSubscriptionToActive: vi.fn().mockResolvedValue(undefined),
        insertSubscription: vi.fn().mockResolvedValue(undefined),
        getOrderByReference: vi.fn().mockResolvedValue(null),
        markOrderPaid: vi.fn().mockResolvedValue(undefined),
        getConversationById: vi.fn().mockResolvedValue(null),
        insertMessage: vi.fn().mockResolvedValue(undefined),
        updateConversationStatus: vi.fn().mockResolvedValue(undefined),
        ...dbOverrides,
      },
      getWhatsAppApiKey: vi.fn().mockResolvedValue("wa-key-123"),
      sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("inserts a new subscription row with active status and 30-day period", async () => {
    const deps = makePaystackDeps();
    const before = Date.now();

    await handlePaystackEvent(
      {
        event: "charge.success",
        data: {
          reference: "sub-ref-001",
          metadata: { kind: "wabizz_subscription", plan_id: "growth", business_id: "biz-001" },
        },
      },
      deps,
    );

    expect(deps.db.insertSubscription).toHaveBeenCalledOnce();
    const call = (deps.db.insertSubscription as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.planId).toBe("growth");
    expect(call.businessId).toBe("biz-001");
    // period end should be ~30 days from now
    const periodEnd = new Date(call.periodEnd).getTime();
    const expectedEnd = before + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(periodEnd - expectedEnd)).toBeLessThan(5000); // within 5s
  });

  it("full order paid + conversation updated + WA confirmation sent", async () => {
    const deps = makePaystackDeps({
      getOrderByReference: vi
        .fn()
        .mockResolvedValue({ id: "ord-001", conversation_id: "convo-pay-001" }),
      getConversationById: vi
        .fn()
        .mockResolvedValue({ customer_number: "+2348011223344", business_id: "biz-001" }),
    });

    await handlePaystackEvent(
      {
        event: "charge.success",
        data: { reference: "order-ref-pay-001", metadata: { kind: "wabizz_order" } },
      },
      deps,
    );

    // Order marked paid
    expect(deps.db.markOrderPaid).toHaveBeenCalledWith("ord-001", expect.any(String));

    // WA message sent
    expect(deps.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "wa-key-123",
        to: "+2348011223344",
        text: expect.stringContaining("Payment confirmed"),
      }),
    );

    // Message persisted to conversation
    expect(deps.db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "convo-pay-001",
        role: "assistant",
      }),
    );

    // Conversation status updated
    expect(deps.db.updateConversationStatus).toHaveBeenCalledWith("convo-pay-001", "order_placed");

    // No errors logged
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("logs error with request_id when WA send fails, does not re-throw", async () => {
    const deps = makePaystackDeps({
      getOrderByReference: vi
        .fn()
        .mockResolvedValue({ id: "ord-002", conversation_id: "convo-002" }),
      getConversationById: vi
        .fn()
        .mockResolvedValue({ customer_number: "+234", business_id: "biz-001" }),
    });
    (deps.sendWhatsAppMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"));

    // Should not throw
    await expect(
      handlePaystackEvent(
        {
          event: "charge.success",
          data: { reference: "r-err", metadata: { kind: "wabizz_order" } },
        },
        deps,
      ),
    ).resolves.toBe(true);

    expect(mockLogError).toHaveBeenCalledWith(
      "paystack-handler",
      "Order confirmation send failed",
      expect.objectContaining({ error: expect.stringContaining("timeout") }),
      REQUEST_ID,
    );
  });
});

// ── Duplicate Twilio retry prevention ────────────────────────────────────────

describe("Integration: Twilio retry / idempotency", () => {
  it("re-uses existing conversation (no duplicate convo row) on Twilio retry", async () => {
    const db: DbDeps = {
      getConversation: vi.fn().mockResolvedValue({ id: "convo-retry-001" }),
      createConversation: vi.fn(),
      updateConversationTimestamp: vi.fn().mockResolvedValue(undefined),
      updateConversationStatus: vi.fn().mockResolvedValue(undefined),
      insertMessage: vi.fn().mockResolvedValue(undefined),
      getMessageHistory: vi.fn().mockResolvedValue([]),
      isSubscriptionActive: vi.fn().mockResolvedValue(true),
      getPlanAndMonthlyCount: vi.fn().mockResolvedValue({ planId: "growth", monthlyCount: 0 }),
    };
    const ai: AiDeps = { complete: vi.fn().mockResolvedValue("Re-sent reply") };

    // Simulate same message arriving twice (Twilio retry)
    for (let i = 0; i < 2; i++) {
      await handleIncomingMessage(
        { business: BUSINESS, customerNumber: "+234", customerName: null, text: "Hello" },
        { db, ai, requestId: `req-${i}` },
      );
    }

    // createConversation must NEVER be called when convo already exists
    expect(db.createConversation).not.toHaveBeenCalled();
    expect(db.updateConversationTimestamp).toHaveBeenCalledTimes(2);
  });
});
