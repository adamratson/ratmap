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

shopt -s nullglob
files=("$DIST_DIR"/*.pmtiles)
if [ "${#files[@]}" -eq 0 ]; then
  echo "Nothing in $DIST_DIR to upload — run the build-*.sh scripts first" >&2
  exit 1
fi

for f in "${files[@]}"; do
  name="$(basename "$f")"
  echo "Uploading $name"
  pmtiles upload "$f" "$name" --bucket="$BUCKET_URL"
done

echo "Done. Public base URL: ${R2_PUBLIC_URL:-<set R2_PUBLIC_URL in infra/.env>}"
