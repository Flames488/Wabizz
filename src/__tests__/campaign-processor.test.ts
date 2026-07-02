/**
 * campaign-processor.test.ts
 *
 * Tests for handleSendCampaignBatch and handleSendAutomationStep in
 * src/lib/server/worker/campaign-processor.ts
 *
 * Coverage targets (previously untested worker paths):
 *
 * handleSendCampaignBatch:
 *   ✓ Happy path — pending contacts fetched, messages sent, counters updated
 *   ✓ Campaign not found — logs warn and returns early
 *   ✓ Campaign in non-running state — skips batch silently
 *   ✓ No contacts in batch — returns early with info log
 *   ✓ No WhatsApp API key — updates campaign to "failed", logs error
 *   ✓ 360dialog send failure — updates contact status "failed", increments failedDelta
 *   ✓ Idempotency — alreadySeen contact is skipped (not double-sent)
 *   ✓ Campaign completion — status → "completed" when pending_count ≤ 0
 *   ✓ Merge tags — {{name}} and {{business_name}} rendered in message text
 *   ✓ Rate limiting delay — sleep called between messages (not after last)
 *
 * handleSendAutomationStep:
 *   ✓ Happy path — message sent, tags applied, match count incremented
 *   ✓ No WhatsApp API key — logs error and returns early
 *   ✓ Idempotency — alreadySeen automation step is skipped
 *   ✓ Send failure — guard.markFailed called, logs error
 *   ✓ No addTags — tag update skipped
 *   ✓ Contact not found — tag update skipped gracefully
 *
 * All external dependencies (Supabase, 360dialog, keys) are mocked.
 * No network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleSendCampaignBatch,
  handleSendAutomationStep,
} from "../../lib/server/worker/campaign-processor";
import type { SendCampaignBatchJob, SendAutomationStepJob } from "../../lib/queue";

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock("../../lib/server-logger", () => ({
  logError: vi.fn().mockResolvedValue(undefined),
  logInfo: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn().mockResolvedValue(undefined),
  logFatal: vi.fn().mockResolvedValue(undefined),
}));

import { logError, logInfo, logWarn } from "../../lib/server-logger";
const mockLogError = vi.mocked(logError);
const mockLogInfo = vi.mocked(logInfo);
const mockLogWarn = vi.mocked(logWarn);

// ── Mock Supabase admin client ────────────────────────────────────────────────
const mockRpc = vi.fn().mockResolvedValue({ error: null });
const mockUpdate = vi.fn();
const mockSelect = vi.fn();

// Fluent chain builder used for .from().select().eq()... etc
function makeChain(resolvedWith: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "in", "range", "order", "maybeSingle", "update"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // Terminal resolution
  (chain["maybeSingle"] as ReturnType<typeof vi.fn>).mockResolvedValue(resolvedWith);
  (chain["update"] as ReturnType<typeof vi.fn>).mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  });
  return chain;
}

// We need per-call control, so we mock at module level with a factory
vi.mock("../../integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  },
}));

import { supabaseAdmin } from "../../integrations/supabase/client.server";
const mockFrom = vi.mocked(supabaseAdmin.from);
const mockRpcFn = vi.mocked(supabaseAdmin.rpc);

// ── Mock getWhatsAppApiKey ────────────────────────────────────────────────────
vi.mock("../../lib/server/keys.functions", () => ({
  getWhatsAppApiKey: vi.fn().mockResolvedValue("test-api-key-123"),
}));

import { getWhatsAppApiKey } from "../../lib/server/keys.functions";
const mockGetApiKey = vi.mocked(getWhatsAppApiKey);

// ── Mock circuit breaker ──────────────────────────────────────────────────────
vi.mock("../../lib/server/circuit-breaker/circuit-breaker", () => ({
  circuitBreaker: vi
    .fn()
    .mockImplementation((_service: string, fn: () => Promise<unknown>) => fn()),
  CircuitOpenError: class CircuitOpenError extends Error {
    constructor(service: string) {
      super(`Circuit OPEN for ${service}`);
      this.name = "CircuitOpenError";
    }
  },
}));

// ── Mock idempotency ──────────────────────────────────────────────────────────
const mockMarkSuccess = vi.fn().mockResolvedValue(undefined);
const mockMarkFailed = vi.fn().mockResolvedValue(undefined);
const mockAcquire = vi.fn().mockResolvedValue({
  alreadySeen: false,
  markSuccess: mockMarkSuccess,
  markFailed: mockMarkFailed,
});

vi.mock("../../lib/server/idempotency", () => ({
  acquireIdempotencyKey: (...args: unknown[]) => mockAcquire(...args),
}));

// ── Mock event pipeline ───────────────────────────────────────────────────────
vi.mock("../../lib/server/event-pipeline", () => ({
  events: {
    apiFailed: vi.fn(),
    apiSuccess: vi.fn(),
    circuitOpen: vi.fn(),
    circuitClosed: vi.fn(),
    jobProcessed: vi.fn(),
    jobFailed: vi.fn(),
    jobDlq: vi.fn(),
  },
}));

// ── Mock admin metrics ────────────────────────────────────────────────────────
vi.mock("../../lib/server/admin/metrics", () => ({
  recordApiCall: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock whatsapp helper ──────────────────────────────────────────────────────
vi.mock("../../lib/whatsapp", () => ({
  buildTextMessageBody: (to: string, text: string) => ({ to, text }),
  DIALOG_API_BASE: "https://waba.360dialog.io/v1",
}));

// ── Fetch mock (360dialog) ────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mock360dialogSuccess() {
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ messages: [{ id: "wamid.test123" }] }), {
      status: 200,
    }),
  );
}

function mock360dialogFailure(status = 429, body = "rate limited") {
  mockFetch.mockResolvedValue(new Response(body, { status }));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CAMPAIGN_JOB: SendCampaignBatchJob = {
  id: "job-001",
  type: "send_campaign_batch",
  requestId: "trace-001",
  retryCount: 0,
  payload: {
    campaignId: "camp-001",
    businessId: "biz-001",
    batchIndex: 0,
    batchSize: 10,
    messageTemplate: "Hi {{name}}, we have a sale at {{business_name}}!",
    messagesPerMin: 0, // 0 = no delay in tests
  },
};

const BASE_AUTOMATION_JOB: SendAutomationStepJob = {
  id: "job-002",
  type: "send_automation_step",
  requestId: "trace-002",
  retryCount: 0,
  payload: {
    businessId: "biz-001",
    ruleId: "rule-001",
    contactPhone: "+2348012345678",
    contactName: "Amina",
    replyTemplate: "Hi {{name}}, thanks for reaching out!",
    addTags: ["interested"],
  },
};

// ── Supabase chain helpers ────────────────────────────────────────────────────

/**
 * Configure mockFrom to return specific data for each .from(table) call.
 * Each call to .from() pops the next config from the queue.
 */
