/**
 * src/lib/niche/hospital/types.ts
 *
 * TypeScript types that mirror Vitar's API response shapes.
 * These are used by vitar-client.ts and hospital-intent-handler.ts.
 */

// ── Doctor ────────────────────────────────────────────────────────────────────

export interface Doctor {
  id: string;
  full_name: string;
  specialty: string | null;
  email: string | null;
  phone: string | null;
  bio: string | null;
  consultation_fee: number | null;
  is_active: boolean;
}

// ── Time slot (returned by GET /api/v1/doctors/{id}/slots) ────────────────────

export interface TimeSlot {
  /** ISO 8601 with timezone, e.g. "2026-05-10T10:00:00+01:00" */
  start_at: string;
  /** ISO 8601 with timezone */
  end_at: string;
  is_available: boolean;
}

// ── Patient ───────────────────────────────────────────────────────────────────

export interface Patient {
  id: string;
  full_name: string;
  /** E.164 format, e.g. "+2348012345678" */
  phone: string;
  email: string | null;
  date_of_birth: string | null;
  gender: string | null;
  notes: string | null;
  clinic_id: string;
  created_at: string;
}

// ── Appointment ───────────────────────────────────────────────────────────────

export type AppointmentStatus = "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: string;
  doctor_id: string;
  patient_id: string;
  scheduled_at: string; // ISO 8601 with timezone
  duration_mins: number;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  booked_via: string;
  payment_required: boolean;
  payment_amount: number | null;
  payment_status: string | null;
  /** Populated when the response includes nested doctor/patient */
  doctor?: Pick<Doctor, "id" | "full_name" | "specialty" | "consultation_fee">;
  patient?: Pick<Patient, "id" | "full_name" | "phone">;
}

// ── Vitar API error ───────────────────────────────────────────────────────────

export interface VitarApiError {
  detail: string;
  status_code?: number;
}

// ── createOrFindPatient payload ───────────────────────────────────────────────

export interface CreatePatientPayload {
  full_name: string;
  /** E.164 format */
  phone: string;
  date_of_birth?: string;
  gender?: string;
  notes?: string;
  /**
   * Vitar clinic UUID.  When provided, the patient is linked to the clinic
   * and appears in the clinic's Vitar dashboard.
   * FIX: clinic_id gap — sourced from HospitalNicheConfig.vitar_clinic_id.
   */
  clinic_id?: string;
}

// ── bookAppointment payload ───────────────────────────────────────────────────

export interface BookAppointmentPayload {
  doctor_id: string;
  patient_id: string;
  /** ISO 8601 with timezone */
  scheduled_at: string;
  duration_mins?: number;
  reason?: string;
  booked_via?: string;
  payment_required?: boolean;
  payment_amount?: number;
}
