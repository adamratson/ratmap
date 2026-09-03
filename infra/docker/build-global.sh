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
#  1. A *verified, pinned* source cache. lib.sh's cached_osm_extract already keeps each
#     extract across runs and shares it between the peaks and places builds; this points
#     it at the /work volume (OSM_CACHE_DIR) so it survives the container, and warms it
#     up front checking each file against Geofabrik's published md5 — fetch_to resumes
#     and retries but never verifies, and a truncated europe extract would show up as
#     missing summits rather than as an error. The continents are pinned to dated
#     snapshots (europe-260823.osm.pbf, not europe-latest.osm.pbf) so that a run
#     spanning days is one coherent planet rather than a smear across several.
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
REPIN=""
stages=()

for arg in "$@"; do
  case "$arg" in
    --force)           FORCE=1 ;;
    --dry-run)         DRY_RUN="--dry-run" ;;
    --skip-preflight)  SKIP_PREFLIGHT=1 ;;
    --preflight-only)  PREFLIGHT_ONLY=1 ;;
    --repin)           REPIN=1 ;;
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

# GB the regions stage still has to write, from the catalogue's own estimates.
#
# MIN_DIST_GB's default of 20 was written when the catalogue was four regions. It is now
# several hundred, and dist/ is a bind mount onto the host's disk — so the failure this
# guards against is a twenty-hour run dying of ENOSPC somewhere in the middle, with no
# way to tell how far it got. Counts only regions whose basemap is not already built, so
# a resumed run asks for what it still needs rather than for the whole catalogue again.
catalogue_dist_gb() {
  python3 -c '
import json, pathlib, sys
dist = pathlib.Path(sys.argv[2]) / "regions"
total = 0
with open(sys.argv[1]) as f:
    for r in json.load(f)["regions"]:
        rid = r["id"]
        if (dist / rid / (rid + "-basemap.pmtiles")).exists():
            continue
        total += r.get("estimatedBytes", 0)
# 10% headroom: the estimates are two significant figures, and contours are not in them.
print(int(total * 1.1 / 1e9))
' "$INFRA_DIR/regions.json" "$DIST_DIR"
}

preflight() {
  local work_gb dist_gb mem_gb cpus fail=0

  # Only when this run is actually building regions — a peaks-only run must not be told
  # it needs 250 GB of output space.
  if printf '%s\n' "${stages[@]}" | grep -qx regions; then
    local need_dist
    need_dist="$(catalogue_dist_gb)"
    [ "${need_dist:-0}" -gt "$MIN_DIST_GB" ] && MIN_DIST_GB="$need_dist"
  fi
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

  # The free-space figure above is the VM's, and on Docker Desktop the VM's disk is a
  # sparse file on the host: it reports its *virtual* size (routinely 400 GB+) while only
  # the used blocks are actually backed. A run can therefore sail through this check and
  # still die of ENOSPC when the host fills. Nothing inside the container can see the
  # host's free space, so this can only be flagged, not checked.
  if df -PT "$WORK_DIR" 2>/dev/null | awk 'NR==2 {exit !($2 == "overlay" || $2 == "ext4")}'; then
    echo "  ~ $WORK_DIR is inside the Docker VM. If that VM's disk is a sparse image"
    echo "    (Docker Desktop's default), the $work_gb GB above is virtual — check the"
    echo "    HOST has room for it, or bind-mount $WORK_DIR to a real disk. A planet run"
    echo "    needs ~105 GB live at peak (85 GB of extracts + contour scratch + output)."
  fi

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
# How far back to look when pinning, and the file the resolved pins live in. The pin
# file sits in the cache next to the extracts it names, because that is exactly the
# scope it is valid for: throw the cache away and the pins mean nothing.
PIN_LOOKBACK_DAYS="${RATMAP_PIN_LOOKBACK_DAYS:-8}"
PIN_FILE="$OSM_CACHE/pinned-sources.tsv"

snapshot_date() {  # snapshot_date <days-ago> -> YYMMDD
  # GNU date in the image; the BSD fallback is for running this on a Mac by hand.
  date -u -d "$1 days ago" +%y%m%d 2>/dev/null || date -u -v-"$1"d +%y%m%d
}

# Echoes the md5 digest at a Geofabrik .md5 URL; non-zero if the URL did not serve a
# readable one.
#
# Deliberately not `md5sum -c`: -c matches on the *filename* recorded in the .md5, and
# that name is not stable across Geofabrik's hosts. The origin rewrites it to
# "europe-latest.osm.pbf"; the mirror it redirects the big continents to serves the file
# it actually has on disk, "europe-260823.osm.pbf". -c would go looking for that dated
# name in the cache, not find it, and condemn a perfectly good 35 GB download.
published_md5() {
  local md5_url="$1" md5_path="$2" want
  # -L is not optional. download.geofabrik.de 302s the larger continents (europe and
  # north-america at the time of writing) to ftp5.gwdg.de, and -f does not fail on a 3xx,
  # so without -L curl writes the redirect's HTML body into the .md5 and every check
  # afterwards dies with "no properly formatted checksum lines found".
  # --retry-connrefused, deliberately NOT --retry-all-errors. resolve_pin calls this to
  # probe dates that may not exist, and --retry-all-errors retries 404s: measured at
  # 51.7s to establish that a snapshot is missing, against 0.29s here. Transient and 5xx
  # failures still retry, which is the case that actually wants retrying.
  curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused -o "$md5_path" "$md5_url" || return 1
  want="$(awk 'NR == 1 { print $1 }' "$md5_path" 2>/dev/null)"
  case "$want" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) return 1 ;;
  esac
  printf '%s' "$want"
}

