#!/usr/bin/env bash
# Run the whole baseline matrix and check it against bench/fork/ceilings.json.
# One replica at a time; each run restores a fresh copy and removes it after.
#
#   AM_IMAGE=<image> baseline.sh <buddy-backup-dir> <private-cases.json> <synthetic-root> <results-dir>
#
# <synthetic-root>/<count>/dump.rdb is built by make-synthetic.sh when missing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BUDDY="${1:?usage: baseline.sh <buddy-backup-dir> <private-cases.json> <synthetic-root> <results-dir>}"
PRIVATE="${2:?private cases file}"
SYNTH="${3:?synthetic root}"
RESULTS="${4:?results dir}"
: "${AM_IMAGE:?set AM_IMAGE}"
mkdir -p "$RESULTS"
cd "$REPO"

failed=0
bench() {
  local name="$1"; shift
  node --import tsx bench/fork/bench.ts --name "$name" --out "$RESULTS/$name.json" "$@" || failed=1
}

bench buddy-keyword --data "$BUDDY" --cases "$PRIVATE"
bench buddy-vectors --data "$BUDDY" --cases "$PRIVATE" --embedding voyage --am-mem-limit 5g
for count in 250000 500000; do
  [[ -s "$SYNTH/$count/dump.rdb" ]] || AM_MEM_LIMIT=6g "$HERE/make-synthetic.sh" "$count" "$SYNTH/$count" || failed=1
done
[[ -s "$SYNTH/1000000/dump.rdb" ]] || SYNTHETIC_GRAPH=0 "$HERE/make-synthetic.sh" 1000000 "$SYNTH/1000000" || failed=1
bench synthetic-250k --data "$SYNTH/250000/dump.rdb" --cases bench/fork/eval/synthetic-cases.json
bench synthetic-500k-6g --data "$SYNTH/500000/dump.rdb" --cases bench/fork/eval/synthetic-cases.json --am-mem-limit 6g
# Fails on the in-memory baseline by design; see the synthetic-1m entry in ceilings.json.
bench synthetic-1m --data "$SYNTH/1000000/dump.rdb" --cases bench/fork/eval/synthetic-cases.json --am-mem-limit 6g
exit "$failed"
