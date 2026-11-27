#!/usr/bin/env bash
# One enforcing sweep with everything recorded around it (TEE-1158 slice 12): fresh memory.peak (all three containers restarted),
# a before snapshot (KV scope counts, Qdrant point counts), a 1 s memory sampler, the sweep through the REST route, an after
# snapshot, the peaks, the audit entries of the run and the vault check.
#
#   bench/fork/retention/run-enforce.sh <out-dir> <tag> [--strip-access] [--dry]
#
# --strip-access runs strip-access.ts beside the sweep, to force R9 (see that script). --dry runs a dry sweep instead (no vault check).
# S12_DIRECT=1 triggers the sweep with trigger.mjs inside the container instead of the REST route, which answers 504 after 180 s
# and hides the function's result; the function's own result or error goes to <tag>-direct.json. The caller sets the S12_* settings.
# <out-dir> must be S12_DIR, which the client container mounts at /private: the checkers read the snapshots from there.
# Exits 2 on a bad argument or out-dir and 4 when the sweep left no run id, the direct trigger failed, or --strip-access did not
# delete the access logs (R9 not exercised); the artifacts are still written, and <tag>-times.txt says which.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/stage.sh"; M="$HERE/sample-mem.sh"
D="$1"; tag="$2"; shift 2
strip=""; dry=""
for a in "$@"; do
  case "$a" in
    --strip-access) strip=$a ;;
    --dry) dry=$a ;;
    *) echo "run-enforce: unknown argument $a" >&2; exit 2 ;;
  esac
done
mkdir -p "$D"
S12="${S12_DIR:-/home/cownose/am-staging/s12}"
[[ "$(realpath -m "$D")" == "$(realpath -m "$S12")" ]] || { echo "out-dir $D is not S12_DIR ($S12), the /private mount the checkers read" >&2; exit 2; }
export REPLICA_PROJECT="${REPLICA_PROJECT:-tee1158s12}"
rel="bench/fork/retention"
"$S" restart-all > "$D/$tag-restart.log" 2>&1
"$S" peaks > "$D/$tag-boot-peaks.json"
"$S" run $rel/snapshot.ts > "$D/$tag-before.json"
trap 'touch "$D/$tag-mem.tsv.stop"' EXIT
"$M" run "$D/$tag-mem.tsv" &
sampler=$!
t0=$(date -Is)
if [[ "$strip" == --strip-access ]]; then
  "$S" run $rel/strip-access.ts --cases /private/cases.json --after "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$D/$tag-strip.json" 2> "$D/$tag-strip.err" &
  strip_pid=$!
fi
mode=--enforce; payload='{"dryRun":false}'; [[ -n "$dry" ]] && { mode=--dry; payload='{"dryRun":true}'; }
if [[ "${S12_DIRECT:-}" == 1 ]]; then
  docker cp "$HERE/trigger.mjs" "$REPLICA_PROJECT-agentmemory-1:/opt/agentmemory/trigger.mjs"
  docker exec -w /opt/agentmemory "$REPLICA_PROJECT-agentmemory-1" node trigger.mjs mem::retention-sweep "$payload" 3000 2>/dev/null | grep -v '^\[' > "$D/$tag-direct.json"
  # --latest would summarise the newest run even when the trigger failed, so a failed trigger is recorded and fails the script.
  grep -q '"ok":true' "$D/$tag-direct.json" || direct_failed=1
  mode=--latest
fi
"$S" run $rel/sweep.ts $mode > "$D/$tag-sweep.json" 2> "$D/$tag-sweep.err"
t1=$(date -Is)
touch "$D/$tag-mem.tsv.stop"; wait "$sampler" 2>/dev/null || true
echo "start $t0 end $t1" > "$D/$tag-times.txt"
rc=0
if [[ -n "${direct_failed:-}" ]]; then echo "the direct trigger failed (see $tag-direct.json)" | tee -a "$D/$tag-times.txt" >&2; rc=4; fi
if [[ -n "${strip_pid:-}" ]]; then
  # strip-access exits right after it deletes the access logs; one still running when the sweep is over never saw the verdict.
  kill -0 "$strip_pid" 2>/dev/null && kill "$strip_pid" 2>/dev/null
  if ! wait "$strip_pid"; then echo "strip-access did not delete the access logs: R9 not exercised (see $tag-strip.err)" | tee -a "$D/$tag-times.txt" >&2; rc=4; fi
fi
"$S" peaks > "$D/$tag-peaks.json"
"$M" summary "$D/$tag-mem.tsv" > "$D/$tag-mem-summary.jsonl"
"$S" run $rel/snapshot.ts > "$D/$tag-after.json"
runId="$(jq -r .runId "$D/$tag-sweep.json")"
[[ "$runId" == ret_* ]] || { echo "no run id in $tag-sweep.json: the sweep left no run to check" | tee -a "$D/$tag-times.txt" >&2; exit 4; }
[[ "$(jq -r .phase "$D/$tag-sweep.json")" == done ]] || { echo "run $runId did not close (phase $(jq -r .phase "$D/$tag-sweep.json"), pollTimedOut $(jq -r .pollTimedOut "$D/$tag-sweep.json"))" | tee -a "$D/$tag-times.txt" >&2; rc=4; }
if [[ -n "$dry" ]]; then echo done >> "$D/$tag-times.txt"; exit "$rc"; fi
"$S" run $rel/audit.ts --run "$runId" > "$D/$tag-audit.json" 2>&1
echo "audit rc=$?" >> "$D/$tag-times.txt"
"$S" run $rel/vault-check.ts --run "$runId" --baseline "/private/$tag-before.json" > "$D/$tag-vault-check.json" 2> "$D/$tag-vault-check.err"
echo "vault-check rc=$?" >> "$D/$tag-times.txt"
"$S" run $rel/diff-snapshots.ts "/private/$tag-before.json" "/private/$tag-after.json" > "$D/$tag-diff.json"
echo done >> "$D/$tag-times.txt"
exit "$rc"
