#!/usr/bin/env bash
# Builds the map's label glyphs: Barlow, with Noto Sans as the fallback for every codepoint
# Barlow lacks (plans/signature-style.md step 6).
#
# Why a baked stack rather than `text-font: ['Barlow …', 'Noto Sans …']`: MapLibre asks a
# static glyph server for the *joined* fontstack name, so a two-font array still needs one
# pre-combined directory. Protomaps' layers() also takes a single name per flavour slot
# (regular/bold/italic). So each stack is combined here, once, and named for what it
# holds — "Barlow Noto Regular" — so nobody mistakes it for Barlow alone.
#
# Barlow covers Latin, Latin Extended and Vietnamese. Greek, Cyrillic, symbols and
# everything else come from Noto. Medium and Italic fall back to Noto Sans Regular last:
# Protomaps' Medium and Italic ranges are far sparser than Regular's (7k and 3k glyphs
# against 13k), and Medium has no ▲ at all. That glyph is the Munro label prefix
# (src/overlays/peaks.ts), which as a result had never rendered. A Regular-weight glyph in a
# Medium label beats a missing one. The cost is size: ~20 MB of glyphs across the three
# stacks, against ~13 MB for the plain Noto sets, all precached.
#
# Barlow and Noto, measured at the 24px glyph size: cap height 17px in each, Barlow's
# baseline 1px above Noto's. That only shows in a label mixing Latin with another script.
#
# Inputs:
#   assets/fonts/barlow/*.ttf         Barlow 1.408 from github.com/google/fonts (OFL)
#   infra/.cache/glyphs-src/Noto …    Protomaps' Noto glyph ranges, fetched by
#                                     infra/scripts/vendor-assets.sh (build input only;
#                                     no longer shipped on their own)
# Tool:
#   build_pbf_glyphs 1.4.3 (github.com/stadiamaps/sdf_font_tools) on PATH, needs FreeType.
#   It renders fontnik-compatible SDFs (24px, radius 8, cutoff 0.25), the same parameters
#   the vendored Noto glyphs use.
#     cargo install build_pbf_glyphs --version 1.4.3 --locked
#   (1.5.x needs rustc >= 1.87.)
#
# Output: public/fonts/Barlow Noto {Regular,Medium,Italic}/<start>-<end>.pbf, and the two
# OFL licences beside them — the PBFs are derived from both fonts, and the OFL requires
# the licence to travel with them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BARLOW_DIR="$ROOT/assets/fonts/barlow"
NOTO_DIR="$ROOT/infra/.cache/glyphs-src"
OUT_DIR="$ROOT/public/fonts"

command -v build_pbf_glyphs >/dev/null || {
  echo "build_pbf_glyphs not on PATH — see the header of this script." >&2
  exit 1
}
for stack in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
  [[ -d "$NOTO_DIR/$stack" ]] || {
    echo "Missing $NOTO_DIR/$stack — run infra/scripts/vendor-assets.sh first." >&2
    exit 1
  }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# build_pbf_glyphs combines stacks that sit side by side in its output directory, so the
# Noto ranges are staged next to the freshly rendered Barlow ones.
cp -R "$NOTO_DIR/"* "$WORK/"
cat >"$WORK/combinations.json" <<'JSON'
{
  "Barlow Noto Regular": ["Barlow-Regular", "Noto Sans Regular"],
  "Barlow Noto Medium": ["Barlow-Medium", "Noto Sans Medium", "Noto Sans Regular"],
  "Barlow Noto Italic": ["Barlow-Italic", "Noto Sans Italic", "Noto Sans Regular"]
}
JSON

build_pbf_glyphs "$BARLOW_DIR" "$WORK" -c "$WORK/combinations.json"

mkdir -p "$OUT_DIR"
for stack in "Barlow Noto Regular" "Barlow Noto Medium" "Barlow Noto Italic"; do
  rm -rf "${OUT_DIR:?}/$stack"
  cp -R "$WORK/$stack" "$OUT_DIR/$stack"
done
cp "$BARLOW_DIR/OFL.txt" "$OUT_DIR/OFL-Barlow.txt"
cp "$ROOT/assets/fonts/noto/OFL.txt" "$OUT_DIR/OFL-Noto-Sans.txt"

du -sh "$OUT_DIR"/*
