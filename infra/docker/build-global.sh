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

ALL_STAGES=(prefetch world terrain peaks sac paths terrain-features places regions contours avalanche manifest)
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
    prefetch|world|terrain|peaks|sac|paths|terrain-features|places|regions|contours|avalanche|manifest) stages+=("$arg") ;;
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

# --- sizing the worker pools ---------------------------------------------------------
#
# Every parallel stage takes the per-worker cost it was measured at (docker/README.md
# keeps the table) and asks what this box can hold, rather than carrying a number that
# assumed one. The same helpers live in scripts/lib.sh for stages run directly; this
# driver deliberately does not source lib.sh (see available_memory_gb's note there), so
# they are duplicated here — keep the two in step.

# Exported: the stages source scripts/lib.sh, which reads the same variable, so a run
# that reserves more (or less) reserves it everywhere rather than only in this driver.
export RATMAP_MEM_RESERVE_GB="${RATMAP_MEM_RESERVE_GB:-1}"

usable_mem_gb() {
  local total; total="$(mem_limit_gb)"
  local usable=$(( total - RATMAP_MEM_RESERVE_GB ))
  [ "$usable" -lt 1 ] && usable=1
  echo "$usable"
}

# workers_for_budget <gb_per_worker> [cap] — see scripts/lib.sh.
workers_for_budget() {
  local per_worker="$1" cap="${2:-0}" cpus affordable
  cpus="$(nproc)"
  affordable="$(awk -v m="$(usable_mem_gb)" -v p="$per_worker" 'BEGIN { print int(m / p) }')"
  [ "$affordable" -gt "$cpus" ] && affordable="$cpus"
  [ "$cap" -gt 0 ] && [ "$affordable" -gt "$cap" ] && affordable="$cap"
  [ "$affordable" -lt 1 ] && affordable=1
  echo "$affordable"
}

# How the contours stage spends the box, as "<regions at once> <cells each>".
#
# build-contours.sh traces every region in cells of at most 3600 DEM pixels a side and
# budgets CONTOURS_CELL_GB for one (measured at 281 MB, 2026-09-25; see there), so the
# cost of a region no longer depends on its size. It used to be estimated from Corsica's
# 6.4 GB, scaled by the square root of area, which came to 70 GB for morocco; that figure
# was GDAL's GeoJSON writer, not the tracing, and cells bound the rest.
#
# So the box is <slots> cells at once, after the DEM fetch-ahead that runs beside them
# (RATMAP_CONTOURS_FETCH_AHEAD fetches, FETCH_DEM_GB each), and no more than its cores.
# They are split between regions: two at a time by default, so one region's serial tail
# (joining its cells, tippecanoe) overlaps the next one's tracing, and each gets half the
# cells. RATMAP_CONTOURS_PARALLEL sets the regions and RATMAP_CONTOURS_CELL_WORKERS the
# cells each, both still held to what the box can hold.
CONTOURS_CELL_GB=1
contours_workers() {
  local slots regions cells
  slots="$(awk -v m="$(usable_mem_gb)" -v a="${RATMAP_CONTOURS_FETCH_AHEAD:-2}" \
             -v f="$FETCH_DEM_GB" -v c="$CONTOURS_CELL_GB" \
             'BEGIN { s = int((m - a * f) / c); print (s < 1 ? 1 : s) }')"
  [ "$slots" -gt "$(nproc)" ] && slots="$(nproc)"
  regions="${RATMAP_CONTOURS_PARALLEL:-2}"
  [ "$regions" -gt "$slots" ] && regions="$slots"
  [ "$regions" -lt 1 ] && regions=1
  cells="${RATMAP_CONTOURS_CELL_WORKERS:-$(( slots / regions ))}"
  [ "$(( cells * regions ))" -gt "$slots" ] && cells=$(( slots / regions ))
  [ "$cells" -lt 1 ] && cells=1
  echo "$regions $cells"
}

# overlapping_io_parallel <gb_per_worker> <max> — for the stages whose workers spend most
# of their time on the network.
#
# regions and avalanche both overlap downloads with a little compute, so past a handful
# of workers they stop buying throughput long before they stop costing memory. Both are
# therefore capped at <max> however large the host is, and at half its cores below that:
# each worker still has compute of its own (a tippecanoe, a WebP pass that takes a thread
# per core divided by this very number), and on a 2-core floor host the old sequential
# behaviour is the right one.
overlapping_io_parallel() {
  local per_worker="$1" max="$2"
  local cap=$(( $(nproc) / 2 ))
  [ "$cap" -lt 1 ] && cap=1
  [ "$cap" -gt "$max" ] && cap="$max"
  workers_for_budget "$per_worker" "$cap"
}

