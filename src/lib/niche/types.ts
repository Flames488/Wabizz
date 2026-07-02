/**
 * src/lib/niche/types.ts
 *
 * Shared TypeScript types for the Wabizz niche module system.
 * Both hospital and food-trader handlers import from here.
 */

// ── Niche identifiers ─────────────────────────────────────────────────────────

export type NicheType = "hospital" | "food_trader";

// ── Hospital niche config (stored in business_niche_configs.config JSONB) ─────

export interface HospitalNicheConfig {
  /** Vault secret name that holds the raw Vitar API key */
  vitar_api_key_vault_name: string;
  /** Base URL of the Vitar FastAPI service, e.g. https://clinic.vitar.app */
  vitar_api_url: string;
  /** Human-readable clinic name, injected into the system prompt */
  clinic_name: string;
  /**
   * Vitar clinic UUID.  Passed to POST /api/v1/patients/wabizz so that
   * patients created via WhatsApp are linked to the correct clinic and appear
   * in the clinic's Vitar dashboard.  Without this field, patients are created
   * without a clinic_id and are invisible to clinic staff.
   * FIX: clinic_id gap — set this to the clinic's UUID in Vitar when configuring
   * the hospital niche module in the Wabizz dashboard.
   */
  vitar_clinic_id?: string;
  /** ISO currency code — always NGN for Nigerian clinics */
  currency?: string;
  /** List of services offered, shown in WhatsApp menus */
  services?: string[];
  /** Clinic phone number for fallback messages */
  clinic_phone?: string;
}

// ── Food trader niche config ──────────────────────────────────────────────────

export interface FoodTraderNicheConfig {
  /** Business display name shown to WhatsApp customers */
  business_name: string;
  /** UUID of the menu set for this business in the menu_items table */
  menu_table_id?: string;
  /** HH:MM — orders are rejected after this time (e.g. "21:00") */
  order_cutoff?: string;
  /** Delivery area list returned to customers who ask */
  delivery_areas?: string[];
  /** Business phone for fallback messages */
  business_phone?: string;
}

// ── Loaded niche config row ───────────────────────────────────────────────────

export interface NicheConfigRow {
  id: string;
  business_id: string;
  niche: NicheType;
  config: HospitalNicheConfig | FoodTraderNicheConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ── Aggregated view returned by niche-loader ──────────────────────────────────

export interface ActiveNicheConfigs {
  hospital?: {
    is_active: true;
    config: HospitalNicheConfig;
    /** Raw API key resolved from Supabase Vault (server-side only) */
    resolvedApiKey?: string;
  };
  food_trader?: {
    is_active: true;
    config: FoodTraderNicheConfig;
  };
}

// ── Conversation state stored in conversations.state JSONB ────────────────────

export type ConversationFlow = "hospital_booking" | "hospital_cancel" | "food_order" | null;

export type HospitalBookingStep =
  | "awaiting_specialty"
  | "awaiting_doctor_selection"
  | "awaiting_slot_selection"
  | "awaiting_confirmation"
  | "awaiting_payment";

export type FoodOrderStep =
  | "awaiting_items"
  | "awaiting_delivery_type"
  | "awaiting_address"
  | "awaiting_confirmation"
  | "awaiting_payment";

export interface HospitalConversationState {
  flow: "hospital_booking" | "hospital_cancel";
  step: HospitalBookingStep;
  specialty?: string;
  doctor_id?: string;
  doctor_name?: string;
  patient_id?: string;
  appointment_id?: string;
  /** ISO strings of slots shown to the user in the last message */
  slots_shown?: string[];
  selected_slot?: string;
}

export interface FoodOrderConversationState {
  flow: "food_order";
  step: FoodOrderStep;
  /** Parsed items pending confirmation */
  pending_items?: Array<{
    menu_item_id: string;
    name: string;
    qty: number;
    unit_price: number;
  }>;
  total_amount?: number;
  order_id?: string;
  delivery_type?: "pickup" | "delivery";
}

export type ConversationState =
  | HospitalConversationState
  | FoodOrderConversationState
  | Record<string, never>;
