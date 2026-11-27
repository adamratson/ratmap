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

# Move a finished archive from the work directory into dist/, never half-there under its
# real name.
#
#   tippecanoe -o "$WORK_DIR/x.pmtiles" ...
#   move_into_dist "$WORK_DIR/x.pmtiles" "$DIST_DIR/x.pmtiles"
#
# Why the archive is built in the work directory at all: writing PMTiles, tippecanoe and
# tile-join put every tile into a SQLite database at the output path, from one writer
# thread the tiling threads queue behind, then copy it out in clustered order. Pointed at
# dist/, that throttles the tiling itself whenever dist/ is slower than the work volume —
# the 2026-10-27 global detail run sat at 97-98% for hours with eight threads asleep
# behind one in disk wait, writing 4.5 MB/s to a bind-mounted dist/ while 14 GB of RAM
# sat free. In the Docker image the work directory is under TMPDIR, on the /work volume.
#
# The move crosses filesystems there, which makes it a copy: one sequential pass, but not
# atomic. So the copy lands under a hidden name beside DEST — still ending in .pmtiles,
# since tippecanoe and pmtiles pick the format by extension, and dotted, so upload.sh's
# *.pmtiles glob and build-manifest pass over a leftover from a killed run — and only the
# rename on the same filesystem gives it the real name.
move_into_dist() {
  local src="$1" dest="$2" arriving
  arriving="$(dirname "$dest")/.$(basename "$dest" .pmtiles).building.pmtiles"
  if ! mv "$src" "$arriving"; then
    rm -f "$arriving"
    return 1
  fi
  mv "$arriving" "$dest"
}

# Build one of scripts/tools' Go commands (compute-prominence, encode-avalanche,
# reduce-paths, ...) into a directory, and print the binary's path.
#
#   BIN="$(go_tool compute-prominence "$WORK_DIR")"
#
# Compiled from this checkout on every run, never carried in the image — the same rule as
# build-contours.sh's contour-cell, for the same reason: the pipeline is whatever the
# working copy says it is (docker/compose.yml mounts it over the image's copy), and a
# baked binary would go on running old logic after the source changed. Go's build cache
# makes this a moment after the first time. GOTOOLCHAIN=local: never fetch a toolchain.
# Into the caller's own directory, so regions built side by side never share a binary.
go_tool() {
  local name="$1" dir="$2"
  require_cmd go
  (cd "$INFRA_DIR/scripts/tools" \
    && GOTOOLCHAIN=local go build -trimpath -buildvcs=false -o "$dir/$name" "./cmd/$name") >&2 \
    || { echo "Could not build tools/cmd/$name" >&2; return 1; }
  echo "$dir/$name"
}

# Object storage, for upload.sh and prune-bucket.sh: checks infra/.env has what they need, per
# infra/SETUP.md, and sets aws-cli up to talk to Krystal. Then BUCKET_URL is the bucket and
# s3_cp <file> <key> [aws s3 cp options] puts a file there.
s3_setup() {
  : "${S3_BUCKET:?Set S3_BUCKET in infra/.env — see infra/SETUP.md}"
  : "${S3_ENDPOINT:?Set S3_ENDPOINT in infra/.env — see infra/SETUP.md}"
  : "${S3_REGION:?Set S3_REGION in infra/.env — see infra/SETUP.md}"
  : "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID in infra/.env — see infra/SETUP.md}"
  : "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY in infra/.env — see infra/SETUP.md}"

  # `pmtiles upload` (gocloud's aws-sdk-go-v2-based S3 client) fails every write against
  # Krystal with a flat SigV4 "SignatureDoesNotMatch", regardless of region string or
  # path-style addressing — tested 2026-08-28, not a config problem, a client incompatibility
  # with Krystal's Swift-based S3 gateway. `aws s3 cp` (botocore) signs the exact same request
  # successfully, so it does the uploading instead; nothing pmtiles-specific was
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
}

s3_cp() {
  aws s3 cp "$1" "${BUCKET_URL}/$2" --endpoint-url "$S3_ENDPOINT" "${@:3}"
}

