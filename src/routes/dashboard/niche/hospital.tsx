/**
 * src/routes/dashboard/niche/hospital.tsx
 *
 * Hospital module settings page.
 * Lets the business owner configure their Vitar API URL, key (stored in Vault),
 * clinic name, services list, and clinic phone.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Stethoscope, ChevronRight, Save, Eye, EyeOff, Plus, X, Info } from "lucide-react";
import { useRequireAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
// FIX: import server function that writes via supabaseAdmin + invalidates cache.
// Previously this page wrote directly to Supabase from the browser, bypassing
// upsertNicheConfig() and leaving the 1-hour niche config cache stale after save.
import { saveHospitalConfig } from "@/lib/niche/niche.functions";

export const Route = createFileRoute("/dashboard/niche/hospital")({
  component: HospitalSettingsPage,
});

interface HospitalConfig {
  vitar_api_url: string;
  vitar_api_key_vault_name: string;
  /**
   * Vitar clinic UUID — sourced from Vitar admin → Settings → Clinic Settings.
   * Required: without this, patients booked via WhatsApp have no clinic_id and
   * are invisible to clinic staff in the Vitar dashboard.
   * Fix 5: clinic_id gap.
   */
  vitar_clinic_id: string;
  clinic_name: string;
  currency: string;
  services: string[];
  clinic_phone: string;
}

const DEFAULT_CONFIG: HospitalConfig = {
  vitar_api_url: "",
  vitar_api_key_vault_name: "",
  vitar_clinic_id: "",
  clinic_name: "",
  currency: "NGN",
  services: ["General Consultation"],
  clinic_phone: "",
};

