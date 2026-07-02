/**
 * src/lib/niche/hospital/hospital-intent-handler.ts
 *
 * Handles WhatsApp conversation logic for hospital appointment bookings.
 * Called by niche-router.ts when the hospital module is active for a business.
 *
 * Returns a string reply if this handler owns the message, or null to let
 * the generic Wabizz AI response run instead.
 *
 * Multi-turn conversation state is persisted to conversations.state in Supabase
 * via niche-loader helpers so state survives across webhook invocations.
 */

import { logError, logInfo } from "@/lib/server-logger";
import { getConversationState, setConversationState } from "../niche-loader";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getDoctors,
  getAvailableSlots,
  findOrCreatePatient,
  bookAppointment,
  cancelAppointment,
  getAppointment,
  findPatientByPhone,
  VitarApiError,
  isVitarUnavailable,
  VITAR_UNAVAILABLE_REPLY,
} from "./vitar-client";
import type { HospitalNicheConfig } from "../types";
import type { HospitalConversationState, HospitalBookingStep } from "../types";
import type { Doctor, TimeSlot } from "./types";

// ── Intent detection regexes ──────────────────────────────────────────────────

const INTENTS = {
  BOOK: /\b(book|schedule|see|visit|appointment|appoint)\b/i,
  LIST_DOC: /\b(doctors?|physicians?|available|who|specialist|speciali[sz])\b/i,
  SLOTS: /\b(slots?|times?|available|when|free|date|hours?)\b/i,
  CANCEL: /\b(cancel|canc|can't make|won't make|not coming|reschedule)\b/i,
  CHECK: /\b(my appointment|check|when is|what time|remind|booking details)\b/i,
  PRICING: /\b(how much|fee|cost|price|pay|payment|HMO|insurance|consult)\b/i,
  FAQ: /\b(open|hours?|close|address|location|direction|parking)\b/i,
} as const;

// ── Exported handler ──────────────────────────────────────────────────────────

export interface HospitalHandlerPayload {
  businessId: string;
  conversationId: string;
  customerPhone: string;
  customerName: string | null;
  message: string;
  hospitalConfig: HospitalNicheConfig;
  vitarApiKey: string;
  requestId: string;
}

/**
 * Main entry point called by niche-router.
 * Returns reply string or null.
 */