# Run one of scripts/tools' Go commands with the given arguments: built into a scratch
# directory, run, and the directory removed. For the commands a person runs by hand —
# through build-manifest.sh and build-catalog.sh — and the ones the build scripts call
# once or twice inline (region-osm-sources, catalog, pmtiles-header, util, ...); a command
# run in a loop is built once with go_tool instead. RATMAP_INFRA_DIR tells them where
# infra/ is, which the Python scripts they replaced worked out from their own path.
go_run() {
  local name="$1" dir status=0
  shift
  dir="$(mktemp -d)"
  if go_tool "$name" "$dir" >/dev/null; then
    RATMAP_INFRA_DIR="$INFRA_DIR" "$dir/$name" "$@" || status=$?
  else
    status=1
  fi
  rm -rf "$dir"
  return "$status"
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
#
# Failure is returned, never left to `set -e`: every caller runs this inside `$(...)`
# (cached_osm_extract's path is captured), where bash does not apply errexit, so a failed
# curl used to fall through to the next line. On 2026-11-23 Geofabrik refused the infra
# image smoke test's connections, and build-peaks.sh and build-places.sh went on to build
# from an extract that was never downloaded: 0 peaks, 0 places, no error.
fetch_to() {
  local url="$1" dest="$2"
  local part="$dest.part"

  echo "  fetching $(basename "$dest")"
  curl -L --fail --retry 5 --retry-delay 5 --retry-connrefused \
    --continue-at - --progress-bar "$url" -o "$part" || return 1
  mv "$part" "$dest" || return 1
}

# Path to a URL's cached copy, downloading it first if absent.
#
# Source extracts live outside the per-run temp dir so a failed or repeated build doesn't
# re-download hundreds of MB — re-running the places stage after the peaks stage then
# costs no transfer at all. Prints the path on stdout; progress goes to stderr so callers
# can capture the path cleanly.
#
# CACHE_ROOT holds every other cache — the shared subsets, DEM clips, paths tilesets:
# infra/.cache on a laptop, /work/cache in the image (RATMAP_CACHE). The extracts sit in
# it too by default, but the image gives them a mount of their own, /osm, so they can live
# on a big slow disk while what is re-read stage after stage stays on the fast one. That
# is why nothing else is placed relative to OSM_CACHE_DIR.
CACHE_ROOT="${RATMAP_CACHE:-$INFRA_DIR/.cache}"
OSM_CACHE_DIR="${OSM_CACHE_DIR:-$CACHE_ROOT/osm}"

cached_osm_extract() {
  local url="$1"
  local name
  name="$(basename "${url%%\?*}")"
  local dest="$OSM_CACHE_DIR/$name"

  mkdir -p "$OSM_CACHE_DIR"
  # A failed download returns failure rather than a path to nothing (see fetch_to). The
  # callers assign the path with a plain `src="$(cached_osm_extract ...)"`, so under
  # their `set -e` that stops the script.
  if [ ! -s "$dest" ]; then
    if ! fetch_to "$url" "$dest" >&2; then
      echo "FAILED: could not download $url" >&2
      return 1
    fi
  else
    echo "  cached $name ($(du -h "$dest" | cut -f1))" >&2
  fi
  echo "$dest"
}

# Everything the OSM stages filter for, as one `osmium tags-filter` expression list:
#
#   n/natural=peak,volcano,saddle n/mountain_pass=yes   build-peaks.sh, build-places.sh
#   n/place=city,town,village,hamlet,suburb             build-places.sh
#   w/sac_scale                                         build-sac.sh
#   w/highway=path,footway,bridleway,steps,track        build-paths.sh
#   nwr/natural=scree,shingle,rock,stone                build-terrain-features.sh
#   nwr/man_made=mast,tower,survey_point,cairn,lighthouse
#   nwr/generator:source=wind                           build-landmarks.sh
#   w/barrier=wall,fence nw/barrier=gate,kissing_gate,stile,cattle_grid
#   w/power=line,minor_line n/power=tower nw/ford       build-detail.sh
#   nwr/amenity=parking                                 build-parking.sh
#   nwr/tourism=alpine_hut,wilderness_hut,camp_site
#   nwr/amenity=shelter,drinking_water,water_point
#   nwr/natural=spring nwr/man_made=water_tap           build-huts.sh
#   r/route=hiking,foot                                 build-routes.sh
#   w/access=private,no                                 build-access.sh
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
# refuses to run for one — add the expression here first. Adding one changes every
# subset's key, so the next run builds them all again, once: one pass over the extracts.
RATMAP_OSM_SUBSET_FILTER="
  n/natural=peak,volcano,saddle n/mountain_pass=yes
  n/place=city,town,village,hamlet,suburb
  w/sac_scale
  w/highway=path,footway,bridleway,steps,track
  nwr/natural=scree,shingle,rock,stone
  nwr/man_made=mast,tower,survey_point,cairn,lighthouse nwr/generator:source=wind
  w/barrier=wall,fence nw/barrier=gate,kissing_gate,stile,cattle_grid
  w/power=line,minor_line n/power=tower nw/ford
  nwr/amenity=parking
  nwr/tourism=alpine_hut,wilderness_hut,camp_site
  nwr/amenity=shelter,drinking_water,water_point
  nwr/natural=spring nwr/man_made=water_tap
  r/route=hiking,foot
  w/access=private,no
"

# osm_subset <extract.osm.pbf> <this stage's tags-filter expressions...>
#
# Prints the path of the shared subset of <extract>, building it on first use. Cached in
# OSM_SUBSET_DIR, keyed on the union above and on the extract's size and mtime, so a
# changed union or a re-downloaded extract builds a fresh one; older subsets of the same
# extract are removed when it does. RATMAP_NO_OSM_SUBSET=1 hands back the extract itself.
#
# Not beside the extracts: every OSM stage reads the subset, some of them several times
# over, where each extract is read once to build it. So it belongs on the fast disk with
# the other caches. The default is where it has always been on a laptop, and on the image
# keeps the subsets already built in /work when the extracts move to /osm — the key is
# the extract's size and mtime, not its path, so a copy that keeps mtimes keeps them valid.
OSM_SUBSET_DIR="${OSM_SUBSET_DIR:-$CACHE_ROOT/osm/subsets}"

# osm_subset_path <extract.osm.pbf> — where its subset for the current filter union
# lives, built or not. prune-caches.sh keeps only these.
osm_subset_path() {
  local src="$1" key
  key="$(go_run util subset-key "$src" " $(echo $RATMAP_OSM_SUBSET_FILTER) ")"
  echo "$OSM_SUBSET_DIR/$(basename "${src%.osm.pbf}").$key.osm.pbf"
}

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
  out="$(osm_subset_path "$src")"
  key="${out%.osm.pbf}"
  key="${key##*.}"
  base="$(basename "${src%.osm.pbf}")"
  dir="$OSM_SUBSET_DIR"

  if [ -s "$out" ]; then
    echo "  shared subset $(basename "$out") ($(du -h "$out" | cut -f1))" >&2
    echo "$out"
    return 0
  fi

  mkdir -p "$dir"
  rm -f "$dir/$base".*.osm.pbf
  echo "  building the shared OSM subset of $base (one pass for all the OSM stages)" >&2
  # Still ends in .osm.pbf: osmium picks the output format from the extension. The
  # leading dot keeps a half-written file out of the glob above and out of the cache.
  tmp="$dir/.$base.$key.$$.osm.pbf"
  # shellcheck disable=SC2086
  osmium tags-filter "$src" $RATMAP_OSM_SUBSET_FILTER -o "$tmp" --overwrite >&2
  mv -f "$tmp" "$out"
  echo "  shared subset $(basename "$out") ($(du -h "$out" | cut -f1))" >&2
  echo "$out"
}

