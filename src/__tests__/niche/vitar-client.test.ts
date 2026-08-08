/**
 * src/__tests__/niche/vitar-client.test.ts
 *
 * Unit tests for the Vitar HTTP client.
 * fetch() is mocked — no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server-logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  // circuitBreaker (via alert-engine's apiDown) also calls logWarn/logFatal
  // on certain paths — without these the mock module throws "No export
  // logWarn is defined", surfacing as an unhandled rejection during the run.
  logWarn: vi.fn(),
  logFatal: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  getDoctors,
  getAvailableSlots,
  findPatientByPhone,
  createPatient,
  findOrCreatePatient,
  bookAppointment,
  cancelAppointment,
  getAppointment,
  VitarApiError,
  VITAR_UNAVAILABLE_REPLY,
} from "@/lib/niche/hospital/vitar-client";

const VITAR_URL = "https://clinic.example.com";
const API_KEY = "test-api-key";

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getDoctors ────────────────────────────────────────────────────────────────

describe("getDoctors", () => {
  it("returns doctor array from API response", async () => {
    const doctors = [
      { id: "d1", full_name: "Dr. Amina Bello", specialty: "Cardiology", consultation_fee: 5000 },
    ];
    mockFetch.mockResolvedValue(mockResponse({ doctors }));

    const result = await getDoctors(VITAR_URL, API_KEY);
    expect(result).toHaveLength(1);
    expect(result[0].full_name).toBe("Dr. Amina Bello");
  });

  it("handles bare array response from Vitar", async () => {
    const doctors = [{ id: "d1", full_name: "Dr. James Okonkwo", specialty: "General" }];
    mockFetch.mockResolvedValue(mockResponse(doctors));

    const result = await getDoctors(VITAR_URL, API_KEY);
    expect(result).toHaveLength(1);
  });

  it("throws VitarApiError on 500", async () => {
    mockFetch.mockResolvedValue(mockResponse({ detail: "Server Error" }, 500));
    await expect(getDoctors(VITAR_URL, API_KEY)).rejects.toThrow(VitarApiError);
  });

  it("sends X-API-Key header", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));
    await getDoctors(VITAR_URL, API_KEY);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-API-Key"]).toBe(API_KEY);
  });

  it("appends specialty to query string when provided", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));
    await getDoctors(VITAR_URL, API_KEY, "Cardiology");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("specialty=Cardiology");
  });
});

// ── getAvailableSlots ─────────────────────────────────────────────────────────

describe("getAvailableSlots", () => {
  it("returns only available slots", async () => {
    const slots = [
      {
        start_at: "2026-05-10T10:00:00+01:00",
        end_at: "2026-05-10T10:30:00+01:00",
        is_available: true,
      },
      {
        start_at: "2026-05-10T11:00:00+01:00",
        end_at: "2026-05-10T11:30:00+01:00",
        is_available: false,
      },
    ];
    mockFetch.mockResolvedValue(mockResponse({ slots }));

    const result = await getAvailableSlots(VITAR_URL, API_KEY, "d1", "2026-05-10");
    expect(result).toHaveLength(1);
    expect(result[0].is_available).toBe(true);
  });
});

// ── findPatientByPhone ────────────────────────────────────────────────────────

describe("findPatientByPhone", () => {
  it("returns patient when found", async () => {
    const patient = { id: "p1", full_name: "Chidi Okeke", phone: "+2348012345678" };
    mockFetch.mockResolvedValue(mockResponse(patient));

    const result = await findPatientByPhone(VITAR_URL, API_KEY, "+2348012345678");
    expect(result?.id).toBe("p1");
  });

  it("returns null on 404", async () => {
    mockFetch.mockResolvedValue(mockResponse({ detail: "Not found" }, 404));

    const result = await findPatientByPhone(VITAR_URL, API_KEY, "+2341111111111");
    expect(result).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    mockFetch.mockResolvedValue(mockResponse({ detail: "Server Error" }, 500));
    await expect(findPatientByPhone(VITAR_URL, API_KEY, "+2341111111111")).rejects.toThrow(
      VitarApiError,
    );
  });
});

// ── findOrCreatePatient ───────────────────────────────────────────────────────

describe("findOrCreatePatient", () => {
  it("returns existing patient without creating a new one", async () => {
    const patient = { id: "p1", full_name: "Existing Patient", phone: "+234111" };
    mockFetch.mockResolvedValue(mockResponse(patient));

    const result = await findOrCreatePatient(VITAR_URL, API_KEY, "+234111", "Existing Patient");
    expect(result.id).toBe("p1");
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only GET, not POST
  });

  it("creates patient when not found", async () => {
    const created = { id: "p2", full_name: "New Patient", phone: "+234222" };
    mockFetch
      .mockResolvedValueOnce(mockResponse({ detail: "Not found" }, 404)) // GET returns 404
      .mockResolvedValueOnce(mockResponse(created)); // POST creates

    const result = await findOrCreatePatient(VITAR_URL, API_KEY, "+234222", "New Patient");
    expect(result.id).toBe("p2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── bookAppointment ───────────────────────────────────────────────────────────

describe("bookAppointment", () => {
  it("posts to /api/v1/appointments/wabizz and returns appointment", async () => {
    const appt = { id: "a1", doctor_id: "d1", patient_id: "p1", status: "scheduled" };
    mockFetch.mockResolvedValue(mockResponse(appt));

    const result = await bookAppointment(VITAR_URL, API_KEY, {
      doctor_id: "d1",
      patient_id: "p1",
      scheduled_at: "2026-05-10T10:00:00+01:00",
    });

    expect(result.id).toBe("a1");
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.booked_via).toBe("wabizz_whatsapp");
  });
});

// ── cancelAppointment ─────────────────────────────────────────────────────────

describe("cancelAppointment", () => {
  it("sends PATCH with status=cancelled", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "a1", status: "cancelled" }));

    await cancelAppointment(VITAR_URL, API_KEY, "a1");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/appointments/wabizz/a1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body.status).toBe("cancelled");
  });
});

// ── VitarApiError ─────────────────────────────────────────────────────────────

describe("VitarApiError", () => {
  it("isNotFound is true for 404", () => {
    const err = new VitarApiError(404, "Not found", "/api/v1/patients/by-phone/123");
    expect(err.isNotFound).toBe(true);
  });

  it("isUnavailable is true for 500+", () => {
    const err = new VitarApiError(503, "Service Unavailable", "/api/v1/doctors");
    expect(err.isUnavailable).toBe(true);
  });
});

// ── VITAR_UNAVAILABLE_REPLY ───────────────────────────────────────────────────

describe("VITAR_UNAVAILABLE_REPLY", () => {
  it("is a non-empty string", () => {
    expect(typeof VITAR_UNAVAILABLE_REPLY).toBe("string");
    expect(VITAR_UNAVAILABLE_REPLY.length).toBeGreaterThan(20);
  });
});