# PROM_FETCH_WORKERS this box can afford, using the same model the preflight checks with:
# the largest pairing of "region being scored" plus "DEM fetches running ahead".
peaks_fetch_workers() {
  local usable w need
  usable="$(usable_mem_gb)"
  for w in 3 2 1; do
    need="$(PROM_FETCH_WORKERS="$w" peaks_mem_gb | awk '{print $1}')"
    [ "$need" -le "$usable" ] && { echo "$w"; return; }
  done
  echo 1
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

# Memory the peaks stage's prominence pass needs, as "<GB> <largest region> <its Mpx>".
#
# compute-prominence (scripts/dem-tools) scores one region's 90 m DEM at a time, holding
# the raster and a union-find of the same shape: ~9.1 bytes a pixel, measured at 1.30 GB
# on Scotland's 143 Mpx (2026-09-25), and it hands each region's memory back before
# reading the next. Budgeted at the 9.5 the Python it replaced measured (1.35 GB,
# 2026-09-23). Beside it run up to PROM_FETCH_WORKERS DEM fetches for
# the regions next in line, each a gdal_translate whose block cache fetch-dem.sh caps at
# 512 MB, plus the image's 512 MB VSI cache and the process itself: FETCH_DEM_GB at most.
# Regions are scored smallest first, so the fetches running ahead are always for bigger
# regions than the one being scored; the peak is the worst of those pairings, computed
# here in that same order — the largest region itself is scored with nothing left to fetch.
PEAKS_BYTES_PER_PX=9.5
FETCH_DEM_GB=1.25
peaks_mem_gb() {
  python3 -c '
import json, math, sys
res, workers, per_fetch, per_px = (float(sys.argv[2]), int(sys.argv[3]),
                                   float(sys.argv[4]), float(sys.argv[5]))
def area(r): w, s, e, n = r["bbox"]; return (e - w) * (n - s)
with open(sys.argv[1]) as f:
    order = sorted(json.load(f)["regions"], key=area)
px = [area(r) / (res * res) for r in order]
n = len(order)
need = max(px[k] * per_px / 2**30 + per_fetch * min(workers, n - 1 - k) for k in range(n))
print(math.ceil(need), order[-1]["id"], round(px[-1] / 1e6))
' "$INFRA_DIR/regions.json" "${PROM_DEM_RES:-0.000833333}" "${PROM_FETCH_WORKERS:-3}" \
    "$FETCH_DEM_GB" "$PEAKS_BYTES_PER_PX"
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
  # Likewise only when this run builds peaks.
  local peaks_need="" peaks_region="" peaks_mpx=""
  if printf '%s\n' "${stages[@]}" | grep -qx peaks; then
    # Resolved here, not left to build-peaks.sh, so the figure the preflight checks and
    # the figure the stage runs with are the same one. An explicit setting is honoured
    # and then checked, exactly as before.
    export PROM_FETCH_WORKERS="${PROM_FETCH_WORKERS:-$(peaks_fetch_workers)}"
    read -r peaks_need peaks_region peaks_mpx < <(peaks_mem_gb)
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
  if [ -n "$peaks_need" ]; then
    printf '  %-28s %s GB        (%s, %s Mpx at 90 m)\n' "peaks prominence needs" "$peaks_need" "$peaks_region" "$peaks_mpx"
  fi
  printf '  %-28s %s\n' "cpus" "$cpus"
  printf '  %-28s %s\n' "source cache" "$OSM_CACHE"

  # What those numbers buy, per stage. Sized here rather than carried as fixed defaults:
  # the same run is made on an 8 GB laptop and a 64 GB workstation, and a number that
  # suits one kills or idles the other. Each figure is the measured per-worker cost from
  # docker/README.md's table divided into the memory above, capped by cores and by
  # whatever the stage has its own reason for. Every one is still overridable.
  printf '  %-28s %s GB reserved for the page cache and the kernel\n' \
    "memory not budgeted" "$RATMAP_MEM_RESERVE_GB"
  local stage
  for stage in "${stages[@]}"; do
    case "$stage" in
      paths)
        printf '  %-28s %s worker(s)   (~3 GB each)\n' "paths parallel" \
          "${RATMAP_PATHS_PARALLEL:-$(workers_for_budget 3 3)}" ;;
      peaks)
        printf '  %-28s %s fetch(es)   (~%s GB each, alongside the region being scored)\n' \
          "peaks DEM fetch-ahead" "${PROM_FETCH_WORKERS:-$(peaks_fetch_workers)}" "$FETCH_DEM_GB" ;;
      regions)
        printf '  %-28s %s region(s)   (link-bound; capped at 4)\n' "regions parallel" \
          "${RATMAP_REGIONS_PARALLEL:-$(overlapping_io_parallel 1.5 4)}" ;;
      avalanche)
        printf '  %-28s %s region(s)   (~1.5 GB each)\n' "avalanche parallel" \
          "${RATMAP_AVALANCHE_PARALLEL:-$(overlapping_io_parallel 1.5 4)}" ;;
      contours)
        local c_regions c_cells
        read -r c_regions c_cells < <(contours_workers)
        printf '  %-28s %s region(s)   (%s cells each, ~%s GB a cell, whatever the region)\n' \
          "contours parallel" "$c_regions" "$c_cells" "$CONTOURS_CELL_GB" ;;
    esac
  done

  # The free-space figure above is the VM's, and on Docker Desktop the VM's disk is a
  # sparse file on the host: it reports its *virtual* size (routinely 400 GB+) while only
  # the used blocks are actually backed. A run can therefore sail through this check and
  # still die of ENOSPC when the host fills. Nothing inside the container can see the
  # host's free space, so this can only be flagged, not checked.
  if df -PT "$WORK_DIR" 2>/dev/null | awk 'NR==2 {exit !($2 == "overlay" || $2 == "ext4")}'; then
    echo "  ~ $WORK_DIR is inside the Docker VM. If that VM's disk is a sparse image"
    echo "    (Docker Desktop's default), the $work_gb GB above is virtual — check the"
    echo "    HOST has room for it, or bind-mount $WORK_DIR to a real disk. A planet run"
    echo "    needs ~105 GB live at peak (85 GB of extracts + contour scratch + output),"
    echo "    plus the shared OSM subset (~9 GB) and the DEM cache as it grows."
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
  if [ -n "$peaks_need" ] && [ "$mem_gb" -lt "$peaks_need" ]; then
    echo "  ! ${mem_gb} GB of memory will not survive the peaks stage's prominence pass."
    echo "    It scores one region's 90 m DEM at a time, ~${PEAKS_BYTES_PER_PX} bytes a pixel, with up"
    echo "    to ${PROM_FETCH_WORKERS:-3} DEM fetches running ahead (the largest region here is"
    echo "    $peaks_region, ${peaks_mpx} Mpx). Raise the Docker VM's memory, or set"
    echo "    PROM_FETCH_WORKERS=1."
    fail=1
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

