# R2 setup (manual, one-time)

This is the one part of Phase 1 that needs your Cloudflare account — nothing here can be
scripted from this repo without credentials only you can create. Do this once, then hand
the bucket name + credentials to the scripts in `infra/scripts/`.

## 1. Create the bucket

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2 Object Storage** in the left
   sidebar. First time in R2 on this account, Cloudflare requires a payment method on file
   even to use the free tier (10 GB storage, no egress fees) — it won't charge unless you
   exceed free-tier limits, which catalog-only (§8.2) comes nowhere near.
2. **Create bucket** → name it (e.g. `ratmap-tiles`). Location: Automatic is fine.
3. **If you pick a jurisdiction** (EU / FedRAMP / US data-location restriction) rather than
   Automatic, set `R2_JURISDICTION` in `infra/.env` to match (`eu`, `fedramp`, `us`).
   Jurisdiction buckets are *only* reachable at
   `https://<account>.<jurisdiction>.r2.cloudflarestorage.com`, and hitting the default
   host instead fails as a blanket **403 AccessDenied on every operation, including
   List** — indistinguishable from a bad or misscoped credential. Leave `R2_JURISDICTION`
   unset for Automatic. (The `ratmap-tiles` bucket in use is `eu`.)

## 2. Public access — no custom domain yet

Per §3, the custom domain is deferred to Phase 3. For now:

1. Open the bucket → **Settings** tab → **Public Development URL** → **Allow Access**.
2. Cloudflare gives you a URL like `https://pub-<hash>.r2.dev`. That's the bucket's public
   base URL — send it to me, it goes in `infra/.env` (see `infra/README.md`) and becomes
   the origin every `pmtiles://` reference in the app points at.

`.r2.dev` is rate-limited and meant for exactly this (dev/testing), not production traffic
— fine through Phase 1/2, swap for a real custom domain before Phase 3 launch.

## 3. CORS policy (C4 — do not skip)

Same bucket → **Settings** → **CORS Policy** → paste:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["ETag", "Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedOrigins: ["*"]` is deliberate, not lazy: everything in this bucket is public map
data (same posture Protomaps' own buckets use), and a wildcard origin means you don't have
to remember to add every `localhost` port you happen to dev on. Tighten it in Phase 3 if
you want.

Without `Range` in `AllowedHeaders` and `ETag`/`Content-Range` in `ExposeHeaders`
specifically, PMTiles range requests fail in-browser while looking fine in `curl` — this is
exactly the C4 failure mode the main spec warns about.

## 4. API token for scripted uploads

1. R2 home → **Manage R2 API Tokens** → **Create API Token**.
2. Permissions: **Object Read & Write**. Scope to the specific bucket, not account-wide.
3. Cloudflare shows the credentials **once** — copy immediately:
   - Access Key ID
   - Secret Access Key
   - Account ID (also visible in the R2 dashboard URL / right sidebar)
4. Put them in `infra/.env` (gitignored — see `infra/README.md`), never committed.

## 5. Tell me

Once done, I need: the bucket's public `.r2.dev` URL, and confirmation the API token /
`infra/.env` is filled in on your machine. I can't read your Cloudflare account or
credentials — the upload script just needs them present locally when you run it.
