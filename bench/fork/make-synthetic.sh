#!/usr/bin/env bash
# Build a synthetic Valkey snapshot of N observations for the benchmarks:
# generate records into an empty replica, boot agentmemory once, seed the graph
# cases through the real write path, then save dump.rdb into <out-dir>.
#
#   AM_IMAGE=<image> make-synthetic.sh <count> <out-dir> [profile.json]
#
# Seeding the graph needs agentmemory to boot on the new store. For a size it
# cannot boot (the in-memory baseline at 1M), set SYNTHETIC_GRAPH=0 to save the
# records alone; the graph cases then fail by design.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COUNT="${1:?usage: make-synthetic.sh <count> <out-dir> [profile.json]}"
OUT="${2:?usage: make-synthetic.sh <count> <out-dir> [profile.json]}"
PROFILE="${3:-bench/fork/profiles/buddy-2026-11-16.json}"
: "${AM_IMAGE:?set AM_IMAGE}"
export REPLICA_PROJECT="${REPLICA_PROJECT:-amreplica}"
replica() { "$HERE/replica.sh" "$@"; }
VALKEY="${REPLICA_PROJECT}-valkey-1"

mkdir -p "$OUT"
replica valkey none
echo "make-synthetic: writing $COUNT observations" >&2
(cd "$REPO" && node --import tsx bench/fork/generate.ts --count "$COUNT" --profile "$PROFILE") |
  docker exec -i "$VALKEY" valkey-cli --pipe >&2
if [[ "${SYNTHETIC_GRAPH:-1}" == 1 ]]; then
  replica app
  replica client node --import tsx bench/fork/seed-graph.ts --profile "$PROFILE" >&2
  docker compose -f "$HERE/replica-compose.yml" -p "$REPLICA_PROJECT" --profile app stop agentmemory >&2
else
  echo "make-synthetic: SYNTHETIC_GRAPH=0, graph cases not seeded" >&2
fi
docker exec "$VALKEY" valkey-cli save >&2
docker cp "$VALKEY:/data/dump.rdb" "$OUT/dump.rdb"
replica counts > "$OUT/counts.txt"
replica stop
echo "make-synthetic: wrote $OUT/dump.rdb" >&2
