#!/usr/bin/env bash
# One enforcing sweep with everything recorded around it (TEE-1158 slice 12): fresh memory.peak (all three containers restarted),
# a before snapshot (KV scope counts, Qdrant point counts), a 1 s memory sampler, the sweep through the REST route, an after
# snapshot, the peaks, the audit entries of the run and the vault check.
#
#   bench/fork/retention/run-enforce.sh <out-dir> <tag> [--strip-access]
#
# --strip-access runs strip-access.ts beside the sweep, to force R9 (see that script). The caller sets the S12_* settings.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/stage.sh"; M="$HERE/sample-mem.sh"
D="$1"; tag="$2"; strip="${3:-}"
mkdir -p "$D"
export REPLICA_PROJECT="${REPLICA_PROJECT:-tee1158s12}"
rel="bench/fork/retention"
"$S" restart-all > "$D/$tag-restart.log" 2>&1
"$S" peaks > "$D/$tag-boot-peaks.json"
"$S" run $rel/snapshot.ts > "$D/$tag-before.json"
"$M" run "$D/$tag-mem.tsv" &
sampler=$!
t0=$(date -Is)
if [[ "$strip" == --strip-access ]]; then
  "$S" run $rel/strip-access.ts --cases /private/cases.json --after "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$D/$tag-strip.json" 2> "$D/$tag-strip.err" &
fi
"$S" run $rel/sweep.ts --enforce > "$D/$tag-sweep.json" 2> "$D/$tag-sweep.err"
t1=$(date -Is)
touch "$D/$tag-mem.tsv.stop"; wait "$sampler" 2>/dev/null || true
echo "start $t0 end $t1" > "$D/$tag-times.txt"
"$S" peaks > "$D/$tag-peaks.json"
"$M" summary "$D/$tag-mem.tsv" > "$D/$tag-mem-summary.jsonl"
"$S" run $rel/snapshot.ts > "$D/$tag-after.json"
runId="$(jq -r .runId "$D/$tag-sweep.json")"
"$S" run $rel/audit.ts --run "$runId" > "$D/$tag-audit.json" 2>&1
"$S" run $rel/vault-check.ts --run "$runId" --baseline "/private/$tag-before.json" > "$D/$tag-vault-check.json" 2> "$D/$tag-vault-check.err"
echo "vault-check rc=$?" >> "$D/$tag-times.txt"
"$S" run $rel/diff-snapshots.ts "/private/$tag-before.json" "/private/$tag-after.json" > "$D/$tag-diff.json"
echo done >> "$D/$tag-times.txt"