stage_sac() {
  if [ -z "$FORCE" ] && [ -f "$DIST_DIR/sac-global.pmtiles" ]; then
    log "sac: already built — --force to redo"
    return 0
  fi
  # **Before `regions`, not after.** build-region.sh cuts each region's `<id>-sac.pmtiles`
  # out of this file; run the other way round and every region in the catalogue ships
  # without grades, and says so once each in a log nobody reads to the end.
  #
  # In ALL_STAGES order this sits between peaks and places, so `global all` gets it right
  # on its own — this note is for anyone naming stages by hand.
  SAC_SOURCE_URLS="$(osm_source_urls)" "$SCRIPTS_DIR/build-sac.sh"
}

stage_paths() {
  if [ -z "$FORCE" ] && [ -f "$DIST_DIR/paths-global.pmtiles" ]; then
    log "paths: already built — --force to redo"
    return 0
  fi
  # The walkable network at z12-13, which the basemap does not carry: Protomaps tags paths
  # min_zoom 14 and thins them below it. Before `regions`, for the same reason as `sac`.
  #
  # The script tiles each continent separately, caches those tilesets under /work keyed by
  # the pinned source name, and tile-joins them — so an interrupted run resumes at the
  # continent it died on instead of at the first byte.
  #
  # Up to three at a time, because each continent has serial stretches (the osmium
  # export, the single-threaded reduce) during which one continent leaves the rest of the
  # cores idle, and a worker only costs 2-3 GB — see the measurements in build-paths.sh.
  # Sized here rather than passed as a fixed 3, so the number the preflight printed is
  # the number the stage runs with; build-paths.sh works it out the same way when it is
  # run directly, and caps an explicit one either way.
  PATHS_PARALLEL="${RATMAP_PATHS_PARALLEL:-$(workers_for_budget 3 3)}" \
    PATHS_SOURCE_URLS="$(osm_source_urls)" "$SCRIPTS_DIR/build-paths.sh"
}

