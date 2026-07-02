/**
 * src/__tests__/niche/niche-loader.test.ts
 *
 * Unit tests for niche-loader and niche-router.
 * All Supabase and external calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock supabaseAdmin before importing loader ─────────────────────────────────

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockUpdate = vi.fn();
const mockUpsert = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

const supabaseChain = {
  from: mockFrom,
  rpc: mockRpc,
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: supabaseChain,
}));

vi.mock("@/lib/server-logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

// Set up chainable mock
beforeEach(() => {
  vi.clearAllMocks();

  mockFrom.mockReturnValue({
    select: mockSelect,
    update: mockUpdate,
    upsert: mockUpsert,
  });

  mockSelect.mockReturnValue({
    eq: mockEq,
  });

  mockEq.mockReturnValue({
    eq: mockEq,
    single: mockSingle,
    limit: vi.fn().mockReturnValue({ single: mockSingle }),
    order: vi.fn().mockReturnThis(),
  });

  mockSingle.mockResolvedValue({ data: null, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq });
  mockUpsert.mockReturnValue({ data: null, error: null });
  mockRpc.mockResolvedValue({ data: null, error: null });
});

import {
  getNicheConfigs,
  setConversationState,
  getConversationState,
} from "@/lib/niche/niche-loader";

// ── getNicheConfigs ────────────────────────────────────────────────────────────

describe("getNicheConfigs", () => {
  it("returns empty object when no niche rows exist", async () => {
    mockEq.mockReturnValue({ data: [], error: null });
    // Make the chain work for .eq().eq()
    mockFrom.mockReturnValue({
      select: () => ({ eq: () => ({ eq: () => ({ data: [], error: null }) }) }),
      rpc: mockRpc,
    });

    const result = await getNicheConfigs("business-123");
    expect(result).toEqual({});
  });

  it("returns hospital config when hospital niche row is active", async () => {
    const hospitalRow = {
      id: "row-1",
      business_id: "business-123",
      niche: "hospital",
      config: {
        vitar_api_url: "https://clinic.example.com",
        vitar_api_key_vault_name: "vitar_key_biz123",
        clinic_name: "Test Clinic",
      },
      is_active: true,
    };

    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({ data: [hospitalRow], error: null }),
        }),
      }),
    });

    mockRpc.mockResolvedValue({ data: "secret-key-value", error: null });

    const result = await getNicheConfigs("business-123");
    expect(result.hospital).toBeDefined();
    expect(result.hospital?.is_active).toBe(true);
    expect(result.hospital?.config.clinic_name).toBe("Test Clinic");
    expect(result.hospital?.resolvedApiKey).toBe("secret-key-value");
  });

  it("returns food_trader config when food_trader niche row is active", async () => {
    const foodRow = {
      id: "row-2",
      business_id: "business-456",
      niche: "food_trader",
      config: {
        business_name: "Mama Ngozi Kitchen",
        order_cutoff: "21:00",
        delivery_areas: ["Lekki", "VI"],
      },
      is_active: true,
    };

    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({ data: [foodRow], error: null }),
        }),
      }),
    });

    const result = await getNicheConfigs("business-456");
    expect(result.food_trader).toBeDefined();
    expect(result.food_trader?.config.business_name).toBe("Mama Ngozi Kitchen");
  });

  it("handles Supabase error gracefully and returns empty object", async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({ data: null, error: { message: "DB connection failed" } }),
        }),
      }),
    });

    const result = await getNicheConfigs("business-error");
    expect(result).toEqual({});
  });
});

// ── getConversationState / setConversationState ────────────────────────────────

describe("getConversationState", () => {
  it("returns empty object when state column is null", async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => ({ data: { state: null }, error: null }),
        }),
      }),
    });

    const result = await getConversationState("conv-123");
    expect(result).toEqual({});
  });

  it("returns stored state object", async () => {
    const storedState = { flow: "hospital_booking", step: "awaiting_slot_selection" };
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => ({ data: { state: storedState }, error: null }),
        }),
      }),
    });

    const result = await getConversationState("conv-456");
    expect(result).toEqual(storedState);
  });
});

// ── niche-router ──────────────────────────────────────────────────────────────

import { routeToNiche } from "@/lib/niche/niche-router";

vi.mock("@/lib/niche/hospital/hospital-intent-handler", () => ({
  handleHospitalMessage: vi.fn(),
}));

vi.mock("@/lib/niche/food/food-intent-handler", () => ({
  handleFoodMessage: vi.fn(),
}));

import { handleHospitalMessage } from "@/lib/niche/hospital/hospital-intent-handler";
import { handleFoodMessage } from "@/lib/niche/food/food-intent-handler";

describe("routeToNiche", () => {
  const basePayload = {
    businessId: "biz-1",
    conversationId: "conv-1",
    customerPhone: "+2348012345678",
    customerName: "Test User",
    message: "book appointment",
    requestId: "req-1",
  };

  it("returns null when no niches are active", async () => {
    const result = await routeToNiche({ ...basePayload, nicheConfigs: {} });
    expect(result).toBeNull();
  });

  it("delegates to hospital handler when hospital is active and handler returns reply", async () => {
    vi.mocked(handleHospitalMessage).mockResolvedValue("Hospital reply");

    const result = await routeToNiche({
      ...basePayload,
      nicheConfigs: {
        hospital: {
          is_active: true,
          config: {
            vitar_api_url: "https://clinic.example.com",
            vitar_api_key_vault_name: "key",
            clinic_name: "Test Clinic",
          },
          resolvedApiKey: "secret",
        },
      },
    });

    expect(result).toBe("Hospital reply");
    expect(handleHospitalMessage).toHaveBeenCalledOnce();
  });

  it("falls through to food handler when hospital returns null", async () => {
    vi.mocked(handleHospitalMessage).mockResolvedValue(null);
    vi.mocked(handleFoodMessage).mockResolvedValue("Food reply");

    const result = await routeToNiche({
      ...basePayload,
      message: "show menu",
      nicheConfigs: {
        hospital: {
          is_active: true,
          config: {
            vitar_api_url: "https://clinic.example.com",
            vitar_api_key_vault_name: "key",
            clinic_name: "Test Clinic",
          },
          resolvedApiKey: "secret",
        },
        food_trader: {
          is_active: true,
          config: { business_name: "Mama Kitchen" },
        },
      },
    });

    expect(result).toBe("Food reply");
  });

  it("skips hospital handler when resolvedApiKey is missing", async () => {
    vi.mocked(handleFoodMessage).mockResolvedValue("Food only");

    const result = await routeToNiche({
      ...basePayload,
      nicheConfigs: {
        hospital: {
          is_active: true,
          config: {
            vitar_api_url: "https://clinic.example.com",
            vitar_api_key_vault_name: "key",
            clinic_name: "Test Clinic",
          },
          // resolvedApiKey intentionally missing
        },
        food_trader: {
          is_active: true,
          config: { business_name: "Mama Kitchen" },
        },
      },
    });

    expect(handleHospitalMessage).not.toHaveBeenCalled();
    expect(result).toBe("Food only");
  });

  it("returns null and does not throw if handler throws", async () => {
    vi.mocked(handleHospitalMessage).mockRejectedValue(new Error("Vitar is down"));

    const result = await routeToNiche({
      ...basePayload,
      nicheConfigs: {
        hospital: {
          is_active: true,
          config: {
            vitar_api_url: "https://clinic.example.com",
            vitar_api_key_vault_name: "key",
            clinic_name: "Test Clinic",
          },
          resolvedApiKey: "secret",
        },
      },
    });

    expect(result).toBeNull();
  });
});
