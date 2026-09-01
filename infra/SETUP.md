# Krystal Object Storage setup (manual, one-time)

This is the one part of Phase 1 that needs your Krystal account — nothing here can be
scripted from this repo without credentials only you can create. Do this once, then hand
the bucket name + credentials to the scripts in `infra/scripts/`.

Migrated here from Cloudflare R2 on 2026-08-28 — see `plans/krystal-migration.md` for why
and how the cutover was done.

## 1. Create the bucket

Krystal's console (Object Storage) → create a bucket (e.g. `ratmap-tiles`), region
`uk-lon-1`. No jurisdiction concept here — unlike R2, there's nothing analogous to
`R2_JURISDICTION` to get wrong.

## 2. Public access and CORS — nothing to configure

Krystal serves bucket objects publicly at
`https://<bucket>.<region>.katapultobjects.com` with no separate "enable public access"
step, and — unlike R2 — **there is no CORS policy to write**. The bucket's S3-compatible
gateway (Swift-based) emits a fixed, unconfigurable
`Access-Control-Allow-Origin: *` on every response, already exposing `ETag` and
`Content-Range`. Verified directly against the live bucket 2026-08-27/28:

```sh
curl -s -H "Origin: https://example.github.io" -H "Range: bytes=0-126" -D - \
  "https://<bucket>.<region>.katapultobjects.com/<some-object>" -o /dev/null
# got: 206, Content-Range, Accept-Ranges, Access-Control-Allow-Origin: *,
#      Access-Control-Expose-Headers listing etag + content-type + ...
```

This is C4's exact requirement, satisfied by default. Still worth re-running this check
(`infra/README.md`'s "Verify" section) after any bucket recreation or provider change —
C4 is a constraint on the *outcome*, not on this specific provider having solved it once.

## 3. Access keys for scripted uploads

Katapult console → Object Storage → your bucket → **Access Keys** → **Create**. Copy the
Access Key ID and Secret immediately, same one-time-display caveat as R2 had.

## 4. Fill in `infra/.env`

```sh
cp .env.example .env
```

Then set `S3_BUCKET`, `S3_ENDPOINT` (`https://<region>.katapultobjects.com` — note this is
**not** the per-bucket public URL from step 2, it's the region-level S3 API endpoint),
`S3_REGION`, `PUBLIC_BASE_URL` (the per-bucket URL from step 2), and the access key pair as
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — the AWS-CLI-standard names, since
`infra/scripts/upload.sh` shells out to `aws s3 cp` (see that script's header comment for
why, not `pmtiles upload`).

`.env` is gitignored — never commit it.
