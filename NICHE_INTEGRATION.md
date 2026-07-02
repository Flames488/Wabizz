# Wabizz Niche Module Integration — What Was Built

## New Files Added (per spec Section 5)

### Database Migrations

- `supabase/migrations/20260510_025_niche_configs.sql` — business_niche_configs table + RLS + conversations.state column
- `supabase/migrations/20260510_026_menu_items.sql` — menu_items table + indexes + RLS
- `supabase/migrations/20260510_027_food_orders.sql` — food_orders table + indexes + RLS

### Shared Niche Infrastructure

- `src/lib/niche/types.ts` — all shared types (NicheType, HospitalNicheConfig, FoodTraderNicheConfig, conversation state shapes)
- `src/lib/niche/niche-loader.ts` — loads active configs from Supabase, resolves Vault secrets, manages conversation state
- `src/lib/niche/niche-router.ts` — dispatches WhatsApp messages to hospital or food handler

### Hospital Module (Vitar integration)

- `src/lib/niche/hospital/types.ts` — Doctor, TimeSlot, Patient, Appointment TypeScript types
- `src/lib/niche/hospital/vitar-client.ts` — typed HTTP client for all Vitar API calls
- `src/lib/niche/hospital/hospital-intent-handler.ts` — multi-turn booking/cancel/FAQ conversation logic
- `src/lib/niche/hospital/prompt-additions.ts` — dynamic Claude system prompt for hospital mode

### Food Trader Module

- `src/lib/niche/food/types.ts` — MenuItem, FoodOrder, OrderItem types
- `src/lib/niche/food/menu-service.ts` — menu CRUD and fuzzy item lookup
- `src/lib/niche/food/order-service.ts` — order creation, status management, Paystack payment links
- `src/lib/niche/food/food-intent-handler.ts` — multi-turn order/status/FAQ conversation logic
- `src/lib/niche/food/prompt-additions.ts` — dynamic Claude system prompt for food trader mode

### Dashboard UI Pages

- `src/routes/dashboard/niche/index.tsx` — niche module management (enable/disable toggles)
- `src/routes/dashboard/niche/hospital.tsx` — hospital settings (Vitar URL, API key vault name, services)
- `src/routes/dashboard/niche/food.tsx` — food trader settings (cutoff time, delivery areas)
- `src/routes/dashboard/niche/food/menu.tsx` — menu item CRUD UI (add/edit/delete + prices)
- `src/routes/dashboard/niche/food/orders.tsx` — live orders board (status updates)

### Tests

- `src/__tests__/niche/niche-loader.test.ts`
- `src/__tests__/niche/vitar-client.test.ts`
- `src/__tests__/niche/food-handler.test.ts`

## Files Modified (per spec Section 5.6)

- `src/lib/server/twilio-handler.ts` — niche routing hooked in after rate limiting, before AI call
- `src/routes/dashboard.tsx` — "Niche Modules" nav item added to sidebar

## Bug Fixes Applied

- **vitar-client.ts**: Fixed all endpoint URLs to match Vitar's actual Wabizz-prefixed routes
  - `/api/v1/doctors` → `/api/v1/doctors/wabizz/list`
  - `/api/v1/doctors/{id}/slots` → `/api/v1/doctors/wabizz/{id}/slots`
  - `/api/v1/patients` (POST) → `/api/v1/patients/wabizz`
  - `/api/v1/appointments` (POST/GET/PATCH) → `/api/v1/appointments/wabizz`
  - `/api/v1/patients/{id}/appointments` → `/api/v1/patients/wabizz/{id}/appointments`
- **order-service.ts**: Replaced non-existent `createPaystackPaymentLink` import with direct
  Paystack `/transaction/initialize` API call using `WABIZZ_PAYSTACK_SECRET_KEY` env var

## How the Integration Works at Runtime

```
WhatsApp message arrives
  → twilio-webhook.ts
  → twilio-handler.ts (HMAC verify → rate limit → idempotency)
  → getNicheConfigs(businessId)          # load from business_niche_configs + Vault
  → routeToNiche(payload)
      → if hospital active: handleHospitalMessage()
          → reads conversation state from conversations.state
          → calls vitar-client.ts → Vitar API
          → returns WhatsApp reply string
      → if food active: handleFoodMessage()
          → reads/writes menu_items and food_orders tables
          → calls Paystack for payment link
          → returns WhatsApp reply string
      → if no niche handled: falls through to Claude AI generic response
  → append niche-specific system prompt additions to Claude context
```

## Deployment Checklist

1. Run the 3 new Supabase migrations (025, 026, 027) on your Supabase project
2. Deploy updated Wabizz to Cloudflare Workers
3. Deploy Vitar separately to VPS (see vitar/NICHE_INTEGRATION.md)
4. In Vitar admin, generate an API key (/settings/api-keys)
5. Store the API key in Supabase Vault:
   ```sql
   SELECT vault.create_secret('vitar_api_key_for_<business_uuid>', '<raw-key>', 'Vitar key for clinic X');
   ```
6. In Wabizz dashboard → Niche Modules → Enable Hospital → enter Vitar URL + vault secret name
