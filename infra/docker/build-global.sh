#!/usr/bin/env bash
# Planet-scale driver for the infra/ pipeline. Lives in docker/ but is installed as
# /usr/local/bin/ratmap-global inside the image, deliberately outside the infra tree.
#
#   ratmap global all
#   ratmap global prefetch peaks places
#   ratmap global regions contours manifest
#
# What this adds over calling the build-*.sh scripts by hand:
#
#  1. A *verified* source cache. lib.sh's cached_osm_extract already keeps each extract
#     across runs and shares it between the peaks and places builds; this points it at
#     the /work volume (OSM_CACHE_DIR) so it survives the container, and warms it up
#     front checking each file against Geofabrik's published md5 — fetch_to resumes and
#     retries but never verifies, and a truncated europe-latest would show up as missing
#     summits rather than as an error.
#
#  2. A preflight. This run takes days and hundreds of GB; finding out that /work has
#     40 GB free, or that the container is capped at 8 GB of RAM, belongs at minute one
#     and not at hour thirty.
#
#  3. Per-stage logs and timings under /work/logs, because nobody watches a three-day
#     terminal.
#
# It does not change any pipeline decision — zoom ceilings, contour intervals and source
# URLs are all still the build scripts' own defaults, overridable by the same environment
# variables as on a laptop.
set -euo pipefail

# Deliberately NOT derived from BASH_SOURCE. This script is installed outside the infra
# tree (as /usr/local/bin/ratmap-global) precisely so that bind-mounting a working copy
# over /opt/ratmap/infra/scripts — the normal way to iterate on the pipeline without
# rebuilding the image — replaces the build scripts without also hiding this driver.
INFRA_DIR="${RATMAP_INFRA_DIR:-/opt/ratmap/infra}"
SCRIPTS_DIR="$INFRA_DIR/scripts"
DIST_DIR="$INFRA_DIR/dist"
WORK_DIR="${RATMAP_WORK:-/work}"
CACHE_DIR="${RATMAP_CACHE:-$WORK_DIR/cache}"
# The same directory lib.sh's cached_osm_extract uses — the Dockerfile sets
# OSM_CACHE_DIR to it. One cache, on the volume, shared by prefetch and both builds.
OSM_CACHE="${OSM_CACHE_DIR:-$CACHE_DIR/osm}"
export OSM_CACHE_DIR="$OSM_CACHE"
LOG_DIR="$WORK_DIR/logs"

# Geofabrik's continent set covers the planet exactly once, with no overlap between
# continents (their sub-extracts overlap; the continent files do not). build-places-db.py
# still dedupes, which covers the seams.
CONTINENTS=(
  africa
  antarctica
  asia
  australia-oceania
  central-america
  europe
  north-america
  south-america
)
GEOFABRIK_BASE="${GEOFABRIK_BASE:-https://download.geofabrik.de}"

# Hard minimums, checked in preflight. Rationale in docker/README.md; briefly:
#   work: 85 GB of continent extracts + a ~35 GB working copy of the largest + exports
#   mem:  the GeoJSON intermediates are streamed a feature at a time, so the only large
#         allocation left is build-places-db.py's rows list + dedupe set — ~319 B per
#         surviving row (measured), so ~1.6 GB for the planet's ~5.1 M places+peaks.
MIN_WORK_GB="${RATMAP_MIN_WORK_GB:-150}"
MIN_DIST_GB="${RATMAP_MIN_DIST_GB:-20}"
MIN_MEM_GB="${RATMAP_MIN_MEM_GB:-4}"
REC_MEM_GB=8

ALL_STAGES=(prefetch world terrain peaks places regions contours manifest)
FORCE=""
DRY_RUN=""
SKIP_PREFLIGHT=""
PREFLIGHT_ONLY=""
stages=()

for arg in "$@"; do
  case "$arg" in
    --force)           FORCE=1 ;;
    --dry-run)         DRY_RUN="--dry-run" ;;
    --skip-preflight)  SKIP_PREFLIGHT=1 ;;
    --preflight-only)  PREFLIGHT_ONLY=1 ;;
    all)               stages=("${ALL_STAGES[@]}") ;;
    prefetch|world|terrain|peaks|places|regions|contours|manifest) stages+=("$arg") ;;
    -*)  echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)   echo "Unknown stage: $arg (known: ${ALL_STAGES[*]}, all)" >&2; exit 2 ;;
  esac
