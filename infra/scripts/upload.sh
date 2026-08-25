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

# Skip what is already up there, byte-for-byte.
#
# A global catalogue is hundreds of GB across hundreds of archives, and it is not built in
# one sitting: every run of this script after the first would otherwise re-push everything
# that had not changed. Size is the check because pmtiles upload is a multipart upload,
# whose ETag is not the file's md5 and cannot be compared to anything local. An archive
# rebuilt at the same size is possible in principle, so FORCE_UPLOAD=1 re-pushes.
require_cmd aws

remote_size() {
  AWS_DEFAULT_REGION=auto aws s3api head-object \
    --bucket "$R2_BUCKET" --key "$1" \
    --endpoint-url "https://${R2_ENDPOINT_HOST}" \
    --query ContentLength --output text 2>/dev/null || echo "absent"
}

uploaded=0
skipped=0
for key in "${files[@]}"; do
  if [ "${FORCE_UPLOAD:-}" != "1" ] && \
     [ "$(remote_size "$key")" = "$(wc -c < "$DIST_DIR/$key" | tr -d ' ')" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "Uploading $key"
  pmtiles upload "$DIST_DIR/$key" "$key" --bucket="$BUCKET_URL"
  uploaded=$((uploaded + 1))
done

echo "$uploaded uploaded, $skipped already present"

# The manifest must go up *after* the archives it describes: a client that reads a
# manifest listing artifacts which aren't uploaded yet would offer a download that 404s.
MANIFEST="$DIST_DIR/regions/manifest.json"
if [ -f "$MANIFEST" ]; then
  # Refuse to silently unpublish a region.
  #
  # The manifest describes whatever is in dist/, and dist/ is disposable scratch — one
  # `rm -rf infra/dist` and the next upload quietly drops every region that wasn't
  # rebuilt, while its archives sit orphaned in the bucket. Nearly happened: a manifest
  # naming only Montenegro was one command away from delisting Lochaber.
  PUBLISHED_MANIFEST="$(mktemp)"
  trap 'rm -f "$PUBLISHED_MANIFEST"' EXIT
  if AWS_DEFAULT_REGION=auto aws s3 cp "s3://${R2_BUCKET}/regions/manifest.json" \
       "$PUBLISHED_MANIFEST" --endpoint-url "https://${R2_ENDPOINT_HOST}" \
       --no-progress >/dev/null 2>&1; then
    MISSING="$(python3 - "$PUBLISHED_MANIFEST" "$MANIFEST" <<'PY'
import json, sys
def ids(path):
    with open(path) as f:
        return {r["id"] for r in json.load(f).get("regions", [])}
print(" ".join(sorted(ids(sys.argv[1]) - ids(sys.argv[2]))))
PY
)"
    if [ -n "$MISSING" ]; then
      echo >&2
      echo "REFUSING TO UPLOAD: this manifest would unpublish region(s): $MISSING" >&2
      echo "Their archives are still in the bucket, but nobody could download them." >&2
      echo "Rebuild them into dist/ first, or set ALLOW_UNPUBLISH=1 if that is intended." >&2
      [ "${ALLOW_UNPUBLISH:-}" = "1" ] || exit 1
      echo "ALLOW_UNPUBLISH=1 set — continuing." >&2
    fi
  fi

  echo "Uploading regions/manifest.json"
  AWS_DEFAULT_REGION=auto aws s3 cp "$MANIFEST" "s3://${R2_BUCKET}/regions/manifest.json" \
    --endpoint-url "https://${R2_ENDPOINT_HOST}" \
    --content-type application/json \
    --no-progress
fi

echo "Done. Public base URL: ${R2_PUBLIC_URL:-<set R2_PUBLIC_URL in infra/.env>}"
