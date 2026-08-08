/**
 * error-handler.test.ts
 *
 * Tests for:
 *   - WabizzError construction and factory methods
 *   - withErrorHandling() wrapper: success, WabizzError, unexpected error
 *   - Correct log level routing (error vs fatal)
 *   - Client message never leaks internal message on fatal errors
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock server-logger ───────────────────────────────────────────────────────
vi.mock("../lib/server-logger", () => ({
  logError: vi.fn().mockResolvedValue(undefined),
  logFatal: vi.fn().mockResolvedValue(undefined),
  logInfo: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn().mockResolvedValue(undefined),
}));

import { logError, logFatal } from "../lib/server-logger";
import { WabizzError, withErrorHandling } from "../lib/server/error-handler";

const mockLogError = vi.mocked(logError);
const mockLogFatal = vi.mocked(logFatal);

const REQUEST_ID = "test-req-error-handler";

describe("WabizzError", () => {
  it("constructs with correct properties", () => {
    const err = new WabizzError("NOT_FOUND", "Internal: user not found", "User not found.", {
      userId: "u123",
    });
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Internal: user not found");
    expect(err.clientMessage).toBe("User not found.");
    expect(err.context).toEqual({ userId: "u123" });
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("WabizzError");
  });

  it("notFound factory sets correct code and message", () => {
    const err = WabizzError.notFound("Business");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.clientMessage).toContain("Business");
  });

  it("unauthorized factory", () => {
    const err = WabizzError.unauthorized();
    expect(err.code).toBe("UNAUTHORIZED");
  });

  it("subscriptionRequired factory", () => {
    const err = WabizzError.subscriptionRequired();
    expect(err.code).toBe("SUBSCRIPTION_REQUIRED");
    expect(err.clientMessage).toContain("subscription");
  });

  it("externalApi factory includes service context", () => {
    const err = WabizzError.externalApi("Paystack", "timeout");
    expect(err.code).toBe("EXTERNAL_API_ERROR");
    expect(err.context.service).toBe("Paystack");
    expect(err.context.detail).toBe("timeout");
  });

  it("db factory includes operation context", () => {
    const err = WabizzError.db("getSubscription", "connection refused");
    expect(err.code).toBe("DB_ERROR");
    expect(err.context.operation).toBe("getSubscription");
  });
});

describe("withErrorHandling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns handler result on success (no error)", async () => {
    const result = await withErrorHandling("test", REQUEST_ID, async () => ({
      ok: true as const,
      data: "hello",
    }));
    expect(result).toEqual({ ok: true, data: "hello" });
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockLogFatal).not.toHaveBeenCalled();
  });

  it("catches WabizzError, logs at error level, returns clientMessage", async () => {
    const result = await withErrorHandling("test", REQUEST_ID, async () => {
      throw new WabizzError("NOT_FOUND", "Internal DB: row missing", "Resource not found.");
    });

    expect(result).toEqual({ ok: false, error: "Resource not found." });
    expect(mockLogError).toHaveBeenCalledWith(
      "test",
      "Internal DB: row missing",
      expect.objectContaining({ code: "NOT_FOUND" }),
      REQUEST_ID,
    );
    expect(mockLogFatal).not.toHaveBeenCalled();
  });

  it("WabizzError without clientMessage falls back to message", async () => {
    const result = await withErrorHandling("test", REQUEST_ID, async () => {
      throw new WabizzError("DB_ERROR", "Connection refused");
    });
    expect(result).toEqual({ ok: false, error: "Connection refused" });
  });

  it("catches unexpected Error, logs fatal, returns generic message", async () => {
    const result = await withErrorHandling("test", REQUEST_ID, async () => {
      throw new Error("Unhandled TypeError: cannot read property of undefined");
    });

    expect(result).toEqual({
      ok: false,
      error: "An unexpected error occurred. Please try again.",
    });
    expect(mockLogFatal).toHaveBeenCalledWith(
      "test",
      "Unexpected server error",
      expect.objectContaining({
        error: "Unhandled TypeError: cannot read property of undefined",
      }),
      REQUEST_ID,
    );
    // Internal error message must NOT be returned to client
    const returned = result as { ok: false; error: string };
    expect(returned.error).not.toContain("TypeError");
  });

  it("catches non-Error throws (strings, objects)", async () => {
    const result = await withErrorHandling("test", REQUEST_ID, async () => {
      throw "something went wrong";
    });
    expect(result).toEqual({
      ok: false,
      error: "An unexpected error occurred. Please try again.",
    });
    expect(mockLogFatal).toHaveBeenCalled();
  });

  it("propagates async rejections correctly", async () => {
    const asyncOp = async () => {
      await Promise.resolve(); // yield
      throw WabizzError.subscriptionRequired();
    };

    const result = await withErrorHandling("test", REQUEST_ID, asyncOp);
    expect(result).toEqual({
      ok: false,
      error: "Your subscription has expired. Visit Pricing to continue.",
    });
  });
});

// ── Validation schema tests ───────────────────────────────────────────────────

import {
  validateInput,
  BusinessSchema,
  PhoneSchema,
  TimeSchema,
  PlanIdSchema,
} from "../lib/server/validation";

describe("validateInput", () => {
  it("returns parsed value on success", () => {
    const result = validateInput(PlanIdSchema, "growth");
    expect(result).toBe("growth");
  });

  it("throws WabizzError with VALIDATION_ERROR code on failure", () => {
    let caught: unknown = null;
    try {
      validateInput(PlanIdSchema, "enterprise");
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof WabizzError).toBe(true);
    const err = caught as WabizzError;
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("includes field name in error message", () => {
    let caught: WabizzError | null = null;
    try {
      validateInput(BusinessSchema, {
        name: "",
        type: "food",
        email: "test@test.com",
        whatsapp: "+2348012345678",
        open_time: "09:00",
        close_time: "20:00",
      });
    } catch (e) {
      caught = e as WabizzError;
    }
    expect(caught?.message).toContain("name");
  });
});

describe("TimeSchema", () => {
  it("accepts valid times", () => {
    expect(TimeSchema.parse("09:00")).toBe("09:00");
    expect(TimeSchema.parse("23:59")).toBe("23:59");
    expect(TimeSchema.parse("00:00")).toBe("00:00");
  });

  it("rejects invalid formats", () => {
    expect(() => TimeSchema.parse("9:00")).toThrow();
    expect(() => TimeSchema.parse("9am")).toThrow();
    expect(() => TimeSchema.parse("24:00")).toThrow();
    expect(() => TimeSchema.parse("09:60")).toThrow();
  });
});

describe("PhoneSchema", () => {
  it("accepts Nigerian numbers", () => {
    expect(PhoneSchema.parse("+2348012345678")).toBe("+2348012345678");
    expect(PhoneSchema.parse("08012345678")).toBe("08012345678");
  });

  it("rejects clearly invalid phones", () => {
    expect(() => PhoneSchema.parse("abc")).toThrow();
    expect(() => PhoneSchema.parse("12")).toThrow(); // too short
  });
});

describe("BusinessSchema midnight-crossing validation", () => {
  const baseFields = {
    name: "Test Business",
    type: "food",
    email: "test@test.com",
    whatsapp: "+2348012345678",
    products_list: "Rice ₦1500",
    tone: "Friendly" as const,
  };

  it("accepts midnight-crossing hours (22:00 – 02:00)", () => {
    expect(() =>
      BusinessSchema.parse({ ...baseFields, open_time: "22:00", close_time: "02:00" }),
    ).not.toThrow();
  });

  it("rejects identical open and close times", () => {
    expect(() =>
      BusinessSchema.parse({ ...baseFields, open_time: "09:00", close_time: "09:00" }),
    ).toThrow();
  });

  it("accepts normal business hours", () => {
    expect(() =>
      BusinessSchema.parse({ ...baseFields, open_time: "09:00", close_time: "20:00" }),
    ).not.toThrow();
  });
});
