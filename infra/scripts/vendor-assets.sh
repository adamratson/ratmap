#!/usr/bin/env bash
# Vendors glyphs + sprites locally (C7): left remote, the offline map renders geometry
# with no labels and no icons. Output goes straight into public/ — these ship with the
# app, they're not a data artifact uploaded to R2.
#
# Only vendors the 3 fontstacks the default (non-script-specific) style path actually
# uses — Regular/Italic/Medium, matching our current {lang:'en'} usage in src/main.ts (see
# @protomaps/basemaps' text-font defaults). Script-specific stacks (Devanagari, CJK, ...)
# aren't vendored; add them if/when the app adds non-Latin language support.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ASSETS_BASE="https://protomaps.github.io/basemaps-assets"
APP_PUBLIC="$INFRA_DIR/../public"

FONTSTACKS=("Noto Sans Regular" "Noto Sans Italic" "Noto Sans Medium")

fetch_fontstack() {
  local stack="$1"
  local out_dir="$APP_PUBLIC/fonts/$stack"
  mkdir -p "$out_dir"
  echo "Fetching fontstack: $stack (256 range files)"
  # Range files are named "<start>-<end>.pbf" for every 256-codepoint block, 0..65535.
  local start end
  for start in $(seq 0 256 65280); do
    end=$((start + 255))
    local url="$ASSETS_BASE/fonts/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$stack")/${start}-${end}.pbf"
    curl -sf "$url" -o "$out_dir/${start}-${end}.pbf" || echo "  (skip, no glyphs in range ${start}-${end})"
  done
}

for stack in "${FONTSTACKS[@]}"; do
  fetch_fontstack "$stack"
done

echo "Fetching sprites (light + light@2x)"
mkdir -p "$APP_PUBLIC/sprites"
for f in light.json light.png light@2x.json light@2x.png; do
  curl -sf "$ASSETS_BASE/sprites/v4/$f" -o "$APP_PUBLIC/sprites/$f"
done

echo "Done. See public/fonts/ and public/sprites/."
du -sh "$APP_PUBLIC/fonts" "$APP_PUBLIC/sprites"