file_md5_is() {  # file_md5_is <path> <expected-hex>
  [ -f "$1" ] && [ "$(md5sum < "$1" | cut -d' ' -f1)" = "$2" ]
}

# Resolve one continent to a dated Geofabrik snapshot. Echoes "<basename>\t<md5>".
#
# Why dated rather than "-latest": Geofabrik regenerates <continent>-latest.osm.pbf
# every day, and keeps the dated files for about a week (measured 2026-08-24: six days
# back, then 404; first-of-month snapshots stick around far longer as archives). A
# planet run takes days. Verifying against "-latest" therefore means
# checking yesterday's bytes against today's digest — a guaranteed mismatch partway
# through the run, and a 35 GB refetch of a file that was never corrupt. Pinning once,
# up front, makes the whole run one coherent snapshot of the planet instead of a
# smear across however many days the run happens to span.
#
# Resolved per continent, not once globally: the daily rebuilds do not land
# simultaneously, so inside the rollover window some continents have today's file and
# some still only have yesterday's. A day of skew between disjoint continent extracts
# is meaningless; a run that dies because one continent had not rebuilt yet is not.
#
# The dated URLs are also served from the origin rather than 302'd to a mirror, so
# pinning sidesteps the mirror inconsistency that made this necessary in the first place.
resolve_pin() {
  local name="$1" d dt base want
  for (( d = 0; d < PIN_LOOKBACK_DAYS; d++ )); do
    dt="$(snapshot_date "$d")"
    base="${name}-${dt}.osm.pbf"
    # A 200 on the .md5 proves the snapshot exists *and* hands us its digest, so this
    # is one request, not a probe followed by a fetch.
    # Quiet: today's snapshot legitimately does not exist yet for part of every day, so
    # a 404 here is the normal path, not a fault. A real failure is reported by the
    # "no dated snapshot" line once the whole window has been tried.
    if want="$(published_md5 "$GEOFABRIK_BASE/${base}.md5" "$OSM_CACHE/${base}.md5" 2>/dev/null)"; then
      printf '%s\t%s' "$base" "$want"
      return 0
    fi
    rm -f "$OSM_CACHE/${base}.md5"
  done
  echo "  $name: no dated snapshot in the last $PIN_LOOKBACK_DAYS days at $GEOFABRIK_BASE" >&2
  return 1
}

pin_lookup() {  # pin_lookup <continent> -> "<basename>\t<md5>"
  [ -f "$PIN_FILE" ] || return 1
  awk -F'\t' -v c="$1" '$1 == c { printf "%s\t%s", $2, $3; found = 1 } END { exit !found }' "$PIN_FILE"
}

