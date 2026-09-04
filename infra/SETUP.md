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

## 2. Public access and CORS — nothing to configure, and nothing you *can* configure

Krystal serves bucket objects publicly at
`https://<bucket>.<region>.katapultobjects.com` with no separate "enable public access"
step, and — unlike R2 — there is no CORS policy to write. The bucket's S3-compatible
gateway (Swift-based) emits a fixed, unconfigurable `Access-Control-Allow-Origin: *` on
every response. Verified against the live bucket 2026-08-27/28 and re-verified 2026-09-04:

```sh
curl -s -H "Origin: https://example.github.io" -H "Range: bytes=0-126" -D - \
  "https://<bucket>.<region>.katapultobjects.com/<some-object>" -o /dev/null
# 206, Content-Range, Accept-Ranges, Access-Control-Allow-Origin: *
# Access-Control-Expose-Headers: last-modified, content-type, x-timestamp, expires,
#                                x-trans-id, etag, cache-control, content-language,
#                                pragma, x-openstack-request-id
```

**This does not fully satisfy C4.** `ETag` is exposed, but `Content-Range` is **not** in
that list, so a browser hides it from JavaScript. Nothing in the app reads `Content-Range`
today — `downloadArtifact` checks for status 206 and uses `chunk.byteLength` — so this is
currently harmless, and because the header set is unconfigurable here there is nothing to
fix on Krystal's side. Recorded so nobody later assumes C4 is met in full and writes code
that depends on reading `Content-Range`.

(An earlier version of this file claimed Krystal satisfied C4 exactly. That was wrong on
this detail.)

Providers whose CORS *is* configurable (Civo and Scaleway both support `put-bucket-cors`)
can be made to expose both headers properly. Whichever provider is in use, re-run the check
in `infra/README.md`'s "Verify" section after any bucket recreation or provider change —
C4 is a constraint on the *outcome*, not on one provider having happened to satisfy it.

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