export async function handleHospitalMessage(
  payload: HospitalHandlerPayload,
): Promise<string | null> {
  const {
    conversationId,
    customerPhone,
    customerName,
    message,
    hospitalConfig,
    vitarApiKey,
    requestId,
  } = payload;

  const vitarUrl = hospitalConfig.vitar_api_url;
  const rawState = await getConversationState(conversationId, requestId);
  const state = rawState as Partial<HospitalConversationState>;

  try {
    // ── Active flow continuation ───────────────────────────────────────────
    if (state.flow === "hospital_booking") {
      return handleBookingFlow(payload, vitarUrl, vitarApiKey, state as HospitalConversationState);
    }

    if (state.flow === "hospital_cancel") {
      return handleCancelFlow(payload, vitarUrl, vitarApiKey, state as HospitalConversationState);
    }

    // ── Fresh intent detection ─────────────────────────────────────────────
    if (INTENTS.BOOK.test(message)) {
      return startBookingFlow(payload, vitarUrl, vitarApiKey);
    }

    if (INTENTS.CANCEL.test(message)) {
      return startCancelFlow(payload, vitarUrl, vitarApiKey);
    }

    if (INTENTS.CHECK.test(message)) {
      return checkAppointment(payload, vitarUrl, vitarApiKey);
    }

    if (INTENTS.LIST_DOC.test(message)) {
      return listDoctors(payload, vitarUrl, vitarApiKey);
    }

    if (INTENTS.PRICING.test(message)) {
      return pricingFaq(hospitalConfig);
    }

    if (INTENTS.FAQ.test(message)) {
      return generalFaq(hospitalConfig);
    }

    // No hospital intent matched — return null so generic AI handles it
    return null;
  } catch (err) {
    if (isVitarUnavailable(err)) {
      await logError(
        "hospital-handler",
        "Vitar unavailable",
        { err: err.message },
        requestId,
        "warn",
      );
      return VITAR_UNAVAILABLE_REPLY;
    }

    await logError(
      "hospital-handler",
      "Unexpected error",
      { err: String(err) },
      requestId,
      "error",
    );
    return VITAR_UNAVAILABLE_REPLY;
  }
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function listDoctors(
  payload: HospitalHandlerPayload,
  vitarUrl: string,
  apiKey: string,
): Promise<string | null> {
  const doctors = await getDoctors(vitarUrl, apiKey, undefined, payload.requestId);

  if (doctors.length === 0) {
    return "We have no doctors available at the moment. Please call us directly to arrange an appointment.";
  }

  const lines = doctors
    .slice(0, 8)
    .map((d, i) => {
      const fee = d.consultation_fee ? ` — ₦${d.consultation_fee.toLocaleString()}` : "";
      const spec = d.specialty ? ` (${d.specialty})` : "";
      return `${i + 1}. Dr. ${d.full_name}${spec}${fee}`;
    })
    .join("\n");

  return `Here are our available doctors 🏥\n\n${lines}\n\nReply with a number or doctor name to check availability, or say "book appointment" to start.`;
}

async function startBookingFlow(
  payload: HospitalHandlerPayload,
  vitarUrl: string,
  apiKey: string,
): Promise<string | null> {
  const { conversationId, requestId } = payload;

  const doctors = await getDoctors(vitarUrl, apiKey, undefined, requestId);

  if (doctors.length === 0) {
    return "Sorry, no doctors are currently available. Please call us directly to book.";
  }

  const lines = doctors
    .slice(0, 8)
    .map((d, i) => {
      const spec = d.specialty ? ` (${d.specialty})` : "";
      const fee = d.consultation_fee ? ` — ₦${d.consultation_fee.toLocaleString()}` : "";
      return `${i + 1}. Dr. ${d.full_name}${spec}${fee}`;
    })
    .join("\n");

  await setConversationState(
    conversationId,
    {
      flow: "hospital_booking",
      step: "awaiting_doctor_selection",
      // Cache doctor list so we can resolve the selection by number
      _doctors_cache: doctors.map((d) => ({
        id: d.id,
        full_name: d.full_name,
        consultation_fee: d.consultation_fee,
      })),
    } as unknown as Record<string, unknown>,
    requestId,
  );

  return (
    `Let's book your appointment! 📅\n\nWhich doctor would you like to see?\n\n` +
    `${lines}\n\nReply with a number or the doctor's name.`
  );
}

async function handleBookingFlow(
  payload: HospitalHandlerPayload,
  vitarUrl: string,
  apiKey: string,
  state: HospitalConversationState & {
    _doctors_cache?: Array<{ id: string; full_name: string; consultation_fee: number | null }>;
  },
): Promise<string | null> {
  const { conversationId, customerPhone, customerName, message, requestId } = payload;

  switch (state.step as HospitalBookingStep) {
    case "awaiting_doctor_selection": {
      // Try to resolve doctor from user's reply (number or name)
      const cache =
        (
          state as unknown as {
            _doctors_cache?: Array<{
              id: string;
              full_name: string;
              consultation_fee: number | null;
            }>;
          }
        )._doctors_cache ?? [];
      const numMatch = message.trim().match(/^(\d+)/);
      let doctor: { id: string; full_name: string; consultation_fee: number | null } | undefined;

      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        doctor = cache[idx];
      } else {
        const lower = message.toLowerCase();
        doctor = cache.find(
          (d) =>
            d.full_name.toLowerCase().includes(lower) ||
            lower.includes(d.full_name.toLowerCase().split(" ").pop()!.toLowerCase()),
        );
      }

      if (!doctor) {
        return "I couldn't match that to one of our doctors. Please reply with the number from the list, e.g. '1'.";
      }

      // Ask for date
      await setConversationState(
        conversationId,
        {
          ...state,
          step: "awaiting_slot_selection",
          doctor_id: doctor.id,
          doctor_name: doctor.full_name,
          _fee: doctor.consultation_fee,
        } as unknown as Record<string, unknown>,
        requestId,
      );

      const todayStr = new Date().toISOString().slice(0, 10);
      const slots = await getAvailableSlots(vitarUrl, apiKey, doctor.id, todayStr, requestId);
      return buildSlotMessage(slots, doctor.full_name, todayStr, conversationId, state, requestId);
    }

    case "awaiting_slot_selection": {
      if (!state.slots_shown || !state.doctor_id) {
        // Shouldn't happen — reset
        await setConversationState(conversationId, {}, requestId);
        return "Something went wrong. Let's start again — say 'book appointment'.";
      }

      const numMatch = message.trim().match(/^(\d+)/);
      if (!numMatch) {
        return "Please reply with the number of the slot you'd like, e.g. '2'.";
      }

      const idx = parseInt(numMatch[1], 10) - 1;
      const chosenSlot = state.slots_shown[idx];

      if (!chosenSlot) {
        return `That's not a valid option. Please pick a number between 1 and ${state.slots_shown.length}.`;
      }

      const slotDate = new Date(chosenSlot);
      const formatted = slotDate.toLocaleString("en-NG", {
        timeZone: "Africa/Lagos",
        dateStyle: "full",
        timeStyle: "short",
      });

      const fee = (state as unknown as { _fee?: number | null })._fee;
      const feeText = fee ? `\n💰 Consultation fee: ₦${fee.toLocaleString()}` : "";

      await setConversationState(
        conversationId,
        {
          ...state,
          step: "awaiting_confirmation",
          selected_slot: chosenSlot,
        } as unknown as Record<string, unknown>,
        requestId,
      );

      return (
        `Please confirm your appointment:\n\n` +
        `👨‍⚕️ Doctor: Dr. ${state.doctor_name}\n` +
        `📅 Date/Time: ${formatted}${feeText}\n\n` +
        `Reply YES to confirm or NO to cancel.`
      );
    }

    case "awaiting_confirmation": {
      if (/^\s*yes\s*$/i.test(message)) {
        return confirmAndBook(payload, vitarUrl, apiKey, state, hospitalConfig);
      } else if (/^\s*no\s*$/i.test(message)) {
        await setConversationState(conversationId, {}, requestId);
        return "No problem! Booking cancelled. Say 'book appointment' any time to start again.";
      } else {
        return "Please reply YES to confirm your appointment or NO to cancel.";
      }
    }

    default:
      await setConversationState(conversationId, {}, requestId);
      return null; // default: unknown step, clear state and fall through
  }
}

