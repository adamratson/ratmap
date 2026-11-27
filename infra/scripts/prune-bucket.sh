#!/usr/bin/env bash
# Finds the files in the bucket that the live manifest no longer lists, and deletes those
# nothing has wanted for PRUNE_DAYS.
#
#   ./scripts/prune-bucket.sh [--list] [--delete] [--days N]
#
# Without --delete it only reports: how much is unlisted, how much could go now, and when
# the rest can. upload.sh runs it that way at the end of every upload. --list prints each
# file and why it waits; --days N overrides PRUNE_DAYS (default 7).
#
# Why the wait: a phone that read the manifest before it was replaced can be part-way
# through downloading a file the new one dropped, and an upload in progress puts its
# archives up before the manifest that lists them. So a file goes only once it was uploaded
# more than PRUNE_DAYS ago and no manifest live in the last PRUNE_DAYS lists it. upload.sh
# keeps every manifest it replaces under regions/manifest-history/ for this; where that
# history runs out (before 2026-11-27, when it began, or wherever something replaced the
# manifest without keeping it), nothing is deleted until that is PRUNE_DAYS ago.
# tools/cmd/upload-check/prune.go has the rules.
#
# Never touched: anything outside regions/ (the global files, which the app's own build
# names, and an older build of it can still be running on a phone), regions/manifest.json,
# and its history.
#
# Deletion is permanent: the bucket keeps no versions. Run it on its own, not while an
# upload is going up from somewhere else — though an upload's new archives are safe from
# it either way, being new.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DELETE=""
LIST=""
DAYS="${PRUNE_DAYS:-7}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --delete) DELETE=1 ;;
    --list) LIST=1 ;;
    --days) DAYS="${2:?--days needs a number}"; shift ;;
    *) echo "Usage: prune-bucket.sh [--list] [--delete] [--days N]" >&2; exit 2 ;;
  esac
  shift
done

s3_setup
require_cmd aws

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/history"
NOW="$(date +%s)"

# One listing, then the live manifest with what get-object says of it: prune checks the
# two are the same manifest, so that the history it reads is this manifest's history.
aws s3api list-objects-v2 --bucket "$S3_BUCKET" --endpoint-url "$S3_ENDPOINT" \
  --output json >"$WORK/listing.json"
aws s3api get-object --bucket "$S3_BUCKET" --key regions/manifest.json \
  --endpoint-url "$S3_ENDPOINT" "$WORK/live.json" >"$WORK/live-meta.json"

mapfile -t kept < <(go_run upload-check history "$NOW" "$DAYS" "$WORK/listing.json")
for key in ${kept[@]+"${kept[@]}"}; do
  aws s3api get-object --bucket "$S3_BUCKET" --key "$key" --endpoint-url "$S3_ENDPOINT" \
    "$WORK/history/$(basename "$key")" >/dev/null
done

go_run upload-check prune "$NOW" "$DAYS" "$WORK/listing.json" "$WORK/live.json" \
  "$WORK/live-meta.json" "$WORK/history" "$WORK/plan.tsv" | sed 's/^/  /'

if [ -n "$LIST" ]; then
  awk -F'\t' '
    function size(b) {
      if (b >= 1073741824) return sprintf("%.1f GB", b / 1073741824)
      if (b >= 1048576) return sprintf("%.0f MB", b / 1048576)
      return sprintf("%.0f kB", b / 1024)
    }
    $1 == "delete" { printf "  delete            %8s  %s\n", size($3), $2 }
    $1 == "wait"   { printf "  wait %s  %8s  %s (%s)\n", substr($4, 1, 10) " " substr($4, 12, 5), size($3), $2, $5 }
    $1 == "missing" { printf "  MISSING                     %s\n", $2 }
  ' "$WORK/plan.tsv"
fi

mapfile -t doomed < <(awk -F'\t' '$1 == "delete" { print $2 }' "$WORK/plan.tsv")
[ "${#doomed[@]}" -gt 0 ] || exit 0
if [ -z "$DELETE" ]; then
  echo "  (report only: --delete removes the ${#doomed[@]} deletable now)"
  exit 0
fi

echo "Deleting ${#doomed[@]} file(s)"
deleted=0
failed=()
for key in "${doomed[@]}"; do
  # prune never names these; checked again here because a delete cannot be undone.
  case "$key" in
    regions/manifest.json | regions/manifest-history/* | "") failed+=("$key (refused)"); continue ;;
    regions/*) ;;
    *) failed+=("$key (refused)"); continue ;;
  esac
  if aws s3api delete-object --bucket "$S3_BUCKET" --key "$key" \
       --endpoint-url "$S3_ENDPOINT" >/dev/null; then
    deleted=$((deleted + 1))
  else
    failed+=("$key")
  fi
done
echo "  deleted $deleted"
if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED to delete ${#failed[@]}:" >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi
