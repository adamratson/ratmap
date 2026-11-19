#!/usr/bin/env bash
# Removes what no build will read again, and reports what it freed.
#
#   ./scripts/prune-caches.sh [--dry-run]
#
# docker/build-global.sh runs this at the start of every run, holding the run lock; run it
# by hand on a laptop, or in the image (`docker compose run --rm infra prune-caches.sh`)
# when nothing else is building. Nothing here grows back by itself, so nothing is lost but
# disk: each entry is either keyed to inputs that have since changed or a partial file
# from a run that was killed.
#
#   DEM cache    entries under a key fetch-dem.sh no longer builds: an older key version,
#                a source re-pin, or GLO-30's v1 since the move to Mapterhorn. A full set
#                of current entries is a planet's worth of DEMs, and kept: the next run
#                reads them.
#   OSM subsets  a continent's subset whose extract has been re-downloaded, or has gone,
#                or whose filter union has changed. osm_subset already replaces a stale
#                subset, but only when a stage next asks for that continent.
#   dist/        region files an older build named (`-contours` once contours are
#                `-contours-1`; see build-manifest's superseded.go). The bucket keeps the
#                copies the live catalogue points at: upload.sh never deletes there.
#   partials     a DEM cache `.part`, a subset's dotted temporary, or a dotted
#                `.building.pmtiles` in dist/, untouched for PARTIAL_MINUTES. Every writer
#                of these streams into them, so an hour without a write is a dead run's,
#                not a slow one's.
#
# Left alone: the Geofabrik extracts (prefetch pins and replaces them), the paths
# tilesets (build-paths.sh uses a cached continent even with its extract gone), global
# files in dist/, and any build's scratch — build-global.sh clears its own run directory,
# which only it can know is dead.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Usage: prune-caches.sh [--dry-run]" >&2; exit 2 ;;
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

if [ -n "${DEM_CACHE_DIR:-}" ] && [ -d "$DEM_CACHE_DIR" ]; then
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

while IFS= read -r f; do
  drop "superseded" "$f"
done < <(go_run build-manifest --superseded "$DIST_DIR")
while IFS= read -r f; do
  drop "partial" "$f"
done < <(find "$DIST_DIR" -type f -name '.*.building.pmtiles' -mmin +"$PARTIAL_MINUTES")

if [ "$count" -eq 0 ]; then
  echo "  nothing to prune"
elif [ -n "$DRY_RUN" ]; then
  echo "  would free $(human "$freed") in $count file(s) (dry run: nothing removed)"
else
  echo "  freed $(human "$freed") in $count file(s)"
fi
if [ -n "${DEM_CACHE_DIR:-}" ] && [ -d "$DEM_CACHE_DIR" ]; then
  echo "  DEM cache kept: $(du -sh "$DEM_CACHE_DIR" | cut -f1) in $DEM_CACHE_DIR"
fi