stage_terrain-features() {
  if [ -z "$FORCE" ] && [ -f "$DIST_DIR/terrain-features-global.pmtiles" ]; then
    log "terrain-features: already built — --force to redo"
    return 0
  fi
  # Scree, shingle, rock and boulders — natural= values Protomaps' OSM ingestion drops
  # outright (see build-terrain-features.sh's own header). Before `regions`, same reason
  # as `sac` and `paths`: build-region.sh cuts each region's own cutout from this file.
  TERRAIN_FEATURES_SOURCE_URLS="$(osm_source_urls)" "$SCRIPTS_DIR/build-terrain-features.sh"
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

# "<id> <w> <s> <e> <n>" for each id given, in that order. The numbers are printed with
# Python's str(), exactly as build-contours.sh and build-avalanche.sh hand them to
# fetch-dem.sh — which is what makes a DEM fetched from here the cache entry those
# scripts look for.
region_bboxes() {
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    bbox = {r["id"]: r["bbox"] for r in json.load(f)["regions"]}
for rid in sys.argv[2:]:
    print(rid, *bbox[rid])
' "$INFRA_DIR/regions.json" "$@"
}

# One bad region must not end a run of several hundred. A malformed bbox failed on
# Antarctica after Africa had finished, and took every continent not yet reached with it —
# hours of downloads abandoned over one region that could have been skipped. Failures are
# collected and reported at the end; the stage still fails, so nothing downstream treats a
# partial catalogue as complete.
stage_regions() {
  # Artifact kinds that are cut from a global archive rather than from upstream, as
  # "<kind>:<global file>[:<file suffix>]". All additive (C16), so a missing one is a
  # region built before that kind existed, not a broken region. The suffix is the
  # region file's name after "<id>-" when it is not simply the kind — peaks is versioned
  # (`<id>-peaks-1.pmtiles`, see build-region.sh), and without it this would look for a
  # file that never exists and re-cut peaks on every run.
  local -a cut_from_global=(
    sac:sac-global.pmtiles
    paths:paths-global.pmtiles
    terrain-features:terrain-features-global.pmtiles
    peaks:peaks-global.pmtiles:peaks-1
  )

  # Not a failure — but worth one line up front rather than a "skipped" per region,
  # several hundred times over.
  local pair kind global suffix rest
  for pair in "${cut_from_global[@]}"; do
    kind="${pair%%:*}"
    rest="${pair#*:}"
    global="${rest%%:*}"
    if [ ! -f "$DIST_DIR/$global" ]; then
      log "regions: no $global — regions will be built without $kind"
      log "         (run the '$kind' stage first, or point at a published copy)"
    fi
  done

  local id wants_terrain only
  local -a jobs=() failed=()
  while read -r id wants_terrain; do
    only=""
    if [ -z "$FORCE" ] && [ -z "$DRY_RUN" ] \
       && [ -f "$DIST_DIR/regions/$id/$id-basemap.pmtiles" ] \
       && { [ "$wants_terrain" = 0 ] || [ -f "$DIST_DIR/regions/$id/$id-terrain.pmtiles" ]; }; then
      # Built — unless an artifact kind has been *added* since. Then cut only those:
      # re-extracting a region to pick up a 1.8 MB grade file would mean re-fetching its
      # basemap and terrain over range requests, which for a global catalogue is days of
      # transfer for bytes that have not changed.
      local -a missing=()
      for pair in "${cut_from_global[@]}"; do
        kind="${pair%%:*}"
        rest="${pair#*:}"
        global="${rest%%:*}"
        suffix="$kind"
        [ "$rest" != "$global" ] && suffix="${rest#*:}"
        [ -f "$DIST_DIR/$global" ] || continue
        [ -f "$DIST_DIR/regions/$id/$id-$suffix.pmtiles" ] || missing+=("$kind")
      done

      if [ "${#missing[@]}" -gt 0 ]; then
        only="--only=$(IFS=,; echo "${missing[*]}")"
      else
        log "regions/$id: already built — --force to redo"
        continue
      fi
    fi
    # A region with no graded ways publishes no sac artifact at all (Egypt), so this
    # re-checks it on every run. Measured at ~20 ms per region against a local
    # sac-global.pmtiles — 22 s for the whole catalogue (2026-09-06) — and it is what
    # makes the check self-correcting when the tagging does eventually arrive.
    jobs+=("$id${only:+ $only}")
  done < <(region_ids)

  if [ "${#jobs[@]}" -eq 0 ]; then
    log "regions: nothing to build"
    return 0
  fi

  # Regions at once. A region is already two downloads overlapping (build-region.sh runs
  # terrain beside everything else) at REGION_DOWNLOAD_THREADS range requests each, so
  # what more buys depends on the link rather than the box — which is why this is capped
  # at 4 however large the host is, instead of scaling with cores. Memory is not the
  # binding constraint (a region's tippecanoe sorts on disk and stayed under 300 MB even
  # at 4x the features, docker/README.md's table), so 1.5 GB a worker is generous and the
  # cap is what actually decides. Each worker's output goes to its own log with one
  # OK/FAILED line per region crossing back, the contours stage's idiom.
  local parallel="${RATMAP_REGIONS_PARALLEL:-$(overlapping_io_parallel 1.5 4)}"
  if [ "$parallel" -le 1 ]; then
    local job
    for job in "${jobs[@]}"; do
      read -r id only <<<"$job"
      log "regions/$id${only:+ ($only)}"
      if ! "$SCRIPTS_DIR/build-region.sh" "$id" $DRY_RUN $only; then
        log "regions/$id FAILED — continuing with the rest"
        failed+=("$id")
      fi
    done
  else
    log "regions: building ${#jobs[@]} region(s), $parallel at a time"
    build_one_region() {
      local id="$1" only="${2:-}"
      if "$SCRIPTS_DIR/build-region.sh" "$id" $DRY_RUN $only \
           > "$LOG_DIR/${RUN_ID}-regions-$id.log" 2>&1; then
        printf 'OK\t%s\n' "$id"
      else
        printf 'FAIL\t%s\n' "$id"
      fi
    }
    export -f build_one_region
    export SCRIPTS_DIR LOG_DIR RUN_ID DRY_RUN

    local status rid
    while IFS=$'\t' read -r status rid; do
      if [ "$status" = OK ]; then
        log "regions/$rid: done"
      else
        log "regions/$rid FAILED — see $LOG_DIR/${RUN_ID}-regions-$rid.log — continuing with the rest"
        failed+=("$rid")
      fi
    done < <(printf '%s\n' "${jobs[@]}" | xargs -P "$parallel" -L 1 bash -c 'build_one_region "$@"' _)
  fi

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

  # Regions at once, and cells each: see contours_workers. build-contours.sh traces a
  # region in cells, CONTOUR_WORKERS at a time, so the parallelism is inside a region now
  # and a region's memory is its cells', whatever its size.
  local parallel cell_workers
  read -r parallel cell_workers < <(contours_workers)
  export CONTOUR_WORKERS="$cell_workers" CONTOUR_CELL_GB="$CONTOURS_CELL_GB"
  log "contours: building ${#ids[@]} region(s), $parallel at a time, $cell_workers cells each (~$CONTOURS_CELL_GB GB a cell)"

  # Fetch ahead. A region's build is a DEM fetch — network-bound, ~1.25 GB at most — and
  # then gdal_contour, which is cpu-bound and is what holds this stage to one region at a
  # time. In sequence, every region waits for both. So a background fetcher walks the same
  # list, RATMAP_CONTOURS_FETCH_AHEAD at a time (default 2), filling the DEM cache
  # (fetch-dem.sh with `-` for its output) while earlier regions trace; each build's own
  # fetch-dem.sh then finds its DEM cached. A build whose DEM is still on its way waits for
  # it rather than fetching it again: on a link short of bandwidth — this one measured
  # ~1.5 MB/s to the Copernicus bucket, 2026-09-23 — a duplicate download costs more than
  # the wait. If the fetch-ahead fails, the build fetches for itself, exactly as before.
  #
  # Needs the cache: with DEM_CACHE_DIR set empty there is nowhere to fetch into. This is
  # lib.sh's default restated, since this driver deliberately does not source lib.sh.
  local ahead="${RATMAP_CONTOURS_FETCH_AHEAD:-2}"
  local dem_cache="${DEM_CACHE_DIR-$(dirname "$OSM_CACHE")/dem}"
  DEM_READY=""
  DEM_FETCHER=""
  if [ "$ahead" -gt 0 ] && [ -n "$dem_cache" ]; then
    DEM_READY="$LOG_DIR/${RUN_ID}-contours-dems-ready"
    : > "$DEM_READY"
    fetch_one_dem() {  # fetch_one_dem <id> <w> <s> <e> <n>
      local id="$1"
      shift
      if ! bash "$SCRIPTS_DIR/fetch-dem.sh" "$@" - > "$LOG_DIR/${RUN_ID}-contours-$id-dem.log" 2>&1; then
        printf '[%s] contours/%s: fetch-ahead failed — its build will fetch for itself\n' \
          "$(date -u +%H:%M:%S)" "$id"
      fi
      printf '%s\n' "$id" >> "$DEM_READY"
    }
    export -f fetch_one_dem
    export SCRIPTS_DIR LOG_DIR RUN_ID DEM_READY
    (
      region_bboxes "${ids[@]}" | xargs -P "$ahead" -L 1 bash -c 'fetch_one_dem "$@"' _
      echo "__done__" >> "$DEM_READY"
    ) &
    DEM_FETCHER=$!
    log "contours: fetching DEMs ahead of the builds, $ahead at a time"
  elif [ "$ahead" -gt 0 ]; then
    log "contours: DEM_CACHE_DIR is empty — no fetch-ahead; each build fetches its own DEM"
  fi
  export DEM_READY DEM_FETCHER

  # Each worker's full build-contours.sh output goes to its own log rather than straight
  # to stdout — with several running at once, unredirected output would interleave line
  # by line into the shared stage log ($LOG_DIR/${RUN_ID}-contours.log, via the `tee` in
  # the run loop below) and be unreadable. Only a one-line OK/FAIL per region crosses
  # back, same idiom as fetch-dem.sh's check_one.
  build_one_contour() {
    local id="$1"
    # This region's DEM from the fetch-ahead: wait for it rather than fetch it twice. The
    # fetcher's closing "__done__", or the fetcher no longer running, ends the wait too.
    if [ -n "$DEM_READY" ]; then
      until grep -qxF -e "$id" -e "__done__" "$DEM_READY" \
            || ! kill -0 "$DEM_FETCHER" 2>/dev/null; do
        sleep 2
      done
    fi
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

  # Every build waited for its own DEM, so the fetcher has nothing left; this only reaps it.
  if [ -n "$DEM_FETCHER" ]; then
    wait "$DEM_FETCHER" 2>/dev/null || true
  fi

  if [ "${#failed[@]}" -gt 0 ]; then
    log "contours: ${#failed[@]} failed: ${failed[*]}"
    return 1
  fi
}

stage_avalanche() {
  # Per-region and opt-in, exactly like contours and for the same reason: this is derived
  # from the Copernicus DEM per bbox, and the catalogue covers the globe. Running it
  # everywhere would spend days computing slope for terrain nobody skis or walks.
  #
  # Far cheaper than contours, though — no line tracing, no large GeoJSON intermediate.
  # The whole working set is a few byte rasters the size of the region, so this is
  # parallel by default where contours is not.
  [ -n "$DRY_RUN" ] && { log "avalanche: no dry-run mode, skipping"; return 0; }

  local id
  local -a ids=()
  while read -r id _; do
    if [ -z "$FORCE" ] && [ -f "$DIST_DIR/regions/$id/$id-avalanche-1.pmtiles" ]; then
      log "avalanche/$id: already built — --force to redo"
      continue
    fi
    ids+=("$id")
  done < <(region_ids avalanche)

  if [ "${#ids[@]}" -eq 0 ]; then
    log "avalanche: nothing to build"
    return 0
  fi

  # Four. A region's phases run in sequence, so its peak is the largest of them rather
  # than their sum, and that is ~0.8-1.5 GB — measured 2026-09-08 on a 108 and a 216 Mpx
  # raster: gdalwarp ~694 MB, encode-avalanche.py 792 MB and 1459 MB (most of it evictable
  # page cache for the memmaps), the tiler a few MB. The encoder is Go now and streams
  # three rows (15 MB on 113 Mpx, 2026-09-25), so the warp is the peak and this is
  # conservative. Four regions is ~6 GB on a 32 GB host,
  # and the warp phase is network-bound with the cpu idle, so overlapping several is close
  # to free.
  #
  # What four does *not* fit is the cpu: assemble-avalanche.py's WebP proof pass already
  # runs a thread per core, so several regions reaching it together oversubscribe rather
  # than go faster. Capping that inner pool by this number is what would make 4 pay off in
  # wall-clock as well as in memory; until then it is bounded by cores, not by RAM.
  #
  # So: four where there is room for four, and fewer where there is not — 1.5 GB a worker
  # is the top of the measured range, and overlapping_io_parallel keeps the cap at 4 and
  # at half the cores, which is the cpu reason above made explicit.
  local parallel="${RATMAP_AVALANCHE_PARALLEL:-$(overlapping_io_parallel 1.5 4)}"
  # Exported, and with the default resolved rather than left unset: build-avalanche.sh
  # divides the machine's cores by this to size the WebP pass, and a child that cannot
  # see the number would take every core while three siblings did the same.
  export RATMAP_AVALANCHE_PARALLEL="$parallel"
  log "avalanche: building ${#ids[@]} region(s), $parallel at a time"

  build_one_avalanche() {
    local id="$1"
    if "$SCRIPTS_DIR/build-avalanche.sh" "$id" > "$LOG_DIR/${RUN_ID}-avalanche-$id.log" 2>&1; then
      printf 'OK\t%s\n' "$id"
    else
      printf 'FAIL\t%s\n' "$id"
    fi
  }
  export -f build_one_avalanche
  export SCRIPTS_DIR LOG_DIR RUN_ID

  local -a failed=()
  local status rid
  while IFS=$'\t' read -r status rid; do
    if [ "$status" = OK ]; then
      log "avalanche/$rid: done"
    else
      log "avalanche/$rid FAILED — see $LOG_DIR/${RUN_ID}-avalanche-$rid.log — continuing with the rest"
      failed+=("$rid")
    fi
  done < <(printf '%s\n' "${ids[@]}" | xargs -P "$parallel" -I{} bash -c 'build_one_avalanche "$@"' _ {})

  if [ "${#failed[@]}" -gt 0 ]; then
    log "avalanche: ${#failed[@]} failed: ${failed[*]}"
    return 1
  fi
}

stage_manifest() {
  # Always regenerated: it records sizes, zoom ranges and sha256s of whatever is in
  # dist/ right now, so it has to run last and it has to run every time.
  local -a args=()

  # Merge onto the live catalogue rather than replacing it, whenever we know where the
  # live one is. A bare rebuild publishes *only* what this disk holds, so any region the
  # catalogue lists and this machine has not built would be silently unpublished — which
  # is exactly what build-region.sh's own "Next:" hint warns against. That was safe while
  # this image only ever ran the whole planet from scratch; it stopped being safe the
  # moment a run existed that adds one artifact kind to an already-published catalogue.
  #
  # For a genuine full-planet run the two modes agree: every region is present locally
  # and overwrites its base entry, kind by kind.
  if [ -n "${PUBLIC_BASE_URL:-}" ]; then
    args+=(--base-live)
    log "manifest: merging onto the live catalogue at $PUBLIC_BASE_URL"
  else
    log "manifest: no PUBLIC_BASE_URL — full rebuild from dist/ only."
    log "          Anything the catalogue lists that is not on this disk will be dropped."
  fi

  # Scope the scan when dist/ holds more than this run's business. The manifest build
  # fails closed on an unreadable archive — correctly, since publishing one would put a
  # broken download in the catalogue — but an incrementally-built dist/ accumulates
  # scratch from unrelated regions, and one stray corrupt file there blocks every
  # region's publish. Note what this trades away: a region excluded here is *not*
  # recomputed, so artifacts built for it in this run stay unpublished until it is.
  if [ -n "${RATMAP_MANIFEST_ONLY:-}" ]; then
    args+=(--only "$RATMAP_MANIFEST_ONLY")
    log "manifest: scoped to region ids matching $RATMAP_MANIFEST_ONLY"
  fi

  python3 "$SCRIPTS_DIR/build-manifest.py" "${args[@]}"
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