# Copernicus DEM clips, cached by fetch-dem.sh. In CACHE_ROOT, the same placement
# build-paths.sh uses for its tilesets: infra/.cache/dem on a laptop (gitignored with the
# rest of .cache), /work/cache/dem in the image.
# `-` rather than `:-`, so an explicitly empty DEM_CACHE_DIR= switches caching off.
DEM_CACHE_DIR="${DEM_CACHE_DIR-$CACHE_ROOT/dem}"

# Mapterhorn's planet.pmtiles, which fetch-dem.sh reads its DEMs from, pinned by ETag
# (C13: a dependency we do not control is pinned, never tracked). The file is republished
# in place, so the ETag is the release: this one is version 0.0.13 in Mapterhorn's
# download_urls.json, last modified 2026-09-11. A republish fails fetch-dem.sh until this
# is changed on purpose.
MAPTERHORN_PLANET_URL="${MAPTERHORN_PLANET_URL:-https://download.mapterhorn.com/planet.pmtiles}"
MAPTERHORN_PLANET_ETAG="${MAPTERHORN_PLANET_ETAG:-\"fa356a37f6efbb757fe00d1767bddf01-2650\"}"

# The DEM cache's key versions. Here rather than in fetch-dem.sh, which builds the keys,
# so that prune-caches.sh can tell a current entry from one no build will read again.
# Bump whenever anything changes what a given bbox fetches — tile selection, ordering,
# resampling — so no cache written by older logic is ever reused.
#   glo30 v1: sorted tile list, single-threaded VRT (see VRT_NUM_THREADS in fetch-dem.sh).
#   glo30 v2: a downsampled fetch really takes the maximum (gdalwarp; see translate there).
#   mapterhorn v1: zoom by latitude, absent tiles as sea level, bilinear to 4326.
# Mapterhorn's key also carries the pinned ETag, so a re-pin never reuses an older release.
DEM_CACHE_GLO30_VERSION=v2
DEM_CACHE_MAPTERHORN_VERSION=v1
mapterhorn_pin() { printf '%s' "$MAPTERHORN_PLANET_ETAG" | tr -cd 'A-Za-z0-9' | cut -c1-12; }

# dem_cache_key_is_current <key> — whether fetch-dem.sh, as it stands and with this
# DEM_SOURCE, will read this key again (a cache file's name without .tif or .txt).
#
# GLO-30 entries count only when DEM_SOURCE=glo30. Mapterhorn has been the source since
# 2026-11-18, and GLO-30 survives only as the switch for telling a Mapterhorn problem
# from ours, so a planet of GLO-30 clips from before then is cache no run reads. A
# diagnostic DEM_SOURCE=glo30 run fetches what it needs again; Mapterhorn entries are kept
# whatever DEM_SOURCE says, since that is what every default run reads.
dem_cache_key_is_current() {
  case "$1" in
    "mapterhorn-z"*"-$(mapterhorn_pin)-${DEM_CACHE_MAPTERHORN_VERSION}_"*) return 0 ;;
    "glo30-${DEM_CACHE_GLO30_VERSION}_"*) [ "${DEM_SOURCE:-mapterhorn}" = glo30 ] ;;
    *) return 1 ;;
  esac
}

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
