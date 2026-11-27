#!/usr/bin/env bash
# R12 at full size (TEE-1158 slice 12): start an enforcing sweep, kill the agentmemory container in mid-apply (docker kill), restart it,
# trigger the sweep again, and check that it resumed the same run. Everything is recorded in <out-dir> under <tag>-*.
#
#   bench/fork/retention/kill-resume.sh <out-dir> <tag> [held-at-kill, default 10000]
#
# 1. restart all three containers (a fresh memory.peak), snapshot (KV scope counts, Qdrant point counts), start the 1 s memory sampler;
# 2. sweep through the REST route; poll the run row until phase is apply and held reaches the kill point; docker kill agentmemory;
# 3. docker start, wait until ready, call the sweep again. It answers 409 busy while the dead sweep's lease is fresh (the lease goes stale
#    after 5 minutes), so the call is repeated every 15 s; the first answer that is not 409 is the resumed sweep's;
# 4. checks: same run id, outcome, the vault check (no item both live and vaulted, held equals the vault, conservation), the audit
#    entries, the snapshot diff, and the time `state::list_keys` takes on the full vault (the adapter's reply limit is 500 ms).
# The caller sets the S12_* settings, and has reset `enforced-runs` if the first-run cap should apply.
# KR_ATTACH=1 KR_AFTER=<ISO time> continues a run whose first steps were done by hand (see the comments in the loop).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/stage.sh"; M="$HERE/sample-mem.sh"; rel=bench/fork/retention
D="$1"; tag="$2"; kill_at="${3:-10000}"
mkdir -p "$D"
export REPLICA_PROJECT="${REPLICA_PROJECT:-tee1158s12}"
P="$REPLICA_PROJECT"
now() { date +%s.%N; }
after_iso="${KR_AFTER:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"
if [[ -z "${KR_ATTACH:-}" ]]; then
  "$S" restart-all > "$D/$tag-restart.log" 2>&1
  "$S" peaks > "$D/$tag-boot-peaks.json"
  "$S" run $rel/snapshot.ts > "$D/$tag-before.json"
  "$M" run "$D/$tag-mem.tsv" &
  sampler=$!
  after_iso="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  echo "start $(date -Is)" > "$D/$tag-kill.txt"
  "$S" run $rel/sweep.ts --enforce --no-poll > "$D/$tag-first-sweep.json" 2> "$D/$tag-first-sweep.err" &
  sweep_pid=$!
  : > "$D/$tag-poll.log"
else
  # KR_ATTACH=1: the first steps ran already (the sampler and the first sweep are running); KR_AFTER is the time the sweep started.
  sampler=""; sweep_pid=""
fi
t0=$(now)
while :; do
  row="$("$S" run $rel/poll-run.ts --after "$after_iso" 2>/dev/null || true)"
  [[ -n "$row" ]] || { sleep 2; continue; }
  phase="$(jq -r .phase <<<"$row")"; held="$(jq -r .held <<<"$row")"
  echo "$(date -Is) phase=$phase held=$held" >> "$D/$tag-poll.log"
  if [[ "$phase" == apply && "$held" -ge "$kill_at" ]]; then break; fi
  if [[ "$phase" == done ]]; then echo "the run finished before the kill point" | tee -a "$D/$tag-kill.txt" >&2; exit 3; fi
  sleep 2
done
t_kill=$(now)
docker kill "$P-agentmemory-1" > /dev/null
echo "killed at $(date -Is), $(awk "BEGIN{print $t_kill-$t0}") s after the sweep started" | tee -a "$D/$tag-kill.txt"
"$S" run $rel/poll-run.ts 2>/dev/null > "$D/$tag-row-at-kill.json" || true
[[ -n "$sweep_pid" ]] && { wait "$sweep_pid" || true; }
docker start "$P-agentmemory-1" > /dev/null
t_start=$(now)
READY_TIMEOUT_S=1200 "$HERE/../replica.sh" wait >&2
t_ready=$(now)
echo "restart to ready: $(awk "BEGIN{print $t_ready-$t_start}") s" | tee -a "$D/$tag-kill.txt"
"$S" run $rel/poll-run.ts 2>/dev/null > "$D/$tag-row-after-restart.json" || true
: > "$D/$tag-retries.log"
attempt=0
while :; do
  attempt=$((attempt + 1))
  "$S" run $rel/sweep.ts --enforce > "$D/$tag-second-sweep.json" 2> "$D/$tag-second-sweep.err" || true
  status="$(jq -r .httpStatus "$D/$tag-second-sweep.json" 2>/dev/null || echo 0)"
  echo "$(date -Is) attempt=$attempt http=$status runId=$(jq -r .runId "$D/$tag-second-sweep.json" 2>/dev/null) since_restart=$(awk "BEGIN{print $(now)-$t_start}") s" | tee -a "$D/$tag-retries.log"
  [[ "$status" == 409 ]] || break
  sleep 15
done
t_done=$(now)
echo "second sweep closed the run $(awk "BEGIN{print $t_done-$t_start}") s after the restart; total $(awk "BEGIN{print $t_done-$t0}") s" | tee -a "$D/$tag-kill.txt"
touch "$D/$tag-mem.tsv.stop"; [[ -n "$sampler" ]] && { wait "$sampler" 2>/dev/null || true; }; sleep 2
"$S" peaks > "$D/$tag-peaks.json"
"$M" summary "$D/$tag-mem.tsv" > "$D/$tag-mem-summary.jsonl"
runId="$(jq -r .runId "$D/$tag-second-sweep.json")"
"$S" run $rel/snapshot.ts > "$D/$tag-after.json"
"$S" run $rel/audit.ts --run "$runId" > "$D/$tag-audit.json" 2>&1
"$S" run $rel/vault-check.ts --run "$runId" --baseline "/private/$tag-before.json" > "$D/$tag-vault-check.json" 2> "$D/$tag-vault-check.err"
echo "vault-check rc=$?" >> "$D/$tag-kill.txt"
"$S" run $rel/diff-snapshots.ts "/private/$tag-before.json" "/private/$tag-after.json" > "$D/$tag-diff.json"
docker cp "$HERE/trigger.mjs" "$P-agentmemory-1:/opt/agentmemory/trigger.mjs"
for i in 1 2 3; do
  docker exec -w /opt/agentmemory "$P-agentmemory-1" node trigger.mjs state::list_keys "{\"scope\":\"mem:retention:vault:$runId\"}" 2000 2>/dev/null | grep -v '^\[' | jq -c '{ok,ms,error}' >> "$D/$tag-listkeys.log"
done
echo done >> "$D/$tag-kill.txt"
