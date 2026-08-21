#!/usr/bin/env bash
# Coarse global terrain: a low-zoom pmtiles extract from Mapterhorn's planet archive, not
# the full ~706 GB terrain (C15 — extract our own copy, don't hotlink theirs).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd pmtiles

SOURCE_URL="${TERRAIN_SOURCE_URL:-https://download.mapterhorn.com/planet.pmtiles}"

# Raster tiles are much heavier than the vector world catalog at the same zoom — verified
# 2026-08-21: maxzoom=4 -> ~62 MB, maxzoom=6 -> ~862 MB (both via range requests, not a
# full download of the 706 GB source). Default to 4; override for more detail if the
# region you care about needs it, but check the size first.
MAXZOOM="${TERRAIN_MAXZOOM:-4}"
VERSION="$(date +%Y-%m-%d)"
OUT="$DIST_DIR/terrain-global-${VERSION}.pmtiles"

echo "Extracting coarse global terrain (maxzoom=${MAXZOOM}) from ${SOURCE_URL}"
pmtiles extract "$SOURCE_URL" "$OUT" --maxzoom="$MAXZOOM"

pmtiles show "$OUT"
echo "Built $OUT"
