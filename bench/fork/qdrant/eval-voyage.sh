#!/usr/bin/env bash
# End-to-end recall eval with query embeddings, before and after the search
# migration, on one replica of a backup:
#   1. load the backup into Valkey and copy it to Kvrocks (replica.sh valkey, REPLICA_STORE=kvrocks);
#   2. baseline: agentmemory in memory mode, eval;
#   3. migrate: Qdrant, search-migrate.ts fill and verify;
#   4. migrated: agentmemory in disk mode on the filled index, eval.
#
#   VOYAGE_API_KEY=... AM_IMAGE=<image> bench/fork/qdrant/eval-voyage.sh <backup-dir> <cases.json> <out-dir>
#   EVAL_KEYWORD_ONLY=1 AM_IMAGE=<image> bench/fork/qdrant/eval-voyage.sh ...   # no provider, no key, no egress
#
# The caller holds /tmp/am-replica.lock. With a key, Voyage receives 2 x (cases)
# query embeddings and at most 1 boot backfill embedding (bench/fork/replica-voyage.yml);
# the migration itself makes none. Limits: Kvrocks 1024m, the memory-mode app 4608m
# (it holds every vector), the disk-mode app 1792m with Qdrant 1536m, the client 1g.
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: eval-voyage.sh <backup-dir> <cases.json> <out-dir>" >&2; exit 2; }
: "${AM_IMAGE:?set AM_IMAGE}"
backup="$1" cases="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")" out="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
R="$REPO/bench/fork/replica.sh"
voyage=(-f "$REPO/bench/fork/replica-voyage.yml")
if [[ "${EVAL_KEYWORD_ONLY:-}" == 1 ]]; then voyage=(); else : "${VOYAGE_API_KEY:?set VOYAGE_API_KEY or EVAL_KEYWORD_ONLY=1}"; fi
export REPLICA_PROJECT="${REPLICA_PROJECT:-evalvoyage}" REPLICA_STORE=kvrocks REPLICA_PRIVATE_DIR="$(dirname "$cases")"
export VALKEY_MEM_LIMIT="${VALKEY_MEM_LIMIT:-2560m}" VALKEY_MAXMEMORY="${VALKEY_MAXMEMORY:-2300mb}" KVROCKS_MEM_LIMIT="${KVROCKS_MEM_LIMIT:-1024m}" QDRANT_MEM_LIMIT="${QDRANT_MEM_LIMIT:-1536m}"
KV="$(grep -oP '^KVROCKS_URL="\K[^"]+' "$R")"
base=(-f "$REPO/bench/fork/replica-compose.yml")
disk=(-f "$HERE/replica-disk.yml")
mkdir -p "$out"
log() { echo "eval-voyage: $*" >&2; }
cleanup() { REPLICA_COMPOSE_EXTRA="$HERE/replica-disk.yml" "$R" down >&2 || true; }
trap cleanup EXIT

app() {
  local limit="$1"; shift
  docker rm -f "$REPLICA_PROJECT-agentmemory-1" >/dev/null 2>&1 || true
  AM_MEM_LIMIT="$limit" REPLICA_REDIS_URL="$KV" docker compose "$@" -p "$REPLICA_PROJECT" --profile app up -d agentmemory >&2
  READY_TIMEOUT_S=1200 "$R" wait
}
evaluate() {
  docker rm -f "$REPLICA_PROJECT-client-1" >/dev/null 2>&1 || true
  "$R" client node --import tsx bench/fork/eval.ts --cases "/private/$(basename "$cases")" --details > "$out/$1.json"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2], JSON.stringify(Object.values(d)[0].scores))' "$out/$1.json" "$1"
}
migrate() {
  "$R" client env MIGRATE_STORE_URL="$KV" AM_QDRANT_URL=http://qdrant:6333 AM_QDRANT_API_KEY=replica-dummy-qdrant-key \
    node --import tsx scripts/fork/search-migrate.ts "$@"
}

"$R" valkey "$backup"
log "baseline: memory mode"
app 4608m "${base[@]}" "${voyage[@]}"
evaluate baseline
docker rm -f "$REPLICA_PROJECT-agentmemory-1" >/dev/null
log "migrating"
docker compose "${base[@]}" "${disk[@]}" -p "$REPLICA_PROJECT" up -d --wait qdrant >&2
migrate fill
migrate verify | tee "$out/verify.txt"
log "migrated: disk mode"
app 1792m "${base[@]}" "${disk[@]}" "${voyage[@]}"
evaluate migrated
