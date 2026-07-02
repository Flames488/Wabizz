/**
 * src/lib/niche/hospital/vitar-client.ts
 *
 * HTTP client that wraps every Wabizz → Vitar API call.
 *
 * Design principles:
 *  - Every function is pure: receives vitarUrl + apiKey as parameters.
 *    No module-level globals so the client is trivially testable with mocks.
 *  - All calls are wrapped in try/catch.  Vitar being unreachable returns a
 *    typed error so the intent handler can reply gracefully.
 *  - Return types match Vitar's API response shapes exactly (see types.ts).
 *  - Structured JSON logs via Wabizz's existing logError/logInfo helpers.
 */

import { logError, logInfo } from "@/lib/server-logger";
import { circuitBreaker, CircuitOpenError } from "@/lib/server/circuit-breaker/circuit-breaker";
import { recordApiCall } from "@/lib/server/admin/metrics";
import type {
  Doctor,
  TimeSlot,
  Patient,
  Appointment,
  CreatePatientPayload,
  BookAppointmentPayload,
} from "./types";

// ── Shared request helper ─────────────────────────────────────────────────────

interface VitarRequestOptions {
  vitarUrl: string;
  apiKey: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  requestId?: string;
}

async function vitarRequest<T>(opts: VitarRequestOptions): Promise<T> {
  const { vitarUrl, apiKey, path, method = "GET", body, requestId = "vitar-client" } = opts;

  const url = `${vitarUrl.replace(/\/$/, "")}${path}`;

  const headers: Record<string, string> = {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  // All Vitar HTTP calls go through the "vitar" circuit breaker.
  // If Vitar is down, the breaker opens after 3 failures and all subsequent
  // calls fail instantly (CircuitOpenError) rather than hanging for 10s each.
  const start = Date.now();
  return circuitBreaker("vitar", async () => {
    let statusCode: number | undefined;
    try {
      const response = await fetch(url, init);
      statusCode = response.status;

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        void recordApiCall({
          service: "vitar",
          success: false,
          latencyMs: Date.now() - start,
          statusCode,
          error: text.slice(0, 200),
        });
        throw new VitarApiError(response.status, text, path);
      }

      void recordApiCall({
        service: "vitar",
        success: true,
        latencyMs: Date.now() - start,
        statusCode,
      });
      return response.json() as Promise<T>;
    } catch (err) {
      if (!(err instanceof VitarApiError)) {
        void recordApiCall({
          service: "vitar",
          success: false,
          latencyMs: Date.now() - start,
          statusCode,
          error: String(err).slice(0, 200),
        });
      }
      throw err;
    }
  });
}

// ── Error class ───────────────────────────────────────────────────────────────

export class VitarApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly detail: string,
    public readonly path: string,
  ) {
    super(`Vitar API ${statusCode} on ${path}: ${detail}`);
    this.name = "VitarApiError";
  }

  get isNotFound(): boolean {
    return this.statusCode === 404;
  }

  get isUnavailable(): boolean {
    return this.statusCode >= 500 || this.statusCode === 0;
  }
}

/**
 * Returns true if err is a circuit-open or Vitar 5xx error — both mean
 * "Vitar is unreachable right now". The intent handler uses this to
 * distinguish "Vitar is down" from "patient not found" (404) so it can
 * send the right user-facing message without leaking internal error details.
 */
