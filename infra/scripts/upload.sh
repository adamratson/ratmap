#!/usr/bin/env bash
# Uploads every file in infra/dist/ to Krystal Object Storage. Needs infra/.env filled in
# per infra/SETUP.md — AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET / S3_ENDPOINT
# / S3_REGION.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${S3_BUCKET:?Set S3_BUCKET in infra/.env — see infra/SETUP.md}"
: "${S3_ENDPOINT:?Set S3_ENDPOINT in infra/.env — see infra/SETUP.md}"
: "${S3_REGION:?Set S3_REGION in infra/.env — see infra/SETUP.md}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID in infra/.env — see infra/SETUP.md}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY in infra/.env — see infra/SETUP.md}"

# `pmtiles upload` (gocloud's aws-sdk-go-v2-based S3 client) fails every write against
# Krystal with a flat SigV4 "SignatureDoesNotMatch", regardless of region string or
# path-style addressing — tested 2026-08-28, not a config problem, a client incompatibility
# with Krystal's Swift-based S3 gateway. `aws s3 cp` (botocore) signs the exact same request
# successfully, so it does the uploading here instead; nothing pmtiles-specific was
# happening in the old call, it was just a multipart PUT. That also drops the pmtiles CLI
# as an upload-time dependency.
#
# aws-cli v2's default CRC32 request-checksum trailer is a separate, known incompatibility
# with non-AWS S3 gateways (hit against R2 too, see infra/docker/README.md) — force it off.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
AWS_DEFAULT_REGION="$S3_REGION"
export AWS_DEFAULT_REGION
BUCKET_URL="s3://${S3_BUCKET}"

s3_cp() {
  aws s3 cp "$1" "${BUCKET_URL}/$2" --endpoint-url "$S3_ENDPOINT" "${@:3}"
}

s3_head_size() {
  aws s3api head-object --bucket "$S3_BUCKET" --key "$1" --endpoint-url "$S3_ENDPOINT" \
    --query ContentLength --output text 2>/dev/null || echo "absent"
}

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
# that had not changed. Size is the check because a large upload goes as multipart, whose
# ETag is not the file's md5 and cannot be compared to anything local. An archive rebuilt
# at the same size is possible in principle, so FORCE_UPLOAD=1 re-pushes.
#
# Decided from one bucket listing, not a `head-object` per file. That loop was silent and
# slow in the way that reads as broken: each call is a fresh `aws` process, measured at
# 0.44 s of which 0.37 s is the CLI starting up (2026-09-11), so ~600 archives meant ~5
# minutes before the first line of output on a run with nothing new to send. A listing is
# one process and a request per thousand keys.
#
# Every way the listing can be wrong errs towards uploading, never towards skipping: a key
# it omits reads as absent, a size it misreports reads as changed. If it cannot be read at
# all, this falls back to the per-file check rather than guessing.
require_cmd aws

echo "Checking ${#files[@]} archive(s) in dist/ against the bucket"

to_upload=()
if [ "${FORCE_UPLOAD:-}" = "1" ]; then
  echo "  FORCE_UPLOAD=1 — sending all of them"
  to_upload=("${files[@]}")
else
  LISTING="$(mktemp)"
  if aws s3api list-objects-v2 --bucket "$S3_BUCKET" --endpoint-url "$S3_ENDPOINT" \
       --output json >"$LISTING" 2>"$LISTING.err" \
     && CHANGED="$(python3 - "$LISTING" "$DIST_DIR" "${files[@]}" 2>"$LISTING.err" <<'PY'
import json, os, sys
listing, dist, keys = sys.argv[1], sys.argv[2], sys.argv[3:]
text = open(listing).read().strip()
# An empty bucket lists as no output at all, not as an empty Contents array.
try:
    remote = {o["Key"]: o["Size"] for o in (json.loads(text).get("Contents") or [])} if text else {}
except (ValueError, AttributeError, KeyError, TypeError) as err:
    # One line, not a traceback: the caller prints it as the reason and falls back.
    sys.exit(f"listing was not readable JSON: {err}")
for key in keys:
    if remote.get(key) != os.path.getsize(os.path.join(dist, key)):
        print(key)
PY
)"; then
    [ -n "$CHANGED" ] && mapfile -t to_upload <<<"$CHANGED"
  else
    reason="$(head -1 "$LISTING.err" 2>/dev/null)"
    echo "  ! bucket listing unusable${reason:+ ($reason)} — checking one archive at a time" >&2
    checked=0
    for key in "${files[@]}"; do
      checked=$((checked + 1))
      # Progress, because this path is the slow one described above.
      [ $((checked % 25)) -eq 0 ] && echo "  checked $checked of ${#files[@]}"
      if [ "$(s3_head_size "$key")" != "$(wc -c < "$DIST_DIR/$key" | tr -d ' ')" ]; then
        to_upload+=("$key")
      fi
    done
  fi
  rm -f "$LISTING" "$LISTING.err"
fi

skipped=$(( ${#files[@]} - ${#to_upload[@]} ))
echo "  $skipped already present, ${#to_upload[@]} to upload"

uploaded=0
# ${arr[@]+...} rather than a bare "${arr[@]}": an empty array under `set -u` is an
# "unbound variable" error before bash 4.4, and nothing to upload is the common case.
for key in ${to_upload[@]+"${to_upload[@]}"}; do
  uploaded=$((uploaded + 1))
  echo "Uploading $key ($uploaded of ${#to_upload[@]}, $(du -h "$DIST_DIR/$key" | cut -f1))"
  s3_cp "$DIST_DIR/$key" "$key" --no-progress
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
  if aws s3 cp "${BUCKET_URL}/regions/manifest.json" "$PUBLISHED_MANIFEST" \
       --endpoint-url "$S3_ENDPOINT" --no-progress >/dev/null 2>&1; then
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
  s3_cp "$MANIFEST" "regions/manifest.json" --content-type application/json --no-progress
fi

echo "Done. Public base URL: ${PUBLIC_BASE_URL:-<set PUBLIC_BASE_URL in infra/.env>}"
