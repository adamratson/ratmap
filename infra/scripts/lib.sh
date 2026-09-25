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

# Build one of dem-tools' commands (compute-prominence, encode-avalanche) into a
# directory, and print the binary's path.
#
#   BIN="$(dem_tool compute-prominence "$WORK_DIR")"
#
# Compiled from this checkout on every run, never carried in the image — the same rule as
# build-contours.sh's contour-cell, for the same reason: the pipeline is whatever the
# working copy says it is (docker/compose.yml mounts it over the image's copy), and a
# baked binary would go on running old logic after the source changed. Go's build cache
# makes this a moment after the first time. GOTOOLCHAIN=local: never fetch a toolchain.
# Into the caller's own directory, so regions built side by side never share a binary.
dem_tool() {
  local name="$1" dir="$2"
  require_cmd go
  (cd "$INFRA_DIR/scripts/dem-tools" \
    && GOTOOLCHAIN=local go build -trimpath -buildvcs=false -o "$dir/$name" "./cmd/$name") >&2 \
    || { echo "Could not build dem-tools/cmd/$name" >&2; return 1; }
  echo "$dir/$name"
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

# Everything the five OSM stages filter for, as one `osmium tags-filter` expression list:
#
#   n/natural=peak,volcano,saddle n/mountain_pass=yes   build-peaks.sh, build-places.sh
#   n/place=city,town,village,hamlet,suburb             build-places.sh
#   w/sac_scale                                         build-sac.sh
#   w/highway=path,footway,bridleway,steps,track        build-paths.sh
#   nwr/natural=scree,shingle,rock,stone                build-terrain-features.sh
#
# Each stage used to run its own tags-filter over the full extract, which at planet scale
# is 85 GB per stage and nine or ten passes in all (a node-only filter reads the input
# once, a way filter twice, nwr up to four times — osmium-tool's command_tags_filter.cpp).
# osm_subset below filters once for all of them and caches the result; each stage then
# runs its own unchanged filter over that. Byte-identical output for every stage on
# Scotland, where the subset is 33 MB of 325 MB (2026-09-23): tags-filter keeps every
# object that matches plus everything those objects reference, and a stage's filter can
# only match, and reference, what the union already kept.
#
# A stage filtering for anything not listed here would silently lose data, so osm_subset
# refuses to run for one — add the expression here first.
RATMAP_OSM_SUBSET_FILTER="
  n/natural=peak,volcano,saddle n/mountain_pass=yes
  n/place=city,town,village,hamlet,suburb
  w/sac_scale
  w/highway=path,footway,bridleway,steps,track
  nwr/natural=scree,shingle,rock,stone
"

# osm_subset <extract.osm.pbf> <this stage's tags-filter expressions...>
#
# Prints the path of the shared subset of <extract>, building it on first use. Cached
# beside the extracts, keyed on the union above and on the extract's size and mtime, so a
# changed union or a re-downloaded extract builds a fresh one; older subsets of the same
# extract are removed when it does. RATMAP_NO_OSM_SUBSET=1 hands back the extract itself.
osm_subset() {
  local src="$1"
  shift
  local union expr
  union=" $(echo $RATMAP_OSM_SUBSET_FILTER) "
  for expr in "$@"; do
    case "$union" in
      *" $expr "*) ;;
      *) echo "osm_subset: '$expr' is not in RATMAP_OSM_SUBSET_FILTER (lib.sh). Add it" \
              "there first — filtering the shared subset for it would silently drop data." >&2
         exit 1 ;;
    esac
  done

  if [ -n "${RATMAP_NO_OSM_SUBSET:-}" ]; then
    echo "$src"
    return 0
  fi

  local key base dir out tmp
  key="$(python3 - "$src" "$union" <<'PY_KEY'
import hashlib, os, sys
st = os.stat(sys.argv[1])
union = hashlib.sha1(" ".join(sys.argv[2].split()).encode()).hexdigest()[:12]
print(f"{union}-{st.st_size}-{int(st.st_mtime)}")
PY_KEY
)"
  base="$(basename "${src%.osm.pbf}")"
  dir="$OSM_CACHE_DIR/subsets"
  out="$dir/$base.$key.osm.pbf"

  if [ -s "$out" ]; then
    echo "  shared subset $(basename "$out") ($(du -h "$out" | cut -f1))" >&2
    echo "$out"
    return 0
  fi

  mkdir -p "$dir"
  rm -f "$dir/$base".*.osm.pbf
  echo "  building the shared OSM subset of $base (one pass for all five OSM stages)" >&2
  # Still ends in .osm.pbf: osmium picks the output format from the extension. The
  # leading dot keeps a half-written file out of the glob above and out of the cache.
  tmp="$dir/.$base.$key.$$.osm.pbf"
  # shellcheck disable=SC2086
  osmium tags-filter "$src" $RATMAP_OSM_SUBSET_FILTER -o "$tmp" --overwrite >&2
  mv -f "$tmp" "$out"
  echo "  shared subset $(basename "$out") ($(du -h "$out" | cut -f1))" >&2
  echo "$out"
}

