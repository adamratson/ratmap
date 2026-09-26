#!/usr/bin/env bash
# Generate regions.json — a globe-covering download catalogue — from Geofabrik's index.
# Go, in tools/cmd/build-catalog (a port of build-catalog.py), built from this checkout and
# run with these arguments:
#
#   ./scripts/build-catalog.sh                 # full run: measures every candidate (slow, cached)
#   ./scripts/build-catalog.sh --no-estimate   # rough pass off bbox area, for a quick look
#   ./scripts/build-catalog.sh --print         # summarise without writing regions.json
#
# See tools/cmd/build-catalog/main.go for what it does and why.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
go_run build-catalog "$@"