async function buildSlotMessage(
  slots: TimeSlot[],
  doctorName: string,
  date: string,
  conversationId: string,
  state: HospitalConversationState,
  requestId: string,
): Promise<string | null> {
  if (slots.length === 0) {
    // Try tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const nextSlots = await getAvailableSlots(
      (state as unknown as { vitarUrl?: string }).vitarUrl ?? "",
      "",
      state.doctor_id ?? "",
      tomorrowStr,
      requestId,
    ).catch(() => []);

    if (nextSlots.length === 0) {
      return `Dr. ${doctorName} has no available slots today or tomorrow. Please call us to find the next available date.`;
    }

    return buildSlotListReply(nextSlots, doctorName, tomorrowStr, conversationId, state, requestId);
  }

  return buildSlotListReply(slots, doctorName, date, conversationId, state, requestId);
}

async function buildSlotListReply(
  slots: TimeSlot[],
  doctorName: string,
  date: string,
  conversationId: string,
  state: HospitalConversationState,
  requestId: string,
): Promise<string | null> {
  const shown = slots.slice(0, 5);
  const lines = shown.map((s, i) => {
    const t = new Date(s.start_at).toLocaleTimeString("en-NG", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    return `${i + 1}. ${t}`;
  });

  await setConversationState(
    conversationId,
    {
      ...state,
      step: "awaiting_slot_selection",
      slots_shown: shown.map((s) => s.start_at),
    } as unknown as Record<string, unknown>,
    requestId,
  );

  return (
    `Available slots for Dr. ${doctorName} on ${date}:\n\n` +
    lines.join("\n") +
    "\n\nReply with the number of your preferred time."
  );
}

async function confirmAndBook(
  payload: HospitalHandlerPayload,
  vitarUrl: string,
  apiKey: string,
  state: HospitalConversationState & { _fee?: number | null },
  hospitalConfig: import("../types").HospitalNicheConfig,
): Promise<string | null> {
  const { conversationId, customerPhone, customerName, requestId } = payload;

  // FIX: clinic_id gap — pass vitar_clinic_id from niche config so the patient
  // record is linked to the clinic and visible in the Vitar dashboard.
  const patient = await findOrCreatePatient(
    vitarUrl,
    apiKey,
    customerPhone,
    customerName ?? "WhatsApp Patient",
    requestId,
    hospitalConfig.vitar_clinic_id,
  );

  const appointment = await bookAppointment(
    vitarUrl,
    apiKey,
    {
      doctor_id: state.doctor_id!,
      patient_id: patient.id,
      scheduled_at: state.selected_slot!,
      payment_required: !!(state as unknown as { _fee?: number | null })._fee,
      payment_amount: (state as unknown as { _fee?: number | null })._fee ?? undefined,
    },
    requestId,
  );

  const formatted = new Date(appointment.scheduled_at).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    dateStyle: "full",
    timeStyle: "short",
  });

  // Clear conversation state
  await setConversationState(conversationId, {}, requestId);

  await logInfo(
    "hospital-handler",
    "Appointment booked via WhatsApp",
    { appointmentId: appointment.id, patientId: patient.id },
    requestId,
  );

  const fee = (state as unknown as { _fee?: number | null })._fee;
  const paymentNote = fee
    ? `\n\nA payment link for ₦${fee.toLocaleString()} will be sent shortly. Please pay to confirm your slot.`
    : "";

  // ── Record the appointment in wabizz_appointments for Paystack webhook ──────
  // This is the source-of-truth row the Paystack webhook uses to look up
  // which appointment to confirm once the patient pays.
  if (fee) {
    try {
      // Create Paystack payment link for consultation fee
      const secretKey = process.env.WABIZZ_PAYSTACK_SECRET_KEY ?? "";
      let paystackRef: string | undefined;

      if (secretKey) {
        const paystackResp = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: `${customerPhone.replace("+", "")}@wabizz.whatsapp`,
            amount: fee * 100, // kobo
            metadata: {
              type: "hospital_appointment",
              appointment_id: appointment.id,
              patient_phone: customerPhone,
              business_id: payload.businessId,
            },
            channels: ["card", "bank", "ussd", "mobile_money"],
          }),
        });

        const paystackData = (await paystackResp.json()) as {
          status: boolean;
          data?: { reference: string; authorization_url: string };
        };
        if (paystackData.status && paystackData.data) {
          paystackRef = paystackData.data.reference;
        }
      }

      // Write tracking row — used by paystack webhook to confirm appointment
      await supabaseAdmin.from("wabizz_appointments").insert({
        business_id: payload.businessId,
        vitar_appointment_id: appointment.id,
        patient_phone: customerPhone,
        patient_name: customerName ?? "WhatsApp Patient",
        doctor_name: state.doctor_name,
        scheduled_at: state.selected_slot,
        consultation_fee: fee,
        paystack_ref: paystackRef ?? null,
      });

      await logInfo(
        "hospital-handler",
        "Appointment payment link created",
        { appointmentId: appointment.id, paystackRef, fee },
        requestId,
      );
    } catch (err) {
      // Payment link failure must never block the booking confirmation reply.
      await logError(
        "hospital-handler",
        "Failed to create appointment payment link",
        { appointmentId: appointment.id, err: String(err) },
        requestId,
        "warn",
      );
    }
  }

  return (
    `Appointment booked! ✅\n\n` +
    `👨‍⚕️ Dr. ${state.doctor_name}\n` +
    `📅 ${formatted}\n\n` +
    `Your appointment ID is: ${appointment.id.slice(0, 8).toUpperCase()}${paymentNote}\n\n` +
    `To check or cancel, just say "my appointment" or "cancel appointment".`
  );
}

