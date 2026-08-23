#!/usr/bin/env bash
# Container entrypoint. Prepares the writable scratch layout, then dispatches to one of
# the infra/scripts by name — so `docker run ratmap-infra build-peaks.sh` does what it
# looks like it does, and `docker run ratmap-infra global all` runs the planet pipeline.
set -euo pipefail

INFRA_DIR=/opt/ratmap/infra
SCRIPTS_DIR="$INFRA_DIR/scripts"

# mktemp, the Geofabrik cache, aws's config dir and the stage logs all live under /work.
# If /work isn't a mounted volume these still work — they just land on the container's
# writable layer, which is exactly the disk that runs out at 40 GB into Europe. The
# preflight in build-global.sh is what catches that; here we only create the dirs.
mkdir -p "$RATMAP_WORK/tmp" "$RATMAP_CACHE/osm" "$RATMAP_WORK/home" "$RATMAP_WORK/logs"
mkdir -p "$INFRA_DIR/dist"

usage() {
  cat <<'USAGE'
ratmap infra toolchain

  global [stages...] [--force] [--dry-run]   run the planet-scale pipeline
                                             stages: prefetch world terrain peaks places
                                                     regions contours manifest all
  <script>.sh [args...]                      run one infra/scripts entry directly, e.g.
                                               build-region.sh scotland --dry-run
                                               build-world-catalog.sh
                                               upload.sh
  doctor                                     print tool versions and resource limits
  shell                                      interactive bash
  help                                       this text

Mounts this image expects (see docker/README.md):
  /work                     >= 150 GB free   OSM cache + scratch; keep it between runs
  /opt/ratmap/infra/dist    >= 20 GB free    build output
  /opt/ratmap/infra/.env    (upload only)    R2 credentials, read-only

Everything the build scripts honour as an environment variable still works:
  PEAKS_SOURCE_URLS PLACES_SOURCE_URLS WORLD_SOURCE_URL TERRAIN_SOURCE_URL
  WORLD_CATALOG_MAXZOOM TERRAIN_MAXZOOM REGION_BASEMAP_MAXZOOM REGION_TERRAIN_MAXZOOM
  CONTOUR_INTERVAL INDEX_EVERY CONTOUR_MINZOOM CONTOUR_MAXZOOM
USAGE
}

doctor() {
  echo "== tools =="
  printf '  %-12s %s\n' pmtiles     "$(pmtiles version 2>&1 | head -1)"
  printf '  %-12s %s\n' tippecanoe  "$(tippecanoe --version 2>&1 | head -1)"
  printf '  %-12s %s\n' osmium      "$(osmium --version 2>&1 | head -1)"
  printf '  %-12s %s\n' gdal        "$(gdal_contour --version 2>&1 | head -1)"
  printf '  %-12s %s\n' ogr2ogr     "$(ogr2ogr --version 2>&1 | head -1)"
  printf '  %-12s %s\n' python3     "$(python3 --version 2>&1)"
  printf '  %-12s %s\n' sqlite3     "$(sqlite3 --version 2>&1 | awk '{print $1}')"
  printf '  %-12s %s\n' aws         "$(aws --version 2>&1 | head -1)"
  printf '  %-12s %s\n' curl        "$(curl --version 2>&1 | head -1 | cut -d' ' -f1-2)"
  # build-peaks.sh's prominence pass runs on this interpreter, not the system one.
  if [ -x "$INFRA_DIR/.venv/bin/python" ]; then
    printf '  %-12s %s\n' prominence \
      "$("$INFRA_DIR/.venv/bin/python" -c 'import numpy, scipy; print("numpy", numpy.__version__, "scipy", scipy.__version__)' 2>&1 | head -1)"
  else
    printf '  %-12s %s\n' prominence "MISSING $INFRA_DIR/.venv — build-peaks.sh will fail"
  fi

  echo
  echo "== ogr2ogr GeoJSONSeq driver (build-contours.sh index tagging) =="
  # NOT `grep -q`: it exits on the first match, which SIGPIPEs ogr2ogr, which under
  # `set -o pipefail` fails the whole pipeline and reports a present driver as missing.
  # Plain grep drains the input, so the exit status reflects the match and nothing else.
  if ogr2ogr --formats 2>/dev/null | grep -i 'GeoJSONSeq' >/dev/null; then
    echo "  GeoJSONSeq driver: OK"
  else
    # stdout, not stderr: doctor is a report, and stderr interleaves out of order with
    # the block-buffered stdout when the output is piped.
    echo "  GeoJSONSeq driver: MISSING — build-contours.sh will fail"
  fi

  echo
  echo "== resources =="
  ratmap-global --preflight-only || true
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  help|--help|-h) usage ;;
  doctor)         doctor ;;
  shell|bash)     exec bash "$@" ;;
  global)         exec ratmap-global "$@" ;;
  *.sh|*.py)
    if [ -x "$SCRIPTS_DIR/$cmd" ]; then
      exec "$SCRIPTS_DIR/$cmd" "$@"
    fi
    echo "No such script: $cmd (looked in $SCRIPTS_DIR)" >&2
    echo "Available:" >&2
    ls -1 "$SCRIPTS_DIR" | sed 's/^/  /' >&2
    exit 1
    ;;
  *)
    # Anything else is a plain command, so `docker run ... ratmap-infra pmtiles show x`
    # and one-off shell pipelines keep working.
    exec "$cmd" "$@"
    ;;
esac
