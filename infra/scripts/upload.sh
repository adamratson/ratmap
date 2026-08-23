#!/usr/bin/env bash
# Uploads every file in infra/dist/ to R2. Needs infra/.env filled in per infra/SETUP.md —
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ACCOUNT_ID / R2_BUCKET.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd pmtiles

: "${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID in infra/.env — see infra/SETUP.md}"
: "${R2_BUCKET:?Set R2_BUCKET in infra/.env — see infra/SETUP.md}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID in infra/.env — see infra/SETUP.md}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY in infra/.env — see infra/SETUP.md}"

# A bucket created with a jurisdiction (EU/FedRAMP/US data-location restriction) is only
# reachable via a jurisdiction-qualified endpoint host. Hitting the default host for such a
# bucket fails as a blanket 403 AccessDenied on *every* operation including List — which
# looks exactly like a bad or misscoped credential, not a wrong URL. Cost a long debugging
# detour on 2026-08-21; hence R2_JURISDICTION.
R2_ENDPOINT_HOST="${R2_ACCOUNT_ID}${R2_JURISDICTION:+.${R2_JURISDICTION}}.r2.cloudflarestorage.com"
BUCKET_URL="s3://${R2_BUCKET}?region=auto&endpoint=https://${R2_ENDPOINT_HOST}"

shopt -s nullglob globstar

# Keys mirror the path under dist/, so region artifacts land at
# regions/<id>/<id>-<kind>.pmtiles — matching the `path` recorded in manifest.json.
# places.sqlite is deliberately excluded: it ships inside the app bundle and is
# service-worker precached, not fetched from the bucket (see infra/README.md).
mapfile -t files < <(cd "$DIST_DIR" && ls -1 **/*.pmtiles *.pmtiles 2>/dev/null | sort -u)

if [ "${#files[@]}" -eq 0 ]; then
  echo "Nothing in $DIST_DIR to upload — run the build-*.sh scripts first" >&2
  exit 1
fi

for key in "${files[@]}"; do
  echo "Uploading $key"
  pmtiles upload "$DIST_DIR/$key" "$key" --bucket="$BUCKET_URL"
done

# The manifest must go up *after* the archives it describes: a client that reads a
# manifest listing artifacts which aren't uploaded yet would offer a download that 404s.
MANIFEST="$DIST_DIR/regions/manifest.json"
if [ -f "$MANIFEST" ]; then
  require_cmd aws
  echo "Uploading regions/manifest.json"
  AWS_DEFAULT_REGION=auto aws s3 cp "$MANIFEST" "s3://${R2_BUCKET}/regions/manifest.json" \
    --endpoint-url "https://${R2_ENDPOINT_HOST}" \
    --content-type application/json \
    --no-progress
fi

echo "Done. Public base URL: ${R2_PUBLIC_URL:-<set R2_PUBLIC_URL in infra/.env>}"