async function startCancelFlow(
  payload: HospitalHandlerPayload,
  vitarUrl: string,
  apiKey: string,
): Promise<string | null> {
  const { conversationId, customerPhone, requestId } = payload;

  const patient = await findPatientByPhone(vitarUrl, apiKey, customerPhone, requestId);
  if (!patient) {
    return "I couldn't find any bookings for your number. If you believe this is an error, please call us.";
  }

  await setConversationState(
    conversationId,
    {
      flow: "hospital_cancel",
      step: "awaiting_confirmation",
      patient_id: patient.id,
    } as unknown as Record<string, unknown>,
    requestId,
  );

  return "Which appointment would you like to cancel? Please provide the appointment ID (e.g. ABC12345) or say 'latest' for your most recent one.";
}

async function handleCancelFlow(
  payload: HospitalHandlerPayload,
  vitarUrl: string,
  apiKey: string,
  state: HospitalConversationState,
): Promise<string | null> {
  const { conversationId, requestId } = payload;

  if (/latest|recent|last/i.test(payload.message)) {
    if (!state.patient_id) {
      await setConversationState(conversationId, {}, requestId);
      return "Could not find your patient record. Please call us to cancel.";
    }

    const { getPatientAppointments } = await import("./vitar-client");
    const appts = await getPatientAppointments(vitarUrl, apiKey, state.patient_id, requestId);
    const upcoming = appts.filter(
      (a) => a.status === "scheduled" && new Date(a.scheduled_at) > new Date(),
    );

    if (upcoming.length === 0) {
      await setConversationState(conversationId, {}, requestId);
      return "You have no upcoming appointments to cancel.";
    }

    const latest = upcoming[0];
    await cancelAppointment(vitarUrl, apiKey, latest.id, requestId);
    await setConversationState(conversationId, {}, requestId);

    const formatted = new Date(latest.scheduled_at).toLocaleString("en-NG", {
      timeZone: "Africa/Lagos",
      dateStyle: "full",
      timeStyle: "short",
    });

    return `Your appointment on ${formatted} has been cancelled. We hope to see you soon!`;
  }

  // Try to use the message as an appointment ID fragment
  const idMatch = payload.message
    .trim()
    .toUpperCase()
    .match(/([A-Z0-9]{6,})/);
  if (idMatch) {
    try {
      const appt = await getAppointment(vitarUrl, apiKey, idMatch[1], requestId).catch(() => null);
      if (appt) {
        await cancelAppointment(vitarUrl, apiKey, appt.id, requestId);
        await setConversationState(conversationId, {}, requestId);
        return "Your appointment has been successfully cancelled. Take care!";
      }
    } catch (_) {
      // fall through
    }
  }

  return "I couldn't find that appointment. Please say 'latest' to cancel your most recent booking, or call us directly.";
}

async function checkAppointment(
  payload: HospitalHandlerPayload,
  vitarUrl: string,
  apiKey: string,
): Promise<string | null> {
  const { customerPhone, requestId } = payload;

  const patient = await findPatientByPhone(vitarUrl, apiKey, customerPhone, requestId);
  if (!patient) {
    return "I couldn't find any bookings for your number. Say 'book appointment' to schedule one!";
  }

  const { getPatientAppointments } = await import("./vitar-client");
  const appts = await getPatientAppointments(vitarUrl, apiKey, patient.id, requestId);
  const upcoming = appts
    .filter((a) => a.status === "scheduled" && new Date(a.scheduled_at) > new Date())
    .slice(0, 3);

  if (upcoming.length === 0) {
    return "You have no upcoming appointments. Say 'book appointment' to schedule one!";
  }

  const lines = upcoming.map((a) => {
    const date = new Date(a.scheduled_at).toLocaleString("en-NG", {
      timeZone: "Africa/Lagos",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const doctor = a.doctor ? `Dr. ${a.doctor.full_name}` : "your doctor";
    return `📅 ${date} with ${doctor} (ID: ${a.id.slice(0, 8).toUpperCase()})`;
  });

  return `Your upcoming appointment${upcoming.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}`;
}

function pricingFaq(config: HospitalNicheConfig): string {
  const currency = config.currency ?? "NGN";
  return (
    `For specific consultation fees, please ask about the doctor you'd like to see — fees vary by specialist.\n\n` +
    `We accept Paystack payments online. For HMO and insurance queries, please call us directly.\n\n` +
    `Say 'book appointment' to get started!`
  );
}

function generalFaq(config: HospitalNicheConfig): string {
  const phone = config.clinic_phone ? `\n📞 ${config.clinic_phone}` : "";
  return `For ${config.clinic_name} opening hours, location, and other enquiries, please call us directly.${phone}`;
}
