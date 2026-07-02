# Wabizz Deploy Checklist

## Local Development (UI only — no Cloudflare runtime needed)

```sh
bun install
cp .env.example .env.local     # fill in your Supabase + Twilio + Paystack keys
bun run db:migrate              # push all 31 Supabase migrations
bun run dev                     # React UI at http://localhost:5173
```

## Local Development (Full Worker — Cloudflare runtime emulated)

```sh
bun install
cp .env.example .env.local
bun run db:migrate
bun run pre-launch:local        # run checks, skip KV placeholder (zero IDs OK for local)
bun run worker:dev              # wrangler dev --local at http://localhost:8787
```

## Production Deploy (Cloudflare Workers)

### Step 1 — Create KV namespaces (one-time)

```sh
wrangler kv namespace create RATE_LIMIT_KV
wrangler kv namespace create CACHE_KV
wrangler kv namespace create RATE_LIMIT_KV --preview
wrangler kv namespace create CACHE_KV --preview
```

Each command prints an `id`. Paste the production IDs into `wrangler.jsonc` under `kv_namespaces`, and the preview IDs into the `preview_id` fields.

### Step 2 — Create Queues (one-time)

```sh
for i in 0 1 2 3 4 5 6 7; do wrangler queues create wabizz-jobs-$i; done
wrangler queues create wabizz-dlq
```

### Step 3 — Set Secrets

```sh
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put SUPABASE_PUBLISHABLE_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_API_KEY_SID
wrangler secret put TWILIO_API_KEY_SECRET
wrangler secret put TWILIO_PHONE_NUMBER
wrangler secret put WABIZZ_PAYSTACK_SECRET_KEY
wrangler secret put WABIZZ_PAYSTACK_PUBLIC_KEY
wrangler secret put APP_URL
wrangler secret put ADMIN_JWT_SECRET      # openssl rand -hex 32
wrangler secret put CRON_SECRET           # openssl rand -hex 16
```

### Step 4 — Run pre-launch check and deploy

```sh
bun run pre-launch    # validates: KV IDs replaced, migrations present, no placeholders
wrangler deploy       # or: bun run worker:deploy (runs pre-launch automatically)
```

### Step 5 — Run Supabase migrations on production

```sh
supabase db push      # or: bun run db:migrate
```

---

## Docker (Node/PM2 preview build)

```sh
cp .env.example .env   # fill in secrets
docker compose up --build
# App available at http://localhost:3000
# With Nginx: docker compose --profile with-nginx up --build
```

---

## Readiness Score after this checklist: 100/100 ✅
