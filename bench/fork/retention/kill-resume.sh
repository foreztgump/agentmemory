#!/usr/bin/env bash
# R12 at full size: start an enforcing sweep, kill the agentmemory container in mid-apply, restart it and trigger the
# sweep again. Records the run row at the kill, how long the lease keeps the second call out, the resumed run's id and the
# time to finish. The check (vault-check.ts) is run by the caller afterwards.
#
#   bench/fork/retention/kill-resume.sh <out-dir> [held-at-kill, default 3000]
#
# The first sweep prints its summary when the connection drops; the second one is the call after the restart. A sweep that
# meets the dead sweep's lease answers 409 busy until the lease is 5 minutes stale (LEASE_STALE_MS), so the script retries.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/stage.sh"
out="$1"; kill_at="${2:-3000}"
mkdir -p "$out"
P="${REPLICA_PROJECT:-tee1158s12}"
now() { date +%s.%N; }
t0=$(now)
"$S" run bench/fork/retention/sweep.ts --enforce --no-poll > "$out/first-sweep.json" 2> "$out/first-sweep.err" &
sweep_pid=$!
while :; do
  row="$("$S" run bench/fork/retention/poll-run.ts 2>/dev/null || true)"
  [[ -n "$row" ]] || { sleep 2; continue; }
  phase="$(jq -r .phase <<<"$row")"; held="$(jq -r .held <<<"$row")"
  echo "$(date -Is) phase=$phase held=$held" >> "$out/poll.log"
  if [[ "$phase" == apply && "$held" -ge "$kill_at" ]]; then break; fi
  if [[ "$phase" == done ]]; then echo "the run finished before the kill point" >&2; exit 3; fi
  sleep 2
done
t_kill=$(now)
docker kill "$P-agentmemory-1" > /dev/null
echo "killed at $(date -Is) after $(awk "BEGIN{print $t_kill-$t0}") s" | tee "$out/kill.txt"
wait "$sweep_pid" || true
"$S" run bench/fork/retention/poll-run.ts 2>/dev/null > "$out/row-at-kill.json" || true
docker start "$P-agentmemory-1" > /dev/null
t_start=$(now)
READY_TIMEOUT_S=1200 "$HERE/../replica.sh" wait >&2
t_ready=$(now)
echo "restart to ready: $(awk "BEGIN{print $t_ready-$t_start}") s" | tee -a "$out/kill.txt"
"$S" run bench/fork/retention/poll-run.ts 2>/dev/null > "$out/row-after-restart.json" || true
: > "$out/retries.log"
attempt=0
while :; do
  attempt=$((attempt + 1))
  t_try=$(now)
  "$S" run bench/fork/retention/sweep.ts --enforce > "$out/second-sweep.json" 2> "$out/second-sweep.err" || true
  kind="$(jq -r '.kind // empty' "$out/second-sweep.json" 2>/dev/null || true)"
  status="$(jq -r .httpStatus "$out/second-sweep.json" 2>/dev/null || echo 0)"
  echo "$(date -Is) attempt=$attempt http=$status kind=$kind since_restart=$(awk "BEGIN{print $(now)-$t_start}") s" | tee -a "$out/retries.log"
  [[ "$status" == 409 ]] || break
  sleep 15
done
echo "second sweep done $(awk "BEGIN{print $(now)-$t_start}") s after the restart" | tee -a "$out/kill.txt"