function HospitalSettingsPage() {
  const { session } = useRequireAuth();
  const [config, setConfig] = useState<HospitalConfig>(DEFAULT_CONFIG);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [newService, setNewService] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!session?.user.id) return;

      const { data: biz } = await supabase
        .from("businesses")
        .select("id")
        .eq("user_id", session.user.id)
        .single();

      if (!biz) {
        setLoading(false);
        return;
      }
      setBusinessId(biz.id);

      const { data: row } = await supabase
        .from("business_niche_configs")
        .select("config")
        .eq("business_id", biz.id)
        .eq("niche", "hospital")
        .single();

      if (row?.config) {
        setConfig({ ...DEFAULT_CONFIG, ...(row.config as Partial<HospitalConfig>) });
      }

      setLoading(false);
    }
    load();
  }, [session]);

  async function handleSave() {
    if (!businessId) return;
    setSaving(true);

    // If the user entered a new API key, store it in Vault first.
    // The RPC call is still fine here — vault storage is separate from the
    // niche config write and does not touch the niche config cache.
    let vaultName = config.vitar_api_key_vault_name;
    if (apiKeyInput.trim()) {
      const { data: secretName, error: vaultError } = await supabase.rpc("store_vitar_api_key", {
        business_id: businessId,
        api_key: apiKeyInput.trim(),
      });

      if (vaultError) {
        alert("Failed to store API key securely. Please try again.");
        setSaving(false);
        return;
      }

      vaultName = secretName as string;
      setApiKeyInput("");
    }

    const finalConfig: HospitalConfig = {
      ...config,
      vitar_api_key_vault_name: vaultName,
      vitar_clinic_id: config.vitar_clinic_id,
    };

    // FIX: call server function instead of supabase.from().upsert() directly.
    // The server function uses supabaseAdmin and calls invalidateNicheConfigCache()
    // so the webhook handler picks up the new config on the next message rather
    // than serving stale data for up to 1 hour from the KV/Redis cache.
    const result = await saveHospitalConfig({
      data: {
        vitar_api_url: finalConfig.vitar_api_url,
        vitar_api_key_vault_name: finalConfig.vitar_api_key_vault_name,
        vitar_clinic_id: finalConfig.vitar_clinic_id,
        clinic_name: finalConfig.clinic_name,
        currency: finalConfig.currency,
        services: finalConfig.services,
        clinic_phone: finalConfig.clinic_phone,
      },
    });

    setSaving(false);
    if (result.success) {
      setSaved(true);
      setConfig(finalConfig);
      setTimeout(() => setSaved(false), 3000);
    } else {
      alert(result.error ?? "Save failed. Please try again.");
    }
  }

  function addService() {
    const s = newService.trim();
    if (!s || config.services.includes(s)) return;
    setConfig((p) => ({ ...p, services: [...p.services, s] }));
    setNewService("");
  }

  function removeService(s: string) {
    setConfig((p) => ({ ...p, services: p.services.filter((x) => x !== s) }));
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 max-w-2xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-6">
        <Link to="/dashboard/niche" className="hover:text-foreground">
          Niche Modules
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Hospital Settings</span>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <div className="rounded-xl bg-blue-100 p-2 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
          <Stethoscope className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Hospital & Clinic Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure Vitar integration for appointment booking
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {/* Vitar API URL */}
        <Field
          label="Vitar API URL"
          hint="The base URL of your Vitar deployment, e.g. https://clinic.vitar.app"
        >
          <input
            type="url"
            value={config.vitar_api_url}
            onChange={(e) => setConfig((p) => ({ ...p, vitar_api_url: e.target.value }))}
            placeholder="https://your-clinic.example.com"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>

        {/* Vitar Clinic ID — Fix 5: clinic_id gap */}
        <Field
          label="Vitar Clinic ID"
          hint="The UUID of your clinic in Vitar. Found in Vitar dashboard → Settings → Clinic Settings. Patients booked via WhatsApp will be linked to this clinic and appear in your Vitar dashboard."
        >
          <input
            type="text"
            value={config.vitar_clinic_id}
            onChange={(e) => setConfig((p) => ({ ...p, vitar_clinic_id: e.target.value }))}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {!config.vitar_clinic_id && (
            <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <span>⚠️</span>
              Without this, WhatsApp patients will not appear in your Vitar dashboard.
            </p>
          )}
        </Field>

        {/* API Key */}
        <Field
          label="Vitar API Key"
          hint={
            config.vitar_api_key_vault_name
              ? "A key is already stored securely. Enter a new value below only if you want to replace it."
              : "Enter your Vitar API key. It will be stored in Supabase Vault — never in plain text."
          }
        >
          {config.vitar_api_key_vault_name && (
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              API key stored securely
            </div>
          )}
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={
                config.vitar_api_key_vault_name
                  ? "Leave blank to keep existing key"
                  : "Enter API key"
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => setShowKey((p) => !p)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        {/* Clinic Name */}
        <Field label="Clinic Name" hint="Shown to patients in WhatsApp messages">
          <input
            type="text"
            value={config.clinic_name}
            onChange={(e) => setConfig((p) => ({ ...p, clinic_name: e.target.value }))}
            placeholder="Lagos General Clinic"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>

        {/* Clinic Phone */}
        <Field
          label="Clinic Phone (optional)"
          hint="Used as fallback when the booking system is unavailable"
        >
          <input
            type="tel"
            value={config.clinic_phone}
            onChange={(e) => setConfig((p) => ({ ...p, clinic_phone: e.target.value }))}
            placeholder="+2348012345678"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>

        {/* Services */}
        <Field label="Services Offered" hint="Listed for patients who ask what they can book">
          <div className="flex flex-wrap gap-2 mb-2">
            {config.services.map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm"
              >
                {s}
                <button
                  onClick={() => removeService(s)}
                  className="text-muted-foreground hover:text-destructive ml-1"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newService}
              onChange={(e) => setNewService(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addService()}
              placeholder="e.g. Lab Tests"
              className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={addService}
              className="inline-flex items-center gap-1 rounded-lg bg-muted px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
        </Field>

        {/* Info */}
        <div className="flex gap-2 rounded-xl border border-border bg-muted/50 p-4 text-sm text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
          <span>
            Wabizz will call your Vitar instance to check doctor availability and book appointments
            in real time. Make sure your Vitar instance is publicly accessible, the API key has been
            generated from Vitar's Admin panel, and the Clinic ID is entered above so patients
            appear in your Vitar dashboard.
          </span>
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-5 py-3 font-semibold shadow transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : saved ? (
            <span>Saved!</span>
          ) : (
            <>
              <Save className="h-4 w-4" />
              Save Settings
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
      {hint && <p className="text-xs text-muted-foreground mb-2">{hint}</p>}
      {children}
    </div>
  );
}