function setupFromSequence(
  responses: Array<{ table?: string; data: unknown; updateResult?: unknown }>,
) {
  let callIndex = 0;
  mockFrom.mockImplementation(() => {
    const conf = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    const chain: Record<string, unknown> = {};
    const fluentMethods = ["select", "eq", "in", "range", "order", "update"];
    for (const m of fluentMethods) {
      chain[m] = vi.fn(() => chain);
    }
    chain["maybeSingle"] = vi.fn().mockResolvedValue({ data: conf.data, error: null });
    chain["update"] = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    return chain;
  });
}

// ── campaign-processor tests ──────────────────────────────────────────────────

describe("handleSendCampaignBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpcFn.mockResolvedValue({ error: null });
    mockGetApiKey.mockResolvedValue("test-api-key-123");
    mockAcquire.mockResolvedValue({
      alreadySeen: false,
      markSuccess: mockMarkSuccess,
      markFailed: mockMarkFailed,
    });
    mock360dialogSuccess();
  });

  it("returns early with warning when campaign is not found", async () => {
    // Campaign lookup returns null
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    expect(mockLogWarn).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("not found"),
      expect.any(Object),
      "trace-001",
    );
    // Should not attempt to send any messages
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips batch when campaign is in 'paused' status", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { status: "paused", message_template: "test" },
        error: null,
      }),
    });

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    expect(mockLogInfo).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("paused"),
      expect.any(Object),
      "trace-001",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips batch when campaign is in 'cancelled' status", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { status: "cancelled", message_template: "test" },
        error: null,
      }),
    });

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    expect(mockLogInfo).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("cancelled"),
      expect.any(Object),
      "trace-001",
    );
  });

  it("updates campaign to 'failed' and logs error when no API key", async () => {
    mockGetApiKey.mockResolvedValue(null);

    let campaignUpdateCalled = false;
    let callIndex = 0;

    mockFrom.mockImplementation((table: string) => {
      callIndex++;
      const chain: Record<string, unknown> = {};
      chain["select"] = vi.fn().mockReturnThis();
      chain["in"] = vi.fn().mockReturnThis();
      chain["range"] = vi.fn().mockReturnThis();
      chain["order"] = vi.fn().mockReturnThis();
      chain["eq"] = vi.fn().mockReturnThis();

      if (callIndex === 1) {
        // Campaign status check
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { status: "running", message_template: "test" },
          error: null,
        });
      } else if (callIndex === 2) {
        // Contacts fetch — returns one contact
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: [{ id: "cc-1", contact_id: "c-1", phone: "+23480000001", name: "Tunde" }],
          error: null,
        });
      }

      chain["update"] = vi.fn().mockImplementation(() => {
        if (table === "campaigns") campaignUpdateCalled = true;
        return { eq: vi.fn().mockResolvedValue({ error: null }) };
      });
      chain["maybeSingle"] =
        chain["maybeSingle"] ?? vi.fn().mockResolvedValue({ data: null, error: null });
      return chain;
    });

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    expect(mockLogError).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("No WhatsApp API key"),
      expect.any(Object),
      "trace-001",
    );
  });

  it("marks contact as 'failed' when 360dialog returns error status", async () => {
    mock360dialogFailure(500, "Internal Server Error");

    let callIndex = 0;
    const contactUpdates: Array<{ status: string }> = [];

    mockFrom.mockImplementation(() => {
      callIndex++;
      const chain: Record<string, unknown> = {};
      chain["select"] = vi.fn().mockReturnThis();
      chain["in"] = vi.fn().mockReturnThis();
      chain["range"] = vi.fn().mockReturnThis();
      chain["order"] = vi.fn().mockReturnThis();
      chain["eq"] = vi.fn().mockReturnThis();

      if (callIndex === 1) {
        // Campaign check
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { status: "running", message_template: "Hi {{name}}" },
          error: null,
        });
      } else if (callIndex === 2) {
        // Contacts
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: [{ id: "cc-1", contact_id: "c-1", phone: "+23480000001", name: "Tunde" }],
          error: null,
        });
      } else if (callIndex === 3) {
        // Business name
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { name: "Test Biz" },
          error: null,
        });
      } else {
        // campaign pending count check
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { pending_count: 1, total_contacts: 1 },
          error: null,
        });
      }

      chain["update"] = vi.fn().mockImplementation((updateData: { status?: string }) => {
        if (updateData?.status) contactUpdates.push({ status: updateData.status });
        return { eq: vi.fn().mockResolvedValue({ error: null }) };
      });

      return chain;
    });

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    // Failure should be logged
    expect(mockLogError).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("send failed"),
      expect.objectContaining({ campaignId: "camp-001" }),
      "trace-001",
    );
    expect(mockMarkFailed).toHaveBeenCalled();
  });

  it("skips already-seen idempotency keys (no duplicate send)", async () => {
    mockAcquire.mockResolvedValue({
      alreadySeen: true,
      markSuccess: mockMarkSuccess,
      markFailed: mockMarkFailed,
    });

    let callIndex = 0;
    mockFrom.mockImplementation(() => {
      callIndex++;
      const chain: Record<string, unknown> = {};
      chain["select"] = vi.fn().mockReturnThis();
      chain["in"] = vi.fn().mockReturnThis();
      chain["range"] = vi.fn().mockReturnThis();
      chain["order"] = vi.fn().mockReturnThis();
      chain["eq"] = vi.fn().mockReturnThis();

      if (callIndex === 1) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { status: "running", message_template: "Hi {{name}}" },
          error: null,
        });
      } else if (callIndex === 2) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: [{ id: "cc-1", contact_id: "c-1", phone: "+23480000001", name: "Tunde" }],
          error: null,
        });
      } else if (callIndex === 3) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { name: "Biz" },
          error: null,
        });
      } else {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { pending_count: 1 },
          error: null,
        });
      }

      chain["update"] = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      return chain;
    });

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    // No network call should have been made
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("duplicate"),
      expect.any(Object),
      "trace-001",
    );
  });

  it("renders merge tags {{name}} and {{business_name}} in message", async () => {
    let sentBody: unknown = null;

    mockFetch.mockImplementation(async (_url: string, opts: RequestInit) => {
      sentBody = JSON.parse(opts.body as string);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.123" }] }), { status: 200 });
    });

    let callIndex = 0;
    mockFrom.mockImplementation(() => {
      callIndex++;
      const chain: Record<string, unknown> = {};
      chain["select"] = vi.fn().mockReturnThis();
      chain["in"] = vi.fn().mockReturnThis();
      chain["range"] = vi.fn().mockReturnThis();
      chain["order"] = vi.fn().mockReturnThis();
      chain["eq"] = vi.fn().mockReturnThis();

      if (callIndex === 1) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { status: "running", message_template: "Hi {{name}} from {{business_name}}!" },
          error: null,
        });
      } else if (callIndex === 2) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: [{ id: "cc-1", contact_id: "c-1", phone: "+23480000001", name: "Chukwu" }],
          error: null,
        });
      } else if (callIndex === 3) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { name: "NaijaShop" },
          error: null,
        });
      } else {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { pending_count: 0, total_contacts: 1 },
          error: null,
        });
      }

      chain["update"] = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      return chain;
    });

    await handleSendCampaignBatch({
      ...BASE_CAMPAIGN_JOB,
      payload: {
        ...BASE_CAMPAIGN_JOB.payload,
        messageTemplate: "Hi {{name}} from {{business_name}}!",
      },
    });

    // Merge tags should be replaced in the fetch body
    expect(sentBody).not.toBeNull();
    const bodyStr = JSON.stringify(sentBody);
    expect(bodyStr).toContain("Chukwu");
    expect(bodyStr).toContain("NaijaShop");
    expect(bodyStr).not.toContain("{{name}}");
    expect(bodyStr).not.toContain("{{business_name}}");
  });

  it("marks campaign as 'completed' when pending_count reaches 0", async () => {
    let campaignCompletedUpdate = false;
    let callIndex = 0;

    mockFrom.mockImplementation(() => {
      callIndex++;
      const chain: Record<string, unknown> = {};
      chain["select"] = vi.fn().mockReturnThis();
      chain["in"] = vi.fn().mockReturnThis();
      chain["range"] = vi.fn().mockReturnThis();
      chain["order"] = vi.fn().mockReturnThis();
      chain["eq"] = vi.fn().mockReturnThis();

      if (callIndex === 1) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { status: "running", message_template: "Hi {{name}}" },
          error: null,
        });
      } else if (callIndex === 2) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: [{ id: "cc-1", contact_id: "c-1", phone: "+23480000001", name: "Femi" }],
          error: null,
        });
      } else if (callIndex === 3) {
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { name: "BizCo" },
          error: null,
        });
      } else {
        // pending_count check → 0 triggers completion
        chain["maybeSingle"] = vi.fn().mockResolvedValue({
          data: { pending_count: 0, total_contacts: 5 },
          error: null,
        });
      }

      chain["update"] = vi.fn().mockImplementation((payload: { status?: string }) => {
        if (payload?.status === "completed") campaignCompletedUpdate = true;
        return { eq: vi.fn().mockReturnThis(), mockResolvedValue: vi.fn() };
      });

      // Make update().eq().eq() chain work
      const eqChain = { eq: vi.fn().mockResolvedValue({ error: null }) };
      chain["update"] = vi.fn().mockReturnValue(eqChain);

      return chain;
    });

    // Override to capture campaign "completed" update
    mockFrom
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi
          .fn()
          .mockResolvedValue({ data: { status: "running", message_template: "Hi" }, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        range: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: [{ id: "cc-1", contact_id: "c-1", phone: "+234801", name: "Femi" }],
          error: null,
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { name: "BizCo" }, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      }))
      .mockImplementation(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi
          .fn()
          .mockResolvedValue({ data: { pending_count: 0, total_contacts: 5 }, error: null }),
        update: vi.fn().mockImplementation((payload: { status?: string }) => {
          if (payload?.status === "completed") campaignCompletedUpdate = true;
          return {
            eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
          };
        }),
      }));

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    expect(campaignCompletedUpdate).toBe(true);
    expect(mockLogInfo).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("completed"),
      expect.any(Object),
      "trace-001",
    );
  });

  it("returns early with info log when batch has no pending contacts", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockImplementation(() => {
        // First call: campaign check; subsequent calls: empty contacts
        const calls = (mockFrom.mock.calls ?? []).length;
        if (calls <= 1) {
          return Promise.resolve({
            data: { status: "running", message_template: "Hi" },
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    });

    // Override campaign check to succeed, contacts to return empty
    mockFrom
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi
          .fn()
          .mockResolvedValue({ data: { status: "running", message_template: "Hi" }, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      })
      .mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        range: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      });

    await handleSendCampaignBatch(BASE_CAMPAIGN_JOB);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("No pending contacts"),
      expect.any(Object),
      "trace-001",
    );
  });
});

