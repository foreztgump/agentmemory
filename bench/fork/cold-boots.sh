#!/usr/bin/env bash
# Boot agentmemory N times on a cold Kvrocks and count the state adapter's reply timeouts in each boot's log.
# Needs a replica already loaded with REPLICA_STORE=kvrocks (replica.sh up). Each boot removes the agentmemory
# container, restarts Kvrocks (empty block cache; the host page cache stays warm) and starts agentmemory again.
#
#   REPLICA_PROJECT=... REPLICA_STORE=kvrocks AM_IMAGE=... cold-boots.sh <count> <log-dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNT="${1:?usage: cold-boots.sh <count> <log-dir>}"
[[ "$COUNT" =~ ^[1-9][0-9]*$ ]] || { echo "cold-boots: count must be a positive integer" >&2; exit 1; }
LOGS="${2:?usage: cold-boots.sh <count> <log-dir>}"
: "${REPLICA_PROJECT:?set REPLICA_PROJECT}"
[[ "${REPLICA_STORE:-}" == kvrocks ]] || { echo "cold-boots: REPLICA_STORE must be kvrocks" >&2; exit 1; }
APP="${REPLICA_PROJECT}-agentmemory-1"
KVROCKS="${REPLICA_PROJECT}-kvrocks-1"
# The adapter's own reply timeout on any state op, and StateKV's fallback warning after one.
TIMEOUT='from Redis: .*timed out|timed out on the redis store'
mkdir -p "$LOGS"

for ((boot = 1; boot <= COUNT; boot++)); do
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker restart "$KVROCKS" >/dev/null
  for ((waited = 0; waited < 120; waited++)); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' "$KVROCKS")" == healthy ]] && break
    sleep 1
  done
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$KVROCKS")" == healthy ]] || { echo "cold-boots: $KVROCKS not healthy" >&2; exit 1; }
  started=$(date +%s)
  ready=ok
  "$HERE/replica.sh" app >/dev/null 2>"$LOGS/boot-$boot.err" || ready=FAILED
  docker logs "$APP" >"$LOGS/boot-$boot.log" 2>&1 || : >"$LOGS/boot-$boot.log"
  echo "boot $boot: ready=$ready in $(( $(date +%s) - started )) s, adapter timeouts=$(grep -ciE "$TIMEOUT" "$LOGS/boot-$boot.log" || true)"
done
