#!/usr/bin/env bash
# Boot agentmemory N times on a cold Kvrocks and count the state adapter's reply timeouts in each boot's log.
# Needs a replica already loaded with REPLICA_STORE=kvrocks (replica.sh up). Each boot removes the agentmemory
# container, restarts Kvrocks (empty block cache; the host page cache stays warm) and starts agentmemory again.
#
#   REPLICA_PROJECT=... REPLICA_STORE=kvrocks AM_IMAGE=... cold-boots.sh <count> <log-dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNT="${1:?usage: cold-boots.sh <count> <log-dir>}"
LOGS="${2:?usage: cold-boots.sh <count> <log-dir>}"
: "${REPLICA_PROJECT:?set REPLICA_PROJECT}"
[[ "${REPLICA_STORE:-}" == kvrocks ]] || { echo "cold-boots: REPLICA_STORE must be kvrocks" >&2; exit 1; }
APP="${REPLICA_PROJECT}-agentmemory-1"
KVROCKS="${REPLICA_PROJECT}-kvrocks-1"
TIMEOUT='timed out'
mkdir -p "$LOGS"

for ((boot = 1; boot <= COUNT; boot++)); do
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker restart "$KVROCKS" >/dev/null
  until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$KVROCKS")" == healthy ]]; do sleep 1; done
  started=$(date +%s)
  ready=ok
  "$HERE/replica.sh" app >/dev/null 2>&1 || ready=FAILED
  docker logs "$APP" >"$LOGS/boot-$boot.log" 2>&1
  echo "boot $boot: ready=$ready in $(( $(date +%s) - started )) s, adapter timeouts=$(grep -ci "$TIMEOUT" "$LOGS/boot-$boot.log" || true)"
done
