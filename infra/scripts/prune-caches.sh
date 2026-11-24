#!/usr/bin/env bash
# Removes what no build will read again, and reports what it freed.
#
#   ./scripts/prune-caches.sh [--dry-run] [--osm]
#
# --osm prunes the OSM caches alone (the extracts, their subsets and the paths tilesets):
# what prefetch runs once it has resolved this run's pins, so a re-pin frees the old
# snapshot before the new one is downloaded beside it.
#
# docker/build-global.sh runs this at the start of every run, holding the run lock; run it
# by hand on a laptop, or in the image (`docker compose run --rm infra prune-caches.sh`)
# when nothing else is building. Nothing here grows back by itself, so nothing is lost but
# disk: each entry is either keyed to inputs that have since changed or a partial file
# from a run that was killed.
#
#   extracts     a Geofabrik extract whose continent is pinned to a newer snapshot
#                (pinned-sources.tsv, which prefetch writes beside them), with its .md5
#                and any .unverified download of it. No stage reads a snapshot it has not
#                pinned. An extract whose continent has no pin at all is kept, as is a
#                <continent>-latest.osm.pbf: prefetch may yet pin, or adopt, that one.
#   DEM cache    entries under a key fetch-dem.sh no longer builds: an older key version,
#                a Mapterhorn re-pin, or any GLO-30 clip unless DEM_SOURCE=glo30 (the
#                source before 2026-11-18, now only a diagnostic switch). A full set of
#                current entries is a planet's worth of DEMs, and kept: the next run
#                reads them.
#   OSM subsets  a continent's subset whose extract has been re-downloaded, or has gone,
#                or whose filter union has changed. osm_subset already replaces a stale
#                subset, but only when a stage next asks for that continent.
#   paths        a continent's cached paths tileset (build-paths.sh) built from a
#                snapshot its continent is no longer pinned to: it is keyed on the
#                snapshot, so no build reads it again.
#   dist/        region files an older build named (`-contours` once contours are
#                `-contours-1`; see build-manifest's superseded.go). The bucket keeps the
#                copies the live catalogue points at: upload.sh never deletes there.
#   partials     a DEM cache `.part`, a subset's dotted temporary, or a dotted
#                `.building.pmtiles` in dist/, untouched for PARTIAL_MINUTES. Every writer
#                of these streams into them, so an hour without a write is a dead run's,
#                not a slow one's.
#
# Left alone: the extracts and paths tilesets of the current pins (build-paths.sh uses a
# cached continent even with its extract gone), current DEM entries, global files in
# dist/, and any build's scratch — build-global.sh clears its own run directory, which
# only it can know is dead, and its logs.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DRY_RUN=""
OSM_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --osm) OSM_ONLY=1 ;;
    *) echo "Usage: prune-caches.sh [--dry-run] [--osm]" >&2; exit 2 ;;
  esac
done
PARTIAL_MINUTES="${PARTIAL_MINUTES:-60}"

freed=0
count=0
# drop <why> <path> — remove one file (or report it, with --dry-run) and count its size.
drop() {
  local why="$1" path="$2" bytes
  [ -e "$path" ] || return 0
  bytes="$(du -sk "$path" | cut -f1)"
  freed=$((freed + bytes))
  count=$((count + 1))
  printf '  %-11s %8s  %s\n' "$why" "$(human "$bytes")" "$path"
  [ -n "$DRY_RUN" ] || rm -rf "$path"
}
human() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k / 1048576; else printf "%.0f MB", k / 1024 }'; }

# The pins prefetch resolved (build-global.sh): "<continent>\t<snapshot>.osm.pbf\t<md5>".
PIN_FILE="$OSM_CACHE_DIR/pinned-sources.tsv"
# superseded <name> — whether <name> (a snapshot's file name, <continent>-YYMMDD.osm.pbf)
# is of a continent pinned to some other snapshot. Not when it has no pin at all, nor when
# there is no pin file: then nothing says what is current.
superseded() {
  [ -s "$PIN_FILE" ] || return 1
  [[ "$1" =~ ^(.+)-[0-9]{6}\.osm\.pbf$ ]] || return 1
  awk -F'\t' -v c="${BASH_REMATCH[1]}" -v f="$1" \
    '$1 == c { pinned = 1; if ($2 == f) current = 1 } END { exit !(pinned && !current) }' \
    "$PIN_FILE"
}

