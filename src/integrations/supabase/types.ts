/**
 * @generated — DO NOT EDIT MANUALLY.
 *
 * This file was originally hand-approximated and has NOT yet been regenerated
 * from your live Supabase schema. Until you run the command below, any column
 * added or changed in the DB will be typed as `any` silently, suppressing
 * compile-time bugs.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  REGENERATE TYPES (run once against your local / linked project):       │
 * │                                                                         │
 * │  npx supabase gen types typescript --local \                            │
 * │    > src/integrations/supabase/types.ts                                 │
 * │                                                                         │
 * │  Or against your remote project:                                        │
 * │  npx supabase gen types typescript --project-id <your-project-id> \    │
 * │    > src/integrations/supabase/types.ts                                 │
 * │                                                                         │
 * │  Add this as an npm script for convenience:                             │
 * │  "gen:types": "supabase gen types typescript --local > \               │
 * │                src/integrations/supabase/types.ts"                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * @approximated — All table definitions below were written by hand and may be
 * missing columns, have wrong nullability, or wrong types for columns added
 * after the initial schema. Search for "@approximated" after regenerating to
 * verify every table was replaced correctly.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      /** @approximated — regenerate types to get accurate column definitions */
      business_niche_configs: {
        Row: {
          id: string;
          business_id: string;
          niche: "hospital" | "food_trader";
          config: Json;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          niche: "hospital" | "food_trader";
          config?: Json;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          business_id?: string;
          niche?: "hospital" | "food_trader";
          config?: Json;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "business_niche_configs_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      menu_items: {
        Row: {
          id: string;
          business_id: string;
          name: string;
          description: string | null;
          price: number;
          category: string | null;
          is_available: boolean;
          image_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          name: string;
          description?: string | null;
          price: number;
          category?: string | null;
          is_available?: boolean;
          image_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          business_id?: string;
          name?: string;
          description?: string | null;
          price?: number;
          category?: string | null;
          is_available?: boolean;
          image_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "menu_items_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      food_orders: {
        Row: {
          id: string;
          business_id: string;
          customer_phone: string;
          customer_name: string | null;
          items: Json;
          total_amount: number;
          status: "pending" | "paid" | "preparing" | "ready" | "delivered" | "cancelled";
          delivery_type: "pickup" | "delivery" | null;
          delivery_address: string | null;
          paystack_ref: string | null;
          payment_status: "unpaid" | "paid";
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          customer_phone: string;
          customer_name?: string | null;
          items: Json;
          total_amount: number;
          status?: "pending" | "paid" | "preparing" | "ready" | "delivered" | "cancelled";
          delivery_type?: "pickup" | "delivery" | null;
          delivery_address?: string | null;
          paystack_ref?: string | null;
          payment_status?: "unpaid" | "paid";
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          business_id?: string;
          customer_phone?: string;
          customer_name?: string | null;
          items?: Json;
          total_amount?: number;
          status?: "pending" | "paid" | "preparing" | "ready" | "delivered" | "cancelled";
          delivery_type?: "pickup" | "delivery" | null;
          delivery_address?: string | null;
          paystack_ref?: string | null;
          payment_status?: "unpaid" | "paid";
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "food_orders_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      businesses: {
        Row: {
          close_time: string;
          created_at: string;
          custom_message: string | null;
          email: string;
          id: string;
          name: string;
          open_time: string;
          owner_id: string;
          products_list: string;
          timezone: string;
          tone: string;
          type: string;
          updated_at: string;
          whatsapp: string;
          whatsapp_number: string | null;
        };
        Insert: {
          close_time?: string;
          created_at?: string;
          custom_message?: string | null;
          email: string;
          id?: string;
          name: string;
          open_time?: string;
          owner_id: string;
          products_list?: string;
          timezone?: string;
          tone?: string;
          type?: string;
          updated_at?: string;
          whatsapp: string;
          whatsapp_number?: string | null;
        };
        Update: {
          close_time?: string;
          created_at?: string;
          custom_message?: string | null;
          email?: string;
          id?: string;
          name?: string;
          open_time?: string;
          owner_id?: string;
          products_list?: string;
          timezone?: string;
          tone?: string;
          type?: string;
          updated_at?: string;
          whatsapp?: string;
          whatsapp_number?: string | null;
        };
        Relationships: [];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      conversations: {
        Row: {
          business_id: string;
          created_at: string;
          customer_name: string | null;
          customer_number: string;
          id: string;
          last_message_at: string;
          last_message_content: string | null;
          last_message_role: string | null;
          status: string;
          /** Niche module multi-turn conversation state. Added by migration 025. */
          state: Json | null;
        };
        Insert: {
          business_id: string;
          created_at?: string;
          customer_name?: string | null;
          customer_number: string;
          id?: string;
          last_message_at?: string;
          last_message_content?: string | null;
          last_message_role?: string | null;
          status?: string;
          state?: Json | null;
        };
        Update: {
          business_id?: string;
          created_at?: string;
          customer_name?: string | null;
          customer_number?: string;
          id?: string;
          last_message_at?: string;
          last_message_content?: string | null;
          last_message_role?: string | null;
          status?: string;
          state?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      messages: {
        Row: {
          content: string;
          conversation_id: string;
          created_at: string;
          id: string;
          message_sid: string | null;
          role: string;
        };
        Insert: {
          content: string;
          conversation_id: string;
          created_at?: string;
          id?: string;
          message_sid?: string | null;
          role: string;
        };
        Update: {
          content?: string;
          conversation_id?: string;
          created_at?: string;
          id?: string;
          message_sid?: string | null;
          role?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      orders: {
        Row: {
          amount_naira: number;
          business_id: string;
          conversation_id: string | null;
          created_at: string;
          customer_number: string;
          id: string;
          paid_at: string | null;
          paystack_reference: string | null;
          status: string;
        };
        Insert: {
          amount_naira: number;
          business_id: string;
          conversation_id?: string | null;
          created_at?: string;
          customer_number: string;
          id?: string;
          paid_at?: string | null;
          paystack_reference?: string | null;
          status?: string;
        };
        Update: {
          amount_naira?: number;
          business_id?: string;
          conversation_id?: string | null;
          created_at?: string;
          customer_number?: string;
          id?: string;
          paid_at?: string | null;
          paystack_reference?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orders_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orders_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      paystack_keys: {
        Row: {
          business_id: string;
          created_at: string;
          public_key: string;
          secret_key: string;
          secret_key_vault_id: string | null;
          updated_at: string;
        };
        Insert: {
          business_id: string;
          created_at?: string;
          public_key: string;
          secret_key: string;
          secret_key_vault_id?: string | null;
          updated_at?: string;
        };
        Update: {
          business_id?: string;
          created_at?: string;
          public_key?: string;
          secret_key?: string;
          secret_key_vault_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "paystack_keys_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: true;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      subscriptions: {
        Row: {
          business_id: string;
          cancelled_at: string | null;
          created_at: string;
          current_period_end: string | null;
          id: string;
          paystack_reference: string | null;
          plan_id: string;
          status: string;
          trial_ends_at: string | null;
          trial_reminder_sent_at: string | null;
          updated_at: string;
        };
        Insert: {
          business_id: string;
          cancelled_at?: string | null;
          created_at?: string;
          current_period_end?: string | null;
          id?: string;
          paystack_reference?: string | null;
          plan_id: string;
          status: string;
          trial_ends_at?: string | null;
          trial_reminder_sent_at?: string | null;
          updated_at?: string;
        };
        Update: {
          business_id?: string;
          cancelled_at?: string | null;
          created_at?: string;
          current_period_end?: string | null;
          id?: string;
          paystack_reference?: string | null;
          plan_id?: string;
          status?: string;
          trial_ends_at?: string | null;
          trial_reminder_sent_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscriptions_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      notification_log: {
        Row: {
          business_id: string;
          id: string;
          meta: Record<string, unknown>;
          sent_at: string;
          type: string;
        };
        Insert: {
          business_id: string;
          id?: string;
          meta?: Record<string, unknown>;
          sent_at?: string;
          type: string;
        };
        Update: {
          business_id?: string;
          id?: string;
          meta?: Record<string, unknown>;
          sent_at?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notification_log_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      subscription_history: {
        Row: {
          business_id: string;
          created_at: string;
          event_type: string;
          id: string;
          notes: string | null;
          plan_id: string;
        };
        Insert: {
          business_id: string;
          created_at?: string;
          event_type: string;
          id?: string;
          notes?: string | null;
          plan_id: string;
        };
        Update: {
          business_id?: string;
          created_at?: string;
          event_type?: string;
          id?: string;
          notes?: string | null;
          plan_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscription_history_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      error_logs: {
        Row: {
          context: Record<string, unknown>;
          id: string;
          level: string;
          message: string;
          occurred_at: string;
          source: string;
        };
        Insert: {
          context?: Record<string, unknown>;
          id?: string;
          level?: string;
          message: string;
          occurred_at?: string;
          source: string;
        };
        Update: {
          context?: Record<string, unknown>;
          id?: string;
          level?: string;
          message?: string;
          occurred_at?: string;
          source?: string;
        };
        Relationships: [];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      rate_limit_overrides: {
        Row: {
          business_id: string;
          created_at: string;
          id: string;
          limit_key: string;
          limit_value: number;
          reason: string | null;
        };
        Insert: {
          business_id: string;
          created_at?: string;
          id?: string;
          limit_key: string;
          limit_value: number;
          reason?: string | null;
        };
        Update: {
          business_id?: string;
          created_at?: string;
          id?: string;
          limit_key?: string;
          limit_value?: number;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "rate_limit_overrides_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      startup_log: {
        Row: {
          env: string;
          id: string;
          runtime: string;
          started_at: string;
          version: string;
        };
        Insert: {
          env: string;
          id?: string;
          runtime: string;
          started_at?: string;
          version: string;
        };
        Update: {
          env?: string;
          id?: string;
          runtime?: string;
          started_at?: string;
          version?: string;
        };
        Relationships: [];
      };
      /** @approximated — regenerate types to get accurate column definitions */
      whatsapp_config: {
        Row: {
          business_id: string;
          business_number: string;
          business_manager_id: string | null;
          coexistence_eligible: boolean;
          coexistence_enabled: boolean;
          connected_at: string | null;
          connected_via: string | null;
          created_at: string;
          dialog_api_key: string;
          dialog_api_key_vault_id: string | null;
          meta_access_token_vault_id: string | null;
          meta_connected: boolean;
          phone_number_id: string | null;
          updated_at: string;
          waba_id: string | null;
          access_token_vault_id: string | null;
        };
        Insert: {
          business_id: string;
          business_number: string;
          business_manager_id?: string | null;
          coexistence_eligible?: boolean;
          coexistence_enabled?: boolean;
          connected_at?: string | null;
          connected_via?: string | null;
          created_at?: string;
          dialog_api_key: string;
          dialog_api_key_vault_id?: string | null;
          meta_access_token_vault_id?: string | null;
          meta_connected?: boolean;
          phone_number_id?: string | null;
          updated_at?: string;
          waba_id?: string | null;
          access_token_vault_id?: string | null;
        };
        Update: {
          business_id?: string;
          business_number?: string;
          business_manager_id?: string | null;
          coexistence_eligible?: boolean;
          coexistence_enabled?: boolean;
          connected_at?: string | null;
          connected_via?: string | null;
          created_at?: string;
          dialog_api_key?: string;
          dialog_api_key_vault_id?: string | null;
          meta_access_token_vault_id?: string | null;
          meta_connected?: boolean;
          phone_number_id?: string | null;
          updated_at?: string;
          waba_id?: string | null;
          access_token_vault_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "whatsapp_config_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: true;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
      /** @approximated — mirrors migration 029 (20260510_029_wabizz_appointments.sql) */
      wabizz_appointments: {
        Row: {
          id: string;
          business_id: string;
          vitar_appointment_id: string;
          patient_phone: string;
          patient_name: string | null;
          doctor_name: string | null;
          scheduled_at: string | null;
          consultation_fee: number | null;
          paystack_ref: string | null;
          confirmation_sent: boolean;
          paid_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          vitar_appointment_id: string;
          patient_phone: string;
          patient_name?: string | null;
          doctor_name?: string | null;
          scheduled_at?: string | null;
          consultation_fee?: number | null;
          paystack_ref?: string | null;
          confirmation_sent?: boolean;
          paid_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          business_id?: string;
          vitar_appointment_id?: string;
          patient_phone?: string;
          patient_name?: string | null;
          doctor_name?: string | null;
          scheduled_at?: string | null;
          consultation_fee?: number | null;
          paystack_ref?: string | null;
          confirmation_sent?: boolean;
          paid_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "wabizz_appointments_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
