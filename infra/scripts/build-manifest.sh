#!/usr/bin/env bash
# Generate regions/manifest.json — the download catalogue the app reads — or update it
# incrementally from a base manifest. Go, in tools/cmd/build-manifest (a port of
# build-manifest.py), built from this checkout and run with these arguments:
#
#   ./scripts/build-manifest.sh [dist_dir]                    # full rebuild from dist/regions
#   ./scripts/build-manifest.sh [dist_dir] --base-live        # merge into the live manifest
#   ./scripts/build-manifest.sh [dist_dir] --base PATH_OR_URL # merge into another one
#       [--prune] [--only REGEX]
#
# See tools/cmd/build-manifest/main.go for what each mode does and why.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
go_run build-manifest "$@"