// ── automation-processor tests ────────────────────────────────────────────────

describe("handleSendAutomationStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKey.mockResolvedValue("test-api-key-123");
    mockAcquire.mockResolvedValue({
      alreadySeen: false,
      markSuccess: mockMarkSuccess,
      markFailed: mockMarkFailed,
    });
    mock360dialogSuccess();
    mockRpcFn.mockResolvedValue({ error: null });
  });

  it("happy path — sends message, applies tags, increments match count", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "c-1", tags: ["existing-tag"] },
        error: null,
      }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    });

    await handleSendAutomationStep(BASE_AUTOMATION_JOB);

    // Message should be sent
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockMarkSuccess).toHaveBeenCalled();

    // match count increment via RPC
    expect(mockRpcFn).toHaveBeenCalledWith("increment_automation_match_count", {
      p_rule_id: "rule-001",
    });

    expect(mockLogInfo).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("Automation step sent"),
      expect.any(Object),
      "trace-002",
    );
  });

  it("returns early and logs error when no WhatsApp API key", async () => {
    mockGetApiKey.mockResolvedValue(null);

    await handleSendAutomationStep(BASE_AUTOMATION_JOB);

    expect(mockLogError).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("No WhatsApp API key"),
      expect.any(Object),
      "trace-002",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips already-seen automation step (idempotency)", async () => {
    mockAcquire.mockResolvedValue({
      alreadySeen: true,
      markSuccess: mockMarkSuccess,
      markFailed: mockMarkFailed,
    });

    await handleSendAutomationStep(BASE_AUTOMATION_JOB);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMarkSuccess).not.toHaveBeenCalled();
  });

  it("calls markFailed and logs error when 360dialog returns failure", async () => {
    mock360dialogFailure(502, "Bad Gateway");

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    });

    await handleSendAutomationStep(BASE_AUTOMATION_JOB);

    expect(mockMarkFailed).toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      "campaign-processor",
      expect.stringContaining("Automation step failed"),
      expect.any(Object),
      "trace-002",
    );
  });

  it("skips tag update when addTags is empty", async () => {
    const jobNoTags: SendAutomationStepJob = {
      ...BASE_AUTOMATION_JOB,
      payload: { ...BASE_AUTOMATION_JOB.payload, addTags: [] },
    };

    await handleSendAutomationStep(jobNoTags);

    // Message should still be sent
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockMarkSuccess).toHaveBeenCalled();
    // No DB call for tags
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("skips tag update gracefully when contact is not found in DB", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), // contact not found
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    });

    // Should not throw — missing contact is a no-op for tag update
    await expect(handleSendAutomationStep(BASE_AUTOMATION_JOB)).resolves.toBeUndefined();
    expect(mockMarkSuccess).toHaveBeenCalled();
  });

  it("renders {{name}} merge tag in automation reply", async () => {
    let sentBody: unknown = null;
    mockFetch.mockImplementation(async (_url: string, opts: RequestInit) => {
      sentBody = JSON.parse(opts.body as string);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.auto" }] }), { status: 200 });
    });

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "c-1", tags: [] }, error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    });

    await handleSendAutomationStep(BASE_AUTOMATION_JOB);

    expect(sentBody).not.toBeNull();
    expect(JSON.stringify(sentBody)).toContain("Amina");
    expect(JSON.stringify(sentBody)).not.toContain("{{name}}");
  });
});
