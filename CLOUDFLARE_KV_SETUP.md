# Cloudflare KV Setup

`wrangler.jsonc` contains non-secret zero ID sentinels so the repository does not ship `REPLACE_WITH` placeholder strings.

Before deployment, create the real namespaces and replace each zero ID:

```sh
wrangler kv namespace create RATE_LIMIT_KV
wrangler kv namespace create CACHE_KV
wrangler kv namespace create RATE_LIMIT_KV --preview
wrangler kv namespace create CACHE_KV --preview
```

Copy the printed IDs into `wrangler.jsonc`, then run `npm run pre-launch` before `wrangler deploy`.