# Copernicus DEM clips, cached by fetch-dem.sh. Beside the OSM cache, the same placement
# build-paths.sh uses for its tilesets: infra/.cache/dem on a laptop (gitignored with the
# rest of .cache), /work/cache/dem in the image, where OSM_CACHE_DIR points at the volume.
# `-` rather than `:-`, so an explicitly empty DEM_CACHE_DIR= switches caching off.
DEM_CACHE_DIR="${DEM_CACHE_DIR-$(dirname "$OSM_CACHE_DIR")/dem}"

# Memory this process may actually use, in whole GB.
#
# Smallest of: a cgroup v2 limit, a cgroup v1 limit, and the host's own total. Under
# Docker Desktop the number that matters is the VM's, and it is routinely 8 GB by
# default — so a container reading /proc/meminfo alone would size its worker pool for a
# machine it cannot have.
#
# docker/build-global.sh carries its own copy of this rather than calling here: it is
# installed at /usr/local/bin/ratmap-global, deliberately outside the infra tree, so that
# bind-mounting a working copy of scripts/ cannot hide the driver. The cost of that is
# this one duplicated function; keep the two in step.
available_memory_gb() {
  local bytes="" limit host_bytes

  if [ -r /sys/fs/cgroup/memory.max ]; then
    limit="$(cat /sys/fs/cgroup/memory.max)"
    [ "$limit" != "max" ] && bytes="$limit"
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    limit="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
    # cgroup v1 spells "unlimited" as a nonsense-large number.
    [ "$limit" -lt 9223372036854000000 ] 2>/dev/null && bytes="$limit"
  fi

  if [ -r /proc/meminfo ]; then
    host_bytes=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) * 1024 ))
  else
    # macOS, for anyone running a build straight off a laptop.
    host_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  fi

  if [ -z "$bytes" ] || { [ "$host_bytes" -gt 0 ] && [ "$bytes" -gt "$host_bytes" ]; }; then
    bytes="$host_bytes"
  fi
  echo $(( bytes / 1073741824 ))
}

# Cores this process may actually use.
#
# `getconf` rather than `nproc`: nproc is GNU coreutils and absent on a Mac, where these
# scripts are run by hand often enough to matter. A cgroup cpu quota is deliberately not
# read: it throttles, it does not kill, so a worker pool sized past it finishes late
# rather than dying — unlike memory, where the kernel's answer is the OOM killer.
cpu_count() {
  local n
  n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  [ "${n:-0}" -ge 1 ] 2>/dev/null || n=1
  echo "$n"
}

# Memory to leave for everything that is not a worker: the page cache these stages lean
# on, the kernel, and the driver itself. A whole GB because the smallest supported host
# is 4 GB and the stages that matter here are the ones that OOM at the top end.
RATMAP_MEM_RESERVE_GB="${RATMAP_MEM_RESERVE_GB:-1}"

usable_memory_gb() {
  local total
  total="$(available_memory_gb)"
  # 0 means "could not tell" (no /proc/meminfo, no sysctl), not "no memory".
  [ "$total" -eq 0 ] && { echo 0; return; }
  local usable=$(( total - RATMAP_MEM_RESERVE_GB ))
  [ "$usable" -lt 1 ] && usable=1
  echo "$usable"
}

# workers_for_budget <gb_per_worker> [cap] — how many workers this box can actually hold.
#
# The pattern build-paths.sh established and every parallel stage now shares: take the
# per-worker cost that stage measured (docker/README.md keeps the table), divide the
# memory this process can really see, and clamp to the cores and to whatever cap the
# stage has its own reasons for. Floor of 1 — a stage that cannot afford one worker still
# has to run, and the preflight is what refuses a host that truly cannot.
#
# With memory unknown, this falls back to cores and the cap rather than to 1: a box that
# cannot report its own memory is usually a Mac, not a small one.
workers_for_budget() {
  local per_worker="$1" cap="${2:-0}"
  local cpus mem affordable
  cpus="$(cpu_count)"
  mem="$(usable_memory_gb)"

  if [ "$mem" -eq 0 ]; then
    affordable="$cpus"
  else
    # awk, not bash: per-worker costs are fractional (1.25 GB for a DEM fetch).
    affordable="$(awk -v m="$mem" -v p="$per_worker" 'BEGIN { print int(m / p) }')"
  fi

  [ "$affordable" -gt "$cpus" ] && affordable="$cpus"
  [ "$cap" -gt 0 ] && [ "$affordable" -gt "$cap" ] && affordable="$cap"
  [ "$affordable" -lt 1 ] && affordable=1
  echo "$affordable"
}
