#!/usr/bin/env bash
# Run the whole baseline matrix and check it against bench/fork/ceilings.json.
# One replica at a time; each run restores a fresh copy and removes it after.
#
#   AM_IMAGE=<image> baseline.sh <buddy-backup-dir> <private-cases.json> <synthetic-root> <results-dir>
#
# <synthetic-root>/<count>/dump.rdb is built by make-synthetic.sh when missing
# (counts.txt, written last, marks a finished build).
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

trap '"$HERE/replica.sh" stop; exit 130' INT TERM

failed=0
bench() {
  local name="$1"; shift
  rm -f "$RESULTS/$name.json"
  node --import tsx bench/fork/bench.ts --name "$name" --out "$RESULTS/$name.json" "$@" || failed=1
}

bench buddy-keyword --data "$BUDDY" --cases "$PRIVATE"
bench buddy-vectors --data "$BUDDY" --cases "$PRIVATE" --embedding voyage --am-mem-limit 5g
for count in 250000 500000; do
  [[ -s "$SYNTH/$count/counts.txt" ]] || AM_MEM_LIMIT=6g "$HERE/make-synthetic.sh" "$count" "$SYNTH/$count" || failed=1
done
[[ -s "$SYNTH/1000000/counts.txt" ]] || SYNTHETIC_GRAPH=0 "$HERE/make-synthetic.sh" 1000000 "$SYNTH/1000000" || failed=1
bench synthetic-250k --data "$SYNTH/250000/dump.rdb" --cases bench/fork/eval/synthetic-cases.json
bench synthetic-500k-6g --data "$SYNTH/500000/dump.rdb" --cases bench/fork/eval/synthetic-cases.json --am-mem-limit 6g
# The synthetic-1m entry holds targets the in-memory baseline cannot meet, so a
# missed target does not decide the exit status: either the app never became
# ready, or every phase ran and a limit failed. Anything else is a broken bench.
rm -f "$RESULTS/synthetic-1m.json"
if ! node --import tsx bench/fork/bench.ts --name synthetic-1m --out "$RESULTS/synthetic-1m.json" \
  --data "$SYNTH/1000000/dump.rdb" --cases bench/fork/eval/synthetic-cases.json --am-mem-limit 6g; then
  if grep -qE '"completed": true|did not become ready' "$RESULTS/synthetic-1m.json" 2>/dev/null; then
    echo "baseline: synthetic-1m misses its targets (expected until a build boots 1M)" >&2
  else
    echo "baseline: synthetic-1m did not run; see the output above" >&2
    failed=1
  fi
fi
exit "$failed"
