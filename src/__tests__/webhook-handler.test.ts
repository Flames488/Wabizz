/**
 * webhook-handler.test.ts
 *
 * Tests for handleIncomingMessage and handlePaystackEvent.
 * All external dependencies (DB, AI) are injected mocks — no network calls.
 *
 * Covers:
 *   - Happy path: new conversation, new message, AI reply persisted
 *   - Existing conversation: timestamp update, no duplicate insert
 *   - AI failure: falls back to default reply, logs error with request_id
 *   - DB failure on conversation create: returns empty string
 *   - Paystack charge.success subscription activation (new + existing reference)
 *   - Paystack charge.success order payment + WA confirmation send
 *   - Non charge.success events are silently ignored
 *   - logError always called with request_id on error paths
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleIncomingMessage,
  handlePaystackEvent,
  buildSystemPrompt,
} from "../../lib/server/twilio-handler";
import type {
  IncomingMessagePayload,
  IncomingMessageDeps,
  DbDeps,
  AiDeps,
  PaystackDeps,
  BusinessProfile,
} from "../../lib/server/twilio-handler";

// ── Mock server-logger ───────────────────────────────────────────────────────
// FIX BUG 5: mock ALL exported logger functions, not just logError.
// twilio-handler.ts calls logInfo and logWarn on the happy path (e.g.
// "Auto-reply sent", "Conversation escalated"). Without these mocks the
// test suite crashes with "undefined is not a function" on those paths.

vi.mock("../../lib/server-logger", () => ({
  logError: vi.fn().mockResolvedValue(undefined),
  logInfo: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn().mockResolvedValue(undefined),
  logFatal: vi.fn().mockResolvedValue(undefined),
}));

import { logError } from "../../lib/server-logger";
const mockLogError = vi.mocked(logError);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REQUEST_ID = "test-request-id-1234";

const BUSINESS: BusinessProfile = {
  id: "biz-001",
  name: "Mama's Kitchen",
  type: "food",
  products_list: "Jollof Rice ₦1500\nEgusi Soup ₦2000",
  open_time: "08:00",
  close_time: "22:00",
  tone: "Friendly",
  custom_message: null,
};

function makePayload(overrides?: Partial<IncomingMessagePayload>): IncomingMessagePayload {
  return {
    business: BUSINESS,
    customerNumber: "+2348012345678",
    customerName: "Ada",
    text: "Hello, what do you sell?",
    ...overrides,
  };
}

function makeMockDb(overrides?: Partial<DbDeps>): DbDeps {
  return {
    getConversation: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockResolvedValue({ id: "convo-001" }),
    updateConversationTimestamp: vi.fn().mockResolvedValue(undefined),
    updateConversationStatus: vi.fn().mockResolvedValue(undefined),
    insertMessage: vi.fn().mockResolvedValue(undefined),
    getMessageHistory: vi
      .fn()
      .mockResolvedValue([{ role: "user", content: "Hello, what do you sell?" }]),
    isSubscriptionActive: vi.fn().mockResolvedValue(true),
    // FIX BUG 2: DbDeps now requires getPlanAndMonthlyCount for plan limit
    // enforcement. Without it, TypeScript strict mode refuses to compile and
    // the entire test suite crashes before a single test runs.
    getPlanAndMonthlyCount: vi.fn().mockResolvedValue({ planId: "growth", monthlyCount: 0 }),
    ...overrides,
  };
}

function makeMockAi(reply: string | null = "We sell Jollof Rice and Egusi Soup! 😊"): AiDeps {
  return {
    complete: vi.fn().mockResolvedValue(reply),
  };
}

function makeDeps(dbOverrides?: Partial<DbDeps>, aiReply?: string | null): IncomingMessageDeps {
  return {
    db: makeMockDb(dbOverrides),
    ai: makeMockAi(aiReply),
    requestId: REQUEST_ID,
  };
}

// ── handleIncomingMessage tests ───────────────────────────────────────────────

describe("handleIncomingMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new conversation when none exists", async () => {
    const deps = makeDeps();
    await handleIncomingMessage(makePayload(), deps);

    expect(deps.db.getConversation).toHaveBeenCalledWith("biz-001", "+2348012345678");
    expect(deps.db.createConversation).toHaveBeenCalledWith({
      businessId: "biz-001",
      customerNumber: "+2348012345678",
      customerName: "Ada",
    });
    expect(deps.db.updateConversationTimestamp).not.toHaveBeenCalled();
  });

  it("updates timestamp on an existing conversation (no duplicate insert)", async () => {
    const deps = makeDeps({ getConversation: vi.fn().mockResolvedValue({ id: "convo-existing" }) });
    await handleIncomingMessage(makePayload(), deps);

    expect(deps.db.createConversation).not.toHaveBeenCalled();
    expect(deps.db.updateConversationTimestamp).toHaveBeenCalledWith("convo-existing", "Ada");
  });

  it("inserts the user message before calling AI", async () => {
    const insertOrder: string[] = [];
    const db = makeMockDb({
      insertMessage: vi.fn().mockImplementation(({ role }) => {
        insertOrder.push(role);
        return Promise.resolve();
      }),
    });
    const ai: AiDeps = {
      complete: vi.fn().mockImplementation(async () => {
        // AI called after user message insert
        return "AI reply";
      }),
    };

    await handleIncomingMessage(makePayload(), { db, ai, requestId: REQUEST_ID });

    expect(insertOrder[0]).toBe("user");
    expect(insertOrder[1]).toBe("assistant");
    expect(ai.complete).toHaveBeenCalledOnce();
  });

  it("returns the AI reply and persists it as assistant message", async () => {
    const deps = makeDeps();
    const result = await handleIncomingMessage(makePayload(), deps);

    expect(result).toBe("We sell Jollof Rice and Egusi Soup! 😊");
    expect(deps.db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "We sell Jollof Rice and Egusi Soup! 😊",
      }),
    );
  });

  it("falls back to default reply when AI returns null", async () => {
    const deps = makeDeps(undefined, null);
    const result = await handleIncomingMessage(makePayload(), deps);

    expect(result).toBe("Thanks for your message! We'll get back to you shortly.");
    expect(deps.db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
    );
  });

  it("returns empty string when conversation creation fails", async () => {
    const deps = makeDeps({ createConversation: vi.fn().mockResolvedValue(null) });
    const result = await handleIncomingMessage(makePayload(), deps);

    expect(result).toBe("");
    expect(mockLogError).toHaveBeenCalledWith(
      "twilio-handler",
      "Conversation create failed",
      expect.objectContaining({ businessId: "biz-001" }),
      REQUEST_ID,
    );
  });

  it("passes request_id to logError on conversation create failure", async () => {
    const deps = makeDeps({ createConversation: vi.fn().mockResolvedValue(null) });
    await handleIncomingMessage(makePayload(), deps);

    const [, , , requestId] = mockLogError.mock.calls[0];
    expect(requestId).toBe(REQUEST_ID);
  });

  it("fetches message history using the default limit (no override argument)", async () => {
    const deps = makeDeps();
    await handleIncomingMessage(makePayload(), deps);

    // twilio-handler calls getMessageHistory with no limit arg so the
    // DbDeps implementation uses its own default (MESSAGE_HISTORY_LIMIT = 20).
    expect(deps.db.getMessageHistory).toHaveBeenCalledWith("convo-001");
  });

  it("handles null customerName gracefully", async () => {
    const deps = makeDeps();
    const result = await handleIncomingMessage(makePayload({ customerName: null }), deps);
    expect(result).toBeTruthy();
    expect(deps.db.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ customerName: null }),
    );
  });
});

// ── buildSystemPrompt tests ───────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("includes business name and type", () => {
    const prompt = buildSystemPrompt(BUSINESS);
    expect(prompt).toContain("Mama's Kitchen");
    expect(prompt).toContain("food");
  });

  it("includes products list", () => {
    const prompt = buildSystemPrompt(BUSINESS);
    expect(prompt).toContain("Jollof Rice");
  });

  it("includes business hours", () => {
    const prompt = buildSystemPrompt(BUSINESS);
    expect(prompt).toContain("08:00");
    expect(prompt).toContain("22:00");
  });

  it("appends custom_message when present", () => {
    const prompt = buildSystemPrompt({ ...BUSINESS, custom_message: "Always upsell drinks" });
    expect(prompt).toContain("Always upsell drinks");
  });

  it("omits custom_message section when null", () => {
    const prompt = buildSystemPrompt({ ...BUSINESS, custom_message: null });
    expect(prompt).not.toContain("Always remember:");
  });
});

// ── handlePaystackEvent tests ─────────────────────────────────────────────────

function makePaystackDeps(overrides?: Partial<PaystackDeps["db"]>): PaystackDeps {
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
      ...overrides,
    },
    getWhatsAppApiKey: vi.fn().mockResolvedValue("test-wa-key"),
    sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("handlePaystackEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false and takes no action for non-charge.success events", async () => {
    const deps = makePaystackDeps();
    const result = await handlePaystackEvent({ event: "transfer.success" }, deps);
    expect(result).toBe(false);
    expect(deps.db.insertSubscription).not.toHaveBeenCalled();
  });

  it("returns false for missing event", async () => {
    const deps = makePaystackDeps();
    const result = await handlePaystackEvent({}, deps);
    expect(result).toBe(false);
  });

  it("inserts a new subscription on charge.success for wabizz_subscription (no existing)", async () => {
    const deps = makePaystackDeps();
    const result = await handlePaystackEvent(
      {
        event: "charge.success",
        data: {
          reference: "ref-001",
          metadata: {
            kind: "wabizz_subscription",
            plan_id: "growth",
            business_id: "biz-001",
          },
        },
      },
      deps,
    );

    expect(result).toBe(true);
    expect(deps.db.getSubscriptionByReference).toHaveBeenCalledWith("ref-001");
    expect(deps.db.insertSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-001",
        planId: "growth",
        reference: "ref-001",
      }),
    );
    expect(deps.db.updateSubscriptionToActive).not.toHaveBeenCalled();
  });

  it("updates existing subscription on charge.success for wabizz_subscription", async () => {
    const deps = makePaystackDeps({
      getSubscriptionByReference: vi.fn().mockResolvedValue({ id: "sub-existing" }),
    });
    const result = await handlePaystackEvent(
      {
        event: "charge.success",
        data: {
          reference: "ref-dup",
          metadata: { kind: "wabizz_subscription", plan_id: "pro", business_id: "biz-001" },
        },
      },
      deps,
    );

    expect(result).toBe(true);
    expect(deps.db.updateSubscriptionToActive).toHaveBeenCalledWith(
      "sub-existing",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
    );
    expect(deps.db.insertSubscription).not.toHaveBeenCalled();
  });

  it("marks order paid on charge.success for wabizz_order", async () => {
    const deps = makePaystackDeps({
      getOrderByReference: vi.fn().mockResolvedValue({ id: "order-001", conversation_id: null }),
    });
    const result = await handlePaystackEvent(
      {
        event: "charge.success",
        data: {
          reference: "order-ref-001",
          metadata: { kind: "wabizz_order" },
        },
      },
      deps,
    );

    expect(result).toBe(true);
    expect(deps.db.markOrderPaid).toHaveBeenCalledWith("order-001", expect.any(String));
  });

  it("sends WhatsApp confirmation when order has a conversation", async () => {
    const deps = makePaystackDeps({
      getOrderByReference: vi
        .fn()
        .mockResolvedValue({ id: "order-002", conversation_id: "convo-001" }),
      getConversationById: vi
        .fn()
        .mockResolvedValue({ customer_number: "+234801", business_id: "biz-001" }),
    });

    await handlePaystackEvent(
      {
        event: "charge.success",
        data: { reference: "r", metadata: { kind: "wabizz_order" } },
      },
      deps,
    );

    expect(deps.getWhatsAppApiKey).toHaveBeenCalledWith("biz-001");
    expect(deps.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-wa-key", to: "+234801" }),
    );
    expect(deps.db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", conversationId: "convo-001" }),
    );
    expect(deps.db.updateConversationStatus).toHaveBeenCalledWith("convo-001", "order_placed");
  });

  it("skips WhatsApp send when no API key found", async () => {
    const deps = makePaystackDeps({
      getOrderByReference: vi
        .fn()
        .mockResolvedValue({ id: "order-003", conversation_id: "convo-002" }),
      getConversationById: vi
        .fn()
        .mockResolvedValue({ customer_number: "+234802", business_id: "biz-002" }),
    });
    (deps.getWhatsAppApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await handlePaystackEvent(
      {
        event: "charge.success",
        data: { reference: "r2", metadata: { kind: "wabizz_order" } },
      },
      deps,
    );

    expect(deps.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("logs error with request_id when WhatsApp send throws", async () => {
    const deps = makePaystackDeps({
      getOrderByReference: vi
        .fn()
        .mockResolvedValue({ id: "order-004", conversation_id: "convo-003" }),
      getConversationById: vi
        .fn()
        .mockResolvedValue({ customer_number: "+234803", business_id: "biz-001" }),
    });
    (deps.sendWhatsAppMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );

    await handlePaystackEvent(
      {
        event: "charge.success",
        data: { reference: "r3", metadata: { kind: "wabizz_order" } },
      },
      deps,
    );

    expect(mockLogError).toHaveBeenCalledWith(
      "paystack-handler",
      "Order confirmation send failed",
      expect.objectContaining({ error: expect.stringContaining("network error") }),
      REQUEST_ID,
    );
  });

  it("returns false for unknown kind metadata", async () => {
    const deps = makePaystackDeps();
    const result = await handlePaystackEvent(
      {
        event: "charge.success",
        data: { reference: "r4", metadata: { kind: "unknown_type" } },
      },
      deps,
    );
    expect(result).toBe(false);
  });
});