export function isVitarUnavailable(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return true;
  if (err instanceof VitarApiError) return err.isUnavailable;
  // Network-level failure (ECONNREFUSED, timeout) — also treat as down
  if (err instanceof TypeError && String(err).includes("fetch")) return true;
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Lists available doctors, optionally filtered by specialty.
 *
 * Maps to: GET /api/v1/doctors/wabizz/list
 */
export async function getDoctors(
  vitarUrl: string,
  apiKey: string,
  specialty?: string,
  requestId = "vitar-client",
): Promise<Doctor[]> {
  try {
    const path = specialty
      ? `/api/v1/doctors/wabizz/list?specialty=${encodeURIComponent(specialty)}`
      : "/api/v1/doctors/wabizz/list";

    const data = await vitarRequest<{ doctors: Doctor[] } | Doctor[]>({
      vitarUrl,
      apiKey,
      path,
      requestId,
    });

    // Vitar may return { doctors: [...] } or a bare array depending on version
    const doctors = Array.isArray(data) ? data : ((data as { doctors: Doctor[] }).doctors ?? []);

    await logInfo(
      "vitar-client",
      "getDoctors succeeded",
      { count: doctors.length, specialty },
      requestId,
    );

    return doctors;
  } catch (err) {
    await logError(
      "vitar-client",
      "getDoctors failed",
      { vitarUrl, specialty, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/**
 * Returns available time slots for a doctor on a given date.
 *
 * Maps to: GET /api/v1/doctors/wabizz/{id}/slots?date=YYYY-MM-DD
 */
export async function getAvailableSlots(
  vitarUrl: string,
  apiKey: string,
  doctorId: string,
  date: string, // YYYY-MM-DD
  requestId = "vitar-client",
): Promise<TimeSlot[]> {
  try {
    const data = await vitarRequest<{ slots: TimeSlot[] } | TimeSlot[]>({
      vitarUrl,
      apiKey,
      path: `/api/v1/doctors/wabizz/${doctorId}/slots?date=${encodeURIComponent(date)}`,
      requestId,
    });

    const slots = Array.isArray(data) ? data : ((data as { slots: TimeSlot[] }).slots ?? []);
    const available = slots.filter((s) => s.is_available);

    await logInfo(
      "vitar-client",
      "getAvailableSlots succeeded",
      { doctorId, date, total: slots.length, available: available.length },
      requestId,
    );

    return available;
  } catch (err) {
    await logError(
      "vitar-client",
      "getAvailableSlots failed",
      { doctorId, date, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/**
 * Looks up a patient by phone number (E.164).
 * Returns null if not found (404).  Throws on other errors.
 *
 * Maps to: GET /api/v1/patients/by-phone/{phone}
 */
export async function findPatientByPhone(
  vitarUrl: string,
  apiKey: string,
  phone: string,
  requestId = "vitar-client",
): Promise<Patient | null> {
  try {
    const patient = await vitarRequest<Patient>({
      vitarUrl,
      apiKey,
      path: `/api/v1/patients/by-phone/${encodeURIComponent(phone)}`,
      requestId,
    });

    await logInfo("vitar-client", "findPatientByPhone found patient", { phone }, requestId);
    return patient;
  } catch (err) {
    if (err instanceof VitarApiError && err.isNotFound) {
      return null;
    }
    await logError(
      "vitar-client",
      "findPatientByPhone failed",
      { phone, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/**
 * Creates a new patient in Vitar.
 *
 * Maps to: POST /api/v1/patients/wabizz
 */
export async function createPatient(
  vitarUrl: string,
  apiKey: string,
  payload: CreatePatientPayload,
  requestId = "vitar-client",
): Promise<Patient> {
  try {
    const patient = await vitarRequest<Patient>({
      vitarUrl,
      apiKey,
      path: "/api/v1/patients/wabizz",
      method: "POST",
      body: payload,
      requestId,
    });

    await logInfo("vitar-client", "createPatient succeeded", { patientId: patient.id }, requestId);
    return patient;
  } catch (err) {
    await logError(
      "vitar-client",
      "createPatient failed",
      { payload, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/**
 * Finds an existing patient by phone or creates a new record.
 * This is the primary entry point the intent handler should use.
 *
 * Maps to: GET /api/v1/patients/by-phone/{phone} → POST /api/v1/patients/wabizz
 */
export async function findOrCreatePatient(
  vitarUrl: string,
  apiKey: string,
  phone: string,
  name: string,
  requestId = "vitar-client",
  clinicId?: string,
): Promise<Patient> {
  const existing = await findPatientByPhone(vitarUrl, apiKey, phone, requestId);
  if (existing) return existing;

  // FIX: clinic_id gap — pass clinicId so the patient is linked to the correct
  // clinic in Vitar and appears in the clinic dashboard after booking via WhatsApp.
  return createPatient(
    vitarUrl,
    apiKey,
    { full_name: name, phone, ...(clinicId ? { clinic_id: clinicId } : {}) },
    requestId,
  );
}

/**
 * Books an appointment in Vitar.
 *
 * Maps to: POST /api/v1/appointments/wabizz
 */
export async function bookAppointment(
  vitarUrl: string,
  apiKey: string,
  payload: BookAppointmentPayload,
  requestId = "vitar-client",
): Promise<Appointment> {
  try {
    const appointment = await vitarRequest<Appointment>({
      vitarUrl,
      apiKey,
      path: "/api/v1/appointments/wabizz",
      method: "POST",
      body: { ...payload, booked_via: "wabizz_whatsapp" },
      requestId,
    });

    await logInfo(
      "vitar-client",
      "bookAppointment succeeded",
      { appointmentId: appointment.id },
      requestId,
    );
    return appointment;
  } catch (err) {
    await logError(
      "vitar-client",
      "bookAppointment failed",
      { payload, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/**
 * Retrieves a single appointment by ID.
 *
 * Maps to: GET /api/v1/appointments/wabizz/{id}
 */
export async function getAppointment(
  vitarUrl: string,
  apiKey: string,
  appointmentId: string,
  requestId = "vitar-client",
): Promise<Appointment> {
  try {
    return await vitarRequest<Appointment>({
      vitarUrl,
      apiKey,
      path: `/api/v1/appointments/wabizz/${appointmentId}`,
      requestId,
    });
  } catch (err) {
    await logError(
      "vitar-client",
      "getAppointment failed",
      { appointmentId, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/**
 * Cancels an appointment.
 *
 * Maps to: PATCH /api/v1/appointments/wabizz/{id}  { status: "cancelled" }
 */
export async function cancelAppointment(
  vitarUrl: string,
  apiKey: string,
  appointmentId: string,
  requestId = "vitar-client",
): Promise<void> {
  try {
    await vitarRequest<Appointment>({
      vitarUrl,
      apiKey,
      path: `/api/v1/appointments/wabizz/${appointmentId}`,
      method: "PATCH",
      body: { status: "cancelled" },
      requestId,
    });

    await logInfo("vitar-client", "cancelAppointment succeeded", { appointmentId }, requestId);
  } catch (err) {
    await logError(
      "vitar-client",
      "cancelAppointment failed",
      { appointmentId, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/**
 * Returns all appointments for a patient.
 *
 * Maps to: GET /api/v1/patients/wabizz/{id}/appointments
 */
export async function getPatientAppointments(
  vitarUrl: string,
  apiKey: string,
  patientId: string,
  requestId = "vitar-client",
): Promise<Appointment[]> {
  try {
    const data = await vitarRequest<{ appointments: Appointment[] } | Appointment[]>({
      vitarUrl,
      apiKey,
      path: `/api/v1/patients/wabizz/${patientId}/appointments`,
      requestId,
    });

    return Array.isArray(data)
      ? data
      : ((data as { appointments: Appointment[] }).appointments ?? []);
  } catch (err) {
    await logError(
      "vitar-client",
      "getPatientAppointments failed",
      { patientId, err: String(err) },
      requestId,
      "error",
    );
    throw err;
  }
}

/** Fallback message sent to WhatsApp users when Vitar is unavailable. */
export const VITAR_UNAVAILABLE_REPLY =
  "Sorry, our booking system is temporarily unavailable. Please call us directly to book your appointment. We apologise for the inconvenience!";