done

mkdir -p "$OSM_CACHE" "$LOG_DIR" "$DIST_DIR" "${TMPDIR:-$WORK_DIR/tmp}"

hr()  { printf '%s\n' "----------------------------------------------------------------"; }
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

gb_free() { df -PB1 "$1" 2>/dev/null | awk 'NR==2 {printf "%.0f", $4/1073741824}'; }

mem_limit_gb() {
  # Smallest of: cgroup v2 limit, cgroup v1 limit, host MemTotal. Under Docker Desktop
  # the number that actually matters is the VM's, and it is routinely 8 GB by default.
  local bytes=""
  if [ -r /sys/fs/cgroup/memory.max ]; then
    local v; v="$(cat /sys/fs/cgroup/memory.max)"
    [ "$v" != "max" ] && bytes="$v"
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    local v; v="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
    # cgroup v1 spells "unlimited" as a nonsense-large number.
    [ "$v" -lt 9223372036854000000 ] 2>/dev/null && bytes="$v"
  fi
  local host_kb; host_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  local host_bytes=$((host_kb * 1024))
  if [ -z "$bytes" ] || [ "$bytes" -gt "$host_bytes" ]; then bytes="$host_bytes"; fi
  awk -v b="$bytes" 'BEGIN {printf "%.0f", b/1073741824}'
}

preflight() {
  local work_gb dist_gb mem_gb cpus fail=0
  work_gb="$(gb_free "$WORK_DIR")"
  dist_gb="$(gb_free "$DIST_DIR")"
  mem_gb="$(mem_limit_gb)"
  cpus="$(nproc)"

  hr
  echo "preflight"
  printf '  %-28s %s GB free  (need >= %s)\n' "$WORK_DIR" "$work_gb" "$MIN_WORK_GB"
  printf '  %-28s %s GB free  (need >= %s)\n' "$DIST_DIR" "$dist_gb" "$MIN_DIST_GB"
  printf '  %-28s %s GB        (need >= %s, %s recommended)\n' "memory available" "$mem_gb" "$MIN_MEM_GB" "$REC_MEM_GB"
  printf '  %-28s %s\n' "cpus" "$cpus"
  printf '  %-28s %s\n' "source cache" "$OSM_CACHE"

  # Guarded on mountpoint existing: without the guard, a missing binary reads as
  # "not a mount" and fails preflight on a perfectly good setup.
  if command -v mountpoint >/dev/null 2>&1 \
     && ! mountpoint -q "$WORK_DIR" 2>/dev/null \
     && [ -z "${RATMAP_ALLOW_UNMOUNTED_WORK:-}" ]; then
    echo "  ! $WORK_DIR is not a mounted volume — a planet run will fill the container's"
    echo "    writable layer. Mount it (see docker/README.md) or set"
    echo "    RATMAP_ALLOW_UNMOUNTED_WORK=1 if you really mean it."
    fail=1
  fi
  [ "$work_gb" -lt "$MIN_WORK_GB" ] && { echo "  ! not enough space on $WORK_DIR"; fail=1; }
  [ "$dist_gb" -lt "$MIN_DIST_GB" ] && { echo "  ! not enough space on $DIST_DIR"; fail=1; }
  if [ "$mem_gb" -lt "$MIN_MEM_GB" ]; then
    echo "  ! ${mem_gb} GB of memory will not survive the places stage."
    echo "    build-places-db.py holds one row plus one dedupe key per surviving feature"
    echo "    (~1.6 GB for the planet). Raise the Docker VM's memory, or run peaks/places"
    echo "    a few continents at a time via PLACES_SOURCE_URLS."
    fail=1
  elif [ "$mem_gb" -lt "$REC_MEM_GB" ]; then
    echo "  ~ ${mem_gb} GB is above the floor but tight; ${REC_MEM_GB} GB is the comfortable figure."
  fi
  hr

  if [ "$fail" = 1 ]; then
    echo "preflight failed — fix the above, or re-run with --skip-preflight to override." >&2
    return 1
  fi
  return 0
}