pin_for() {  # pin_for <continent> -> "<basename>\t<md5>", resolving and recording once
  local name="$1" pin
  if pin="$(pin_lookup "$name")"; then
    printf '%s' "$pin"
    return 0
  fi
  pin="$(resolve_pin "$name")" || return 1
  printf '%s\t%s\n' "$name" "$pin" >> "$PIN_FILE"
  printf '%s' "$pin"
}

url_exists() { curl -fsSL --retry 3 --retry-delay 5 -o /dev/null -r 0-0 "$1"; }

fetch_continent() {
  local name="$1" pin base want url dest

  pin="$(pin_for "$name")" || return 1
  base="${pin%%$'\t'*}"
  want="${pin##*$'\t'}"
  url="$GEOFABRIK_BASE/$base"
  dest="$OSM_CACHE/$base"

  if file_md5_is "$dest" "$want"; then
    log "  $name: cached and verified — $base ($(du -h "$dest" | cut -f1))"
    return 0
  fi

  # Reclaim a "-latest" download from before this script pinned dates, or from a
  # RATMAP_NO_CACHE run where the build scripts fetched lazily. If the bytes hash to the
  # pinned snapshot's digest then they *are* that snapshot, whatever the file is called,
  # and adopting it saves re-downloading up to 35 GB to arrive at the same file.
  local legacy="$OSM_CACHE/${name}-latest.osm.pbf"
  if [ ! -f "$dest" ] && [ -f "$legacy" ]; then
    log "  $name: checking cached ${name}-latest.osm.pbf against $base"
    if file_md5_is "$legacy" "$want"; then
      log "  $name: adopted it as $base — no re-download needed"
      mv -f "$legacy" "$dest"
      return 0
    fi
    log "  $name: it is a different snapshot; leaving it alone"
  fi

  # An aged-out pin is a 404, not a slow download. Catch it here so it reads as "re-pin"
  # rather than as two mystifying failed attempts at a file that is simply gone.
  if [ ! -f "$dest" ] && ! url_exists "$url"; then
    echo "  $name: $base is no longer on the server." >&2
    echo "    Geofabrik keeps roughly a week of daily snapshots and this pin has aged out." >&2
    echo "    Re-run the prefetch stage with --repin to pin a current one." >&2
    return 1
  fi

  local attempt
  for attempt in 1 2; do
    log "  $name: downloading (attempt $attempt) $url"
    # curl's default meter emits a progress table line per second, which turns a 35 GB
    # download into thousands of lines of `docker logs`. Silent unless asked.
    local progress=--no-progress-meter
    [ -n "${RATMAP_CURL_PROGRESS:-}" ] && progress=--progress-bar

    # -C - resumes a partial from an interrupted run, which is worth having on a 35 GB
    # continent — and now that the target is a dated file rather than "-latest", the
    # resume is always resuming the same bytes it started on. A refusal (a leftover
    # already >= the current length draws `curl: (33) ... Cannot resume`) falls straight
    # through to a clean download rather than eating a whole attempt.
    if [ -f "$dest" ]; then
      curl -fL --retry 2 --retry-delay 5 --retry-all-errors \
        "$progress" -C - -o "$dest" "$url" \
        || { log "  $name: cannot resume the cached partial — restarting from scratch"; rm -f "$dest"; }
    fi
    if [ ! -f "$dest" ]; then
      curl -fL --retry 5 --retry-delay 10 --retry-all-errors \
        "$progress" -o "$dest" "$url"
    fi

    if file_md5_is "$dest" "$want"; then
      log "  $name: verified ($(du -h "$dest" | cut -f1))"
      return 0
    fi
    if [ "$attempt" = 1 ]; then
      log "  $name: md5 mismatch — discarding and refetching from scratch"
      rm -f "$dest"
    fi
  done

  # Keep the bytes rather than rm them. This is up to 35 GB and, on a domestic line,
  # several hours; renaming it aside leaves it for inspection (`osmium fileinfo`, a
  # manual md5sum against a different mirror) while still making sure the next run's
  # `-C -` cannot resume on top of a file we already know is wrong.
  mv -f "$dest" "${dest}.unverified" 2>/dev/null || true
  echo "  $name: failed md5 twice, giving up" >&2
  echo "    kept the last download as ${dest}.unverified" >&2
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
  if [ -n "$REPIN" ] && [ -f "$PIN_FILE" ]; then
    log "--repin: discarding the existing pins in $PIN_FILE"
    rm -f "$PIN_FILE"
  fi

  local c
  for c in "${CONTINENTS[@]}"; do
    # Explicit || return: these stage functions run as the condition of an `if` in the
    # driver loop below, which switches errexit off inside them — without this a failed
    # continent would be logged and the run would carry on to build a partial planet.
    fetch_continent "$c" || return 1
  done

  # Worth printing in full: every later stage reads these pins, and when someone comes
  # back to a three-day-old log asking "which planet is this build of?", this is the
  # answer.
  log "pinned snapshots ($PIN_FILE):"
  awk -F'\t' '{ printf "    %-20s %s\n", $1, $2 }' "$PIN_FILE"
  log "cache total: $(du -sh "$OSM_CACHE" | cut -f1)"

  # Repinning does not delete the previous snapshot's extracts, and at ~85 GB a set that
  # is disk is the binding constraint on this whole run (see preflight). Flag orphans
  # rather than letting a later stage die of ENOSPC with no explanation.
  local orphans
  orphans="$(cd "$OSM_CACHE" && ls -1 ./*.osm.pbf 2>/dev/null | sed 's|^\./||' \
    | grep -vxF -f <(cut -f2 "$PIN_FILE") || true)"
  if [ -n "$orphans" ]; then
    log "extracts in the cache that no current pin refers to — safe to delete:"
    printf '%s\n' "$orphans" | sed 's/^/    /'
    log "  $(printf '%s\n' "$orphans" | sed "s|^|$OSM_CACHE/|" | xargs du -ch 2>/dev/null | tail -1 | cut -f1) reclaimable"
  fi
}

