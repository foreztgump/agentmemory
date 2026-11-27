#!/usr/bin/env bash
# Retention staging replica (TEE-1158 slice 12): buddy's backup in disk mode (Kvrocks + Qdrant), keyword-only.
# The caller holds /tmp/am-replica.lock. Everything is local: the replica network is internal, there is no embedding
# provider and no key.
#
#   stage.sh load              load the backup into Valkey, copy to Kvrocks, verify, stop Valkey
#   stage.sh fill              start Qdrant, run search-migrate fill and verify (no embedding calls)
#   stage.sh app               (re)create agentmemory with the S12_* settings below and wait until ready
#   stage.sh restart-all       restart Kvrocks, Qdrant and agentmemory so each memory.peak starts fresh, wait ready
#   stage.sh peaks             print memory.peak (MiB) of agentmemory, kvrocks and qdrant as JSON
#   stage.sh run <script.ts> [args]   run a bench/fork/retention script in the client container, with the store URL set
#   stage.sh client <cmd...>   run a command in the client container (repo at /work, cases dir at /private)
#   stage.sh down              remove the replica (volumes included)
#
# Settings: S12_DIR (scratch dir, default /home/cownose/am-staging/s12; holds the golden cases), AM_IMAGE, S12_BACKUP,
# and the retention overlay's S12_RETENTION, S12_WINDOWS, S12_GRACE_DAYS, S12_RECALL_CASES, S12_INTERVAL_MS.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
R="$REPO/bench/fork/replica.sh"
export AM_IMAGE="${AM_IMAGE:-am-ret:f188861}"
export REPLICA_PROJECT="${REPLICA_PROJECT:-tee1158s12}" REPLICA_STORE=kvrocks
export S12_DIR="${S12_DIR:-/home/cownose/am-staging/s12}"
export S12_CASES_DIR="$S12_DIR" REPLICA_PRIVATE_DIR="$S12_DIR"
export REPLICA_COMPOSE_EXTRA="$REPO/bench/fork/qdrant/replica-disk.yml:$HERE/replica-retention.yml"
export VALKEY_MEM_LIMIT="${VALKEY_MEM_LIMIT:-2560m}" VALKEY_MAXMEMORY="${VALKEY_MAXMEMORY:-2300mb}"
export KVROCKS_MEM_LIMIT="${KVROCKS_MEM_LIMIT:-1280m}" QDRANT_MEM_LIMIT="${QDRANT_MEM_LIMIT:-1g}" AM_MEM_LIMIT="${AM_MEM_LIMIT:-2048m}"
S12_BACKUP="${S12_BACKUP:-/home/cownose/am-staging/buddy-2026-11-16}"
mkdir -p "$S12_DIR"
P="$REPLICA_PROJECT"
KV="$(grep -oP '^KVROCKS_URL="\K[^"]+' "$R")"
COMPOSE=(docker compose -f "$REPO/bench/fork/replica-compose.yml" -f "$REPO/bench/fork/qdrant/replica-disk.yml" -f "$HERE/replica-retention.yml" -p "$P")
log() { echo "stage: $*" >&2; }

peak_mib() { docker exec "$P-$1-1" cat /sys/fs/cgroup/memory.peak | awk '{printf "%d", $1/1048576}'; }

case "${1:-}" in
  load) "$R" valkey "$S12_BACKUP" ;;
  fill)
    "${COMPOSE[@]}" up -d --wait qdrant >&2
    "$R" client env MIGRATE_STORE_URL="$KV" AM_QDRANT_URL=http://qdrant:6333 AM_QDRANT_API_KEY=replica-dummy-qdrant-key node --import tsx scripts/fork/search-migrate.ts fill
    "$R" client env MIGRATE_STORE_URL="$KV" AM_QDRANT_URL=http://qdrant:6333 AM_QDRANT_API_KEY=replica-dummy-qdrant-key node --import tsx scripts/fork/search-migrate.ts verify
    ;;
  app)
    docker rm -f "$P-agentmemory-1" >/dev/null 2>&1 || true
    REPLICA_REDIS_URL="$KV" "${COMPOSE[@]}" --profile app up -d agentmemory >&2
    READY_TIMEOUT_S=1200 "$R" wait
    ;;
  restart-all)
    docker restart "$P-kvrocks-1" >/dev/null
    docker restart "$P-qdrant-1" >/dev/null
    docker restart "$P-agentmemory-1" >/dev/null
    READY_TIMEOUT_S=1200 "$R" wait
    ;;
  peaks) printf '{"agentmemory":%s,"kvrocks":%s,"qdrant":%s}\n' "$(peak_mib agentmemory)" "$(peak_mib kvrocks)" "$(peak_mib qdrant)" ;;
  client) shift; "$R" client "$@" ;;
  run) shift; "$R" client env S12_STORE_URL="$KV" node --import tsx "$@" ;;
  down) "$R" down ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