########################################################################
# prefetch — one resumable, checksum-verified copy of each continent
########################################################################
fetch_continent() {
  local name="$1"
  local url="$GEOFABRIK_BASE/${name}-latest.osm.pbf"
  local dest="$OSM_CACHE/${name}-latest.osm.pbf"
  local md5_path="${dest}.md5"

  curl -fsS --retry 5 --retry-delay 10 --retry-all-errors -o "$md5_path" "${url}.md5" || return 1

  if [ -f "$dest" ] && (cd "$OSM_CACHE" && md5sum -c --status "$(basename "$md5_path")"); then
    log "  $name: cached and verified ($(du -h "$dest" | cut -f1))"
    return 0
  fi

  local attempt
  for attempt in 1 2; do
    log "  $name: downloading (attempt $attempt) $url"
    # -C - resumes a partial from an interrupted run. A stale partial left over from a
    # *previous* planet build fails the md5 below; attempt 2 starts clean.
    # curl's default meter emits a progress table line per second, which turns a 35 GB
    # download into thousands of lines of `docker logs`. Silent unless asked.
    local progress=--no-progress-meter
    [ -n "${RATMAP_CURL_PROGRESS:-}" ] && progress=--progress-bar
    curl -fL --retry 5 --retry-delay 10 --retry-all-errors \
      "$progress" -C - -o "$dest" "$url"

    if (cd "$OSM_CACHE" && md5sum -c --status "$(basename "$md5_path")"); then
      log "  $name: verified ($(du -h "$dest" | cut -f1))"
      return 0
    fi
    log "  $name: md5 mismatch — discarding and refetching from scratch"
    rm -f "$dest"
  done

  echo "  $name: failed md5 twice, giving up" >&2
  return 1
}

stage_prefetch() {
  # Writes into the very directory lib.sh's cached_osm_extract reads
  # (OSM_CACHE_DIR, set to /work/cache/osm in the Dockerfile), so the build scripts find
  # every continent already present and download nothing. What this stage adds over
  # letting them fetch lazily is the md5 check against Geofabrik's published digest —
  # fetch_to resumes and retries but never verifies, and a silently truncated 35 GB
  # europe-latest would surface as mysteriously missing summits, not as an error.
  if [ -n "${RATMAP_NO_CACHE:-}" ]; then
    log "RATMAP_NO_CACHE set — skipping the verified prefetch;"
    log "  the build scripts will still cache lazily into $OSM_CACHE, just unverified"
    return 0
  fi
  local c
  for c in "${CONTINENTS[@]}"; do
    # Explicit || return: these stage functions run as the condition of an `if` in the
    # driver loop below, which switches errexit off inside them — without this a failed
    # continent would be logged and the run would carry on to build a partial planet.
    fetch_continent "$c" || return 1
  done
  log "cache total: $(du -sh "$OSM_CACHE" | cut -f1)"
}

# The source list handed to build-peaks.sh / build-places.sh. Both iterate it unquoted
# and word-split on whitespace, so newline-separated is what they want.
osm_source_urls() {
  local c
  for c in "${CONTINENTS[@]}"; do
    echo "$GEOFABRIK_BASE/${c}-latest.osm.pbf"
  done
}

########################################################################
# stages
########################################################################
have_output() {  # have_output <glob...>
  local g
  for g in "$@"; do
    compgen -G "$g" > /dev/null && return 0
  done
  return 1
}

stage_world() {
  if [ -z "$FORCE" ] && have_output "$DIST_DIR/world-catalog-*.pmtiles"; then
    log "world: already built ($(ls -1 "$DIST_DIR"/world-catalog-*.pmtiles | tail -1)) — --force to redo"
    return 0
  fi
  "$SCRIPTS_DIR/build-world-catalog.sh"
}

stage_terrain() {
  if [ -z "$FORCE" ] && have_output "$DIST_DIR/terrain-global-*.pmtiles"; then
    log "terrain: already built — --force to redo"
    return 0
  fi
  "$SCRIPTS_DIR/build-terrain.sh"
}