# The source list handed to build-peaks.sh / build-places.sh. Both iterate it unquoted
# and word-split on whitespace, so newline-separated is what they want.
#
# These are the *pinned* dated URLs, which matters for more than consistency:
# cached_osm_extract derives its cache filename from the URL's basename, so handing it
# the same dated URL prefetch downloaded is what makes it find the file already there
# and fetch nothing. Hand it "-latest" instead and it would download a second, differently
# named copy of every continent — another 85 GB, and a different snapshot to boot.
#
# Falls back to "-latest" only when there are no pins at all, i.e. prefetch was skipped
# (RATMAP_NO_CACHE) or never run, which is the documented unverified-lazy-fetch path.
osm_source_urls() {
  local c pin
  for c in "${CONTINENTS[@]}"; do
    if pin="$(pin_lookup "$c")"; then
      echo "$GEOFABRIK_BASE/${pin%%$'\t'*}"
    else
      echo "$GEOFABRIK_BASE/${c}-latest.osm.pbf"
    fi
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

# Region ids from the catalogue. With an argument, only those opting into that key —
# used by the contours stage, which must not run over the whole catalogue.
#
# RATMAP_REGION_FILTER is an extended-regexp over ids, so a global build can be done a
# continent at a time (`RATMAP_REGION_FILTER='^(fr|de|ch|at|it)' ratmap global regions`)
# rather than as one multi-day block that has to succeed all at once.
region_ids() {
  python3 -c '
import json, re, sys
flag = sys.argv[2] if len(sys.argv) > 2 else None
pattern = re.compile(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
with open(sys.argv[1]) as f:
    for r in json.load(f)["regions"]:
        if flag and not r.get(flag):
            continue
        if pattern and not pattern.search(r["id"]):
            continue
        # `id<space>wants-terrain`, so the skip check knows which artifacts to expect.
        print(r["id"], 0 if r.get("terrain") is False else 1)
' "$INFRA_DIR/regions.json" "${1:-}" "${RATMAP_REGION_FILTER:-}"
}

# One bad region must not end a run of several hundred. A malformed bbox failed on
# Antarctica after Africa had finished, and took every continent not yet reached with it —
# hours of downloads abandoned over one region that could have been skipped. Failures are
# collected and reported at the end; the stage still fails, so nothing downstream treats a
# partial catalogue as complete.
stage_regions() {
  local id wants_terrain
  local -a failed=()
  while read -r id wants_terrain; do
    if [ -z "$FORCE" ] && [ -z "$DRY_RUN" ] \
       && [ -f "$DIST_DIR/regions/$id/$id-basemap.pmtiles" ] \
       && { [ "$wants_terrain" = 0 ] || [ -f "$DIST_DIR/regions/$id/$id-terrain.pmtiles" ]; }; then
      log "regions/$id: already built — --force to redo"
      continue
    fi
    log "regions/$id"
    if ! "$SCRIPTS_DIR/build-region.sh" "$id" $DRY_RUN; then
      log "regions/$id FAILED — continuing with the rest"
      failed+=("$id")
    fi
  done < <(region_ids)

  if [ "${#failed[@]}" -gt 0 ]; then
    log "regions: ${#failed[@]} of the catalogue failed: ${failed[*]}"
    return 1
  fi
}

stage_contours() {
  # Deliberately per-region, not global. Contours are traced from the Copernicus DEM at
  # roughly 300 MB of intermediate GeoJSON per square degree; the planet's land surface
  # is ~15,000 square degrees. That is the C14 scratch-space problem, and it is why
  # contours ship per downloaded region rather than as a global artifact.
  [ -n "$DRY_RUN" ] && { log "contours: no dry-run mode, skipping"; return 0; }

  # Only regions that opt in with "contours": true. Contours are the most expensive
  # artifact by a wide margin — roughly 300 MB of intermediate GeoJSON per square degree
  # — and the catalogue now covers the globe. Running this over every region is the
  # planet-contour build the spec says never to attempt (C14, §4 Phase 2), reached by
  # accident rather than by decision.
  local id
  local -a ids=()
  while read -r id _; do
    if [ -z "$FORCE" ] && [ -f "$DIST_DIR/regions/$id/$id-contours.pmtiles" ]; then
      log "contours/$id: already built — --force to redo"
      continue
    fi
    ids+=("$id")
  done < <(region_ids contours)

  if [ "${#ids[@]}" -eq 0 ]; then
    log "contours: nothing to build"
    return 0
  fi

  # gdal_contour has no multithreading of its own, and each region is fully independent
  # work — own bbox, own tmp dir, own output file — so the parallelism worth having is
  # across regions, not inside one. Defaults to the host's own core count (preflight
  # already reports it above); override with RATMAP_CONTOURS_PARALLEL on a
  # memory-constrained host, since N concurrent runs cost roughly N times one region's
  # peak scratch space (the ~300 MB/sq-degree GeoJSON intermediate above), not a shared
  # pool.
  local parallel="${RATMAP_CONTOURS_PARALLEL:-$(nproc)}"
  log "contours: building ${#ids[@]} region(s), $parallel at a time"

  # Each worker's full build-contours.sh output goes to its own log rather than straight
  # to stdout — with several running at once, unredirected output would interleave line
  # by line into the shared stage log ($LOG_DIR/${RUN_ID}-contours.log, via the `tee` in
  # the run loop below) and be unreadable. Only a one-line OK/FAIL per region crosses
  # back, same idiom as fetch-dem.sh's check_one.
  build_one_contour() {
    local id="$1"
    if "$SCRIPTS_DIR/build-contours.sh" "$id" > "$LOG_DIR/${RUN_ID}-contours-$id.log" 2>&1; then
      printf 'OK\t%s\n' "$id"
    else
      printf 'FAIL\t%s\n' "$id"
    fi
  }
  export -f build_one_contour
  export SCRIPTS_DIR LOG_DIR RUN_ID

  local -a failed=()
  local status rid
  while IFS=$'\t' read -r status rid; do
    if [ "$status" = OK ]; then
      log "contours/$rid: done"
    else
      log "contours/$rid FAILED — see $LOG_DIR/${RUN_ID}-contours-$rid.log — continuing with the rest"
      failed+=("$rid")
    fi
  done < <(printf '%s\n' "${ids[@]}" | xargs -P "$parallel" -I{} bash -c 'build_one_contour "$@"' _ {})

  if [ "${#failed[@]}" -gt 0 ]; then
    log "contours: ${#failed[@]} failed: ${failed[*]}"
    return 1
  fi
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
