# Sourced by every script in this directory. Not meant to be run directly.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$INFRA_DIR/dist"
mkdir -p "$DIST_DIR"

if [ -f "$INFRA_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$INFRA_DIR/.env"
  set +a
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1 — see infra/README.md for install steps" >&2
    exit 1
  }
}

# Download to a path, resuming and retrying.
#
# OSM extracts are hundreds of MB (europe-latest is ~35 GB) and Geofabrik drops
# connections. A bare `curl -sL` gives up on the first blip — which is how a Scotland
# rebuild died with curl exit 56 after several minutes, and how a multi-day global run
# would lose an hour's transfer.
#
#   --fail          treat 4xx/5xx as an error rather than saving the error page as data
#   --retry         retry transient failures, backing off
#   --continue-at - resume a partial file instead of restarting
#
# Downloads to a `.part` file and only moves it into place once curl reports success, so
# an interrupted transfer can never be mistaken for a complete extract. Same reasoning as
# the app's region downloader.
fetch_to() {
  local url="$1" dest="$2"
  local part="$dest.part"

  echo "  fetching $(basename "$dest")"
  curl -L --fail --retry 5 --retry-delay 5 --retry-connrefused \
    --continue-at - --progress-bar "$url" -o "$part"
  mv "$part" "$dest"
}

# Path to a URL's cached copy, downloading it first if absent.
#
# Source extracts live outside the per-run temp dir so a failed or repeated build doesn't
# re-download hundreds of MB — re-running the places stage after the peaks stage then
# costs no transfer at all. Prints the path on stdout; progress goes to stderr so callers
# can capture the path cleanly.
OSM_CACHE_DIR="${OSM_CACHE_DIR:-$INFRA_DIR/.cache/osm}"

cached_osm_extract() {
  local url="$1"
  local name
  name="$(basename "${url%%\?*}")"
  local dest="$OSM_CACHE_DIR/$name"

  mkdir -p "$OSM_CACHE_DIR"
  if [ ! -s "$dest" ]; then
    fetch_to "$url" "$dest" >&2
  else
    echo "  cached $name ($(du -h "$dest" | cut -f1))" >&2
  fi
  echo "$dest"
}