stage_peaks() {
  if [ -z "$FORCE" ] && [ -f "$DIST_DIR/peaks-global.pmtiles" ]; then
    log "peaks: already built — --force to redo"
    return 0
  fi
  # A genuinely global peaks build: the whole point of this image. With every continent
  # present, build-peaks.sh's Ben Nevis *and* Mont Blanc assertions both run, so a
  # silent `ele` regression fails the build instead of shipping.
  PEAKS_SOURCE_URLS="$(osm_source_urls)" "$SCRIPTS_DIR/build-peaks.sh"
}

stage_places() {
  if [ -z "$FORCE" ] && [ -f "$DIST_DIR/places.sqlite" ]; then
    log "places: already built — --force to redo"
    return 0
  fi
  PLACES_SOURCE_URLS="$(osm_source_urls)" "$SCRIPTS_DIR/build-places.sh"
  log "places.sqlite is app-shell, not a bucket artifact — copy it into public/data/"
  log "  (upload.sh deliberately skips it; see infra/README.md)"
}

region_ids() {
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    for r in json.load(f)["regions"]:
        print(r["id"])
' "$INFRA_DIR/regions.json"
}

stage_regions() {
  local id
  while read -r id; do
    if [ -z "$FORCE" ] && [ -z "$DRY_RUN" ] \
       && [ -f "$DIST_DIR/regions/$id/$id-basemap.pmtiles" ] \
       && [ -f "$DIST_DIR/regions/$id/$id-terrain.pmtiles" ]; then
      log "regions/$id: already built — --force to redo"
      continue
    fi
    log "regions/$id"
    "$SCRIPTS_DIR/build-region.sh" "$id" $DRY_RUN || return 1
  done < <(region_ids)
}

stage_contours() {
  # Deliberately per-region, not global. Contours are traced from the Copernicus DEM at
  # roughly 300 MB of intermediate GeoJSON per square degree; the planet's land surface
  # is ~15,000 square degrees. That is the C14 scratch-space problem, and it is why
  # contours ship per downloaded region rather than as a global artifact.
  [ -n "$DRY_RUN" ] && { log "contours: no dry-run mode, skipping"; return 0; }
  local id
  while read -r id; do
    if [ -z "$FORCE" ] && [ -f "$DIST_DIR/regions/$id/$id-contours.pmtiles" ]; then
      log "contours/$id: already built — --force to redo"
      continue
    fi
    log "contours/$id"
    "$SCRIPTS_DIR/build-contours.sh" "$id" || return 1
  done < <(region_ids)
}

stage_manifest() {
  # Always regenerated: it records sizes, zoom ranges and sha256s of whatever is in
  # dist/ right now, so it has to run last and it has to run every time.
  python3 "$SCRIPTS_DIR/build-manifest.py"
}

########################################################################
# run
########################################################################
if [ -n "$PREFLIGHT_ONLY" ]; then
  preflight
  exit $?
fi

if [ "${#stages[@]}" -eq 0 ]; then
  echo "Nothing to do. Pick stages: ${ALL_STAGES[*]} — or 'all'." >&2
  exit 2
fi

if [ -z "$SKIP_PREFLIGHT" ]; then
  preflight
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
declare -a summary=()
overall_start=$SECONDS

for stage in "${stages[@]}"; do
  logfile="$LOG_DIR/${RUN_ID}-${stage}.log"
  hr
  log "==> stage: $stage   (log: $logfile)"
  hr
  start=$SECONDS
  if "stage_$stage" 2>&1 | tee -a "$logfile"; then
    elapsed=$((SECONDS - start))
    summary+=("$(printf '  %-10s ok      %02d:%02d:%02d' "$stage" $((elapsed/3600)) $(((elapsed%3600)/60)) $((elapsed%60)))")
    log "<== $stage done in $((elapsed / 60)) min"
  else
    elapsed=$((SECONDS - start))
    summary+=("$(printf '  %-10s FAILED  %02d:%02d:%02d' "$stage" $((elapsed/3600)) $(((elapsed%3600)/60)) $((elapsed%60)))")
    printf '%s\n' "${summary[@]}"
    echo "stage '$stage' failed — see $logfile" >&2
    exit 1
  fi
done

total=$((SECONDS - overall_start))
hr
echo "run $RUN_ID complete in $((total / 3600))h $(((total % 3600) / 60))m"
printf '%s\n' "${summary[@]}"
hr
echo "dist/:"
du -h -d 2 "$DIST_DIR" | sort -k2 | sed 's/^/  /'
