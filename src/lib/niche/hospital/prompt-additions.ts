/**
 * src/lib/niche/hospital/prompt-additions.ts
 *
 * Generates the Claude system-prompt additions for the hospital niche module.
 * Appended to the base Wabizz system prompt when a business has the module active.
 */

import type { HospitalNicheConfig } from "../types";

/**
 * Returns the hospital-specific system prompt block.
 * Dynamically uses the clinic name and service list from the niche config.
 */
export function buildHospitalPromptAddition(config: HospitalNicheConfig): string {
  const serviceList =
    config.services && config.services.length > 0
      ? config.services.map((s) => `- ${s}`).join("\n")
      : "- General Consultation";

  const phoneLine = config.clinic_phone
    ? `If you cannot help, give the patient the clinic phone number: ${config.clinic_phone}.`
    : "If you cannot help, ask the patient to call the clinic directly.";

  return (
    `\n\n--- HOSPITAL MODULE ---\n` +
    `You are also a medical appointment assistant for ${config.clinic_name}.\n\n` +
    `Services available:\n${serviceList}\n\n` +
    `When a customer wants to book, cancel, or enquire about appointments:\n` +
    `1. Always confirm the doctor name, date, time, and consultation fee BEFORE finalising.\n` +
    `2. Never guess doctor availability — the system checks in real time.\n` +
    `3. If the booking system is unavailable, apologise and tell the patient to call us.\n` +
    `4. After booking is confirmed, a payment link will be sent automatically — do not make one up.\n` +
    `5. Keep responses warm, brief, and WhatsApp-friendly.\n\n` +
    phoneLine
  );
}