# Before the subsets, so that a subset of an extract removed here goes in the same pass.
if [ -d "$OSM_CACHE_DIR" ]; then
  for f in "$OSM_CACHE_DIR"/*.osm.pbf "$OSM_CACHE_DIR"/*.osm.pbf.md5 \
           "$OSM_CACHE_DIR"/*.osm.pbf.unverified; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    superseded "${name%.osm.pbf*}.osm.pbf" && drop "old extract" "$f"
  done
fi

if [ -z "$OSM_ONLY" ] && [ -n "${DEM_CACHE_DIR:-}" ] && [ -d "$DEM_CACHE_DIR" ]; then
  for f in "$DEM_CACHE_DIR"/*.tif "$DEM_CACHE_DIR"/*.txt; do
    [ -e "$f" ] || continue
    key="$(basename "$f")"
    key="${key%.*}"
    dem_cache_key_is_current "$key" || drop "stale DEM" "$f"
  done
  while IFS= read -r f; do
    drop "partial" "$f"
  done < <(find "$DEM_CACHE_DIR" -maxdepth 1 -type f -name '*.part.*' -mmin +"$PARTIAL_MINUTES")
fi

if [ -d "$OSM_SUBSET_DIR" ]; then
  for f in "$OSM_SUBSET_DIR"/*.osm.pbf; do
    [ -e "$f" ] || continue
    # <base>.<key>.osm.pbf, built from $OSM_CACHE_DIR/<base>.osm.pbf.
    base="$(basename "$f" .osm.pbf)"
    base="${base%.*}"
    extract="$OSM_CACHE_DIR/$base.osm.pbf"
    if [ ! -s "$extract" ] || [ "$(osm_subset_path "$extract")" != "$f" ]; then
      drop "old subset" "$f"
    fi
  done
  while IFS= read -r f; do
    drop "partial" "$f"
  done < <(find "$OSM_SUBSET_DIR" -maxdepth 1 -type f -name '.*.osm.pbf' -mmin +"$PARTIAL_MINUTES")
fi

# build-paths.sh's per-continent tilesets: <snapshot>-paths.pmtiles, from <snapshot>.osm.pbf.
PATHS_TILE_CACHE="${PATHS_TILE_CACHE:-$CACHE_ROOT/paths-tiles}"
if [ -d "$PATHS_TILE_CACHE" ]; then
  for f in "$PATHS_TILE_CACHE"/*-paths.pmtiles; do
    [ -e "$f" ] || continue
    name="$(basename "$f" -paths.pmtiles)"
    superseded "$name.osm.pbf" && drop "old paths" "$f"
  done
fi

if [ -z "$OSM_ONLY" ]; then
  while IFS= read -r f; do
    drop "superseded" "$f"
  done < <(go_run build-manifest --superseded "$DIST_DIR")
  while IFS= read -r f; do
    drop "partial" "$f"
  done < <(find "$DIST_DIR" -type f -name '.*.building.pmtiles' -mmin +"$PARTIAL_MINUTES")
fi

if [ "$count" -eq 0 ]; then
  echo "  nothing to prune"
elif [ -n "$DRY_RUN" ]; then
  echo "  would free $(human "$freed") in $count file(s) (dry run: nothing removed)"
else
  echo "  freed $(human "$freed") in $count file(s)"
fi
if [ -z "$OSM_ONLY" ] && [ -n "${DEM_CACHE_DIR:-}" ] && [ -d "$DEM_CACHE_DIR" ]; then
  echo "  DEM cache kept: $(du -sh "$DEM_CACHE_DIR" | cut -f1) in $DEM_CACHE_DIR"
fi
