#!/usr/bin/env bash
# Regenerates a command's goldens from its Python oracles: run from the command's
# directory (cd cmd/catalog && ../../internal/golden/gen-fixtures.sh). See golden.go for
# the format of testdata/cases.tsv.
set -uo pipefail
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  IFS=$'\t' read -r name oracle _ <<<"$line"
  keep_stderr=1
  case "$name" in '~'*) name="${name#\~}"; keep_stderr= ;; esac
  : > "$out"
  status=0
  (OUT="$out"; eval "$oracle") < /dev/null > "testdata/$name.want.stdout" 2> "testdata/$name.want.stderr" || status=$?
  echo "exit $status" >> "testdata/$name.want.stdout"
  # No golden for an empty stderr (golden.go reads its absence as empty), nor for a ~ case.
  if [ -z "$keep_stderr" ] || [ ! -s "testdata/$name.want.stderr" ]; then
    rm -f "testdata/$name.want.stderr"
  fi
  case "$line" in *'{{out}}'*) cp "$out" "testdata/$name.want.out" ;; esac
done < testdata/cases.tsv
