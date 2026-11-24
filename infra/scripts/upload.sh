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
# Retries. aws-cli's default is 3 attempts per request, and a multipart upload fails whole
# when one part runs out of them: on 2026-11-24 austria-contours-1 died at part 26 when the
# gateway closed the connection ("Connection was closed before we received a valid
# response"). Measured against a server that drops every part (2026-11-24): the default
# gave up after 3 attempts and ~5 s; AWS_MAX_ATTEMPTS raises it, with backoff (standard
# mode, capped at 20 s a wait), and a failed upload is still aborted, leaving no parts
# behind. Never exported empty: aws-cli then refuses every call (exit 255).
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}"
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-10}"
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
# regions/<id>/<id>-<kind>.pmtiles, and a region's search index at
# regions/<id>/<id>-places-1.sqlite — matching the `path` recorded in manifest.json. The
# top-level places.sqlite is deliberately excluded: it is the global fallback, which ships
# inside the app bundle and is service-worker precached, not fetched from the bucket.
mapfile -t files < <(cd "$DIST_DIR" && ls -1 **/*.pmtiles *.pmtiles regions/*/*-places-*.sqlite 2>/dev/null | sort -u)

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
     && CHANGED="$(go_run upload-check changed "$LISTING" "$DIST_DIR" "${files[@]}" 2>"$LISTING.err")"; then
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

# A file whose parts run out of retries is sent again whole, UPLOAD_TRIES times in all
# (aws s3 cp cannot resume a multipart upload), after a wait that grows: an outage of the
# gateway lasts longer than one request's backoff. One that fails every try is left for
# the next run, and the rest still go: a catalogue upload is hours, and one bad archive
# should not stop it. The next run sends what is missing, as it would anyway.
UPLOAD_TRIES="${UPLOAD_TRIES:-3}"
UPLOAD_RETRY_WAIT="${UPLOAD_RETRY_WAIT:-60}"   # seconds, times the try
uploaded=0
n=0
failed=()
# ${arr[@]+...} rather than a bare "${arr[@]}": an empty array under `set -u` is an
# "unbound variable" error before bash 4.4, and nothing to upload is the common case.
for key in ${to_upload[@]+"${to_upload[@]}"}; do
  n=$((n + 1))
  echo "Uploading $key ($n of ${#to_upload[@]}, $(du -h "$DIST_DIR/$key" | cut -f1))"
  try=1
  until s3_cp "$DIST_DIR/$key" "$key" --no-progress; do
    if [ "$try" -ge "$UPLOAD_TRIES" ]; then
      echo "  ! gave up on $key after $try tries" >&2
      failed+=("$key")
      continue 2
    fi
    echo "  ! $key failed (try $try of $UPLOAD_TRIES); sending it again in $((UPLOAD_RETRY_WAIT * try)) s" >&2
    sleep $((UPLOAD_RETRY_WAIT * try))
    try=$((try + 1))
  done
  uploaded=$((uploaded + 1))
done

echo "$uploaded uploaded, $skipped already present"

# The manifest would list what failed, and offer downloads that 404: stop before it. The
# published manifest stays as it was, and a failed upload leaves the bucket's copy of that
# key, if it had one, untouched.
if [ "${#failed[@]}" -gt 0 ]; then
  echo >&2
  echo "FAILED: ${#failed[@]} archive(s) could not be uploaded:" >&2
  printf '  %s\n' "${failed[@]}" >&2
  echo "The manifest was not uploaded. Run upload.sh again to send them (the rest are" >&2
  echo "already there and are skipped)." >&2
  exit 1
fi

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
  MANIFEST_GZ="$(mktemp)"
  trap 'rm -f "$PUBLISHED_MANIFEST" "$MANIFEST_GZ"' EXIT
  if aws s3 cp "${BUCKET_URL}/regions/manifest.json" "$PUBLISHED_MANIFEST" \
       --endpoint-url "$S3_ENDPOINT" --no-progress >/dev/null 2>&1; then
    MISSING="$(go_run upload-check unpublished "$PUBLISHED_MANIFEST" "$MANIFEST")"
    if [ -n "$MISSING" ]; then
      echo >&2
      echo "REFUSING TO UPLOAD: this manifest would unpublish region(s): $MISSING" >&2
      echo "Their archives are still in the bucket, but nobody could download them." >&2
      echo "Rebuild them into dist/ first, or set ALLOW_UNPUBLISH=1 if that is intended." >&2
      [ "${ALLOW_UNPUBLISH:-}" = "1" ] || exit 1
      echo "ALLOW_UNPUBLISH=1 set — continuing." >&2
    fi
  fi

  # Gzipped, with `Content-Encoding: gzip`: 387 kB of JSON -> 69 kB (measured 2026-09-24),
  # and the app fetches it at every startup and on every visit to the Offline sheet. The
  # bucket cannot compress on the fly, so it is stored compressed; browsers undo the
  # encoding transparently, before `response.json()` ever sees it. `-n` leaves the name and
  # time out of the gzip header, so an unchanged manifest uploads byte-identical.
  gzip -9 -n -c "$MANIFEST" > "$MANIFEST_GZ"
  echo "Uploading regions/manifest.json (gzip, $(wc -c < "$MANIFEST_GZ" | tr -d ' ') bytes)"
  s3_cp "$MANIFEST_GZ" "regions/manifest.json" \
    --content-type application/json --content-encoding gzip --no-progress

  # Then prove it is served that way. Gzip bytes served *without* the header are not JSON
  # to a browser, and every install would lose its catalogue at once — so if the gateway
  # dropped the header, put the plain file back and stop loudly rather than leave that up.
  if [ -n "${PUBLIC_BASE_URL:-}" ]; then
    # curl for the fetch: it is what the rest of this script already trusts to talk to the
    # bucket, and a verification that failed for a reason of its own — a Python without
    # its CA bundle did exactly that on macOS — would roll back every upload. Without
    # --compressed, curl saves the body as served, so a missing header shows up as gzip
    # bytes where JSON should be.
    SERVED_HEADERS="$(mktemp)"
    SERVED_BODY="$(mktemp)"
    trap 'rm -f "$PUBLISHED_MANIFEST" "$MANIFEST_GZ" "$SERVED_HEADERS" "$SERVED_BODY"' EXIT
    if ! curl -sS --fail --max-time 30 -H 'Accept-Encoding: gzip' -H 'Cache-Control: no-cache' \
           -D "$SERVED_HEADERS" -o "$SERVED_BODY" "${PUBLIC_BASE_URL%/}/regions/manifest.json" \
       || ! go_run upload-check served "$SERVED_HEADERS" "$SERVED_BODY" "$MANIFEST"
    then
      echo >&2
      echo "The gzipped manifest is not being served correctly — restoring the plain one." >&2
      s3_cp "$MANIFEST" "regions/manifest.json" --content-type application/json --no-progress
      exit 1
    fi
  else
    echo "PUBLIC_BASE_URL unset — could not verify how the manifest is served." >&2
  fi
fi

echo "Done. Public base URL: ${PUBLIC_BASE_URL:-<set PUBLIC_BASE_URL in infra/.env>}"
