#!/usr/bin/env bash
# Restore an offline replica of an agentmemory stack from a nightly backup.
#
#   replica.sh up <backup-dir|dump.rdb|none>  fresh volumes, load the snapshot, start agentmemory, wait until ready
#   replica.sh valkey <backup-dir|dump.rdb|none>  same, but stop before starting agentmemory
#   replica.sh app                       start agentmemory on the loaded Valkey and wait until ready
#   replica.sh wait                      wait until the running agentmemory is ready
#   replica.sh restart-valkey            restart Valkey and wait until it has loaded its AOF
#   replica.sh counts                    record counts per KV scope family
#   replica.sh client <cmd...>           run a command in the client container on the replica network
#                                        (worktree at /work, agentmemory at http://agentmemory:3111)
#   replica.sh prefetch                  fetch the image's iii workers into a cache volume (needs registry access)
#   replica.sh stop                      remove the replica but keep the worker cache volume
#   replica.sh down                      remove every container, volume and network the replica created
#
# Settings (environment): AM_IMAGE (required for up/app), REPLICA_PROJECT (default amreplica),
# AM_MEM_LIMIT, VALKEY_MEM_LIMIT, VALKEY_MAXMEMORY, REPLICA_EMBEDDING_PROVIDER, AGENTMEMORY_SCOPE_GUARD, READY_TIMEOUT_S,
# REPLICA_PRIVATE_DIR (mounted read-only at /private in the client container).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPLICA_PROJECT="${REPLICA_PROJECT:-amreplica}"
COMPOSE=(docker compose -f "$HERE/replica-compose.yml" -p "$REPLICA_PROJECT")
SECRET="replica-dummy-secret"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-900}"

die() { echo "replica: $*" >&2; exit 1; }
log() { echo "replica: $*" >&2; }

container() { echo "${REPLICA_PROJECT}-$1-1"; }
vcli() { docker exec "$(container valkey)" valkey-cli "$@"; }

snapshot_rdb() {
  local src="$1"
  if [[ "$src" == none ]]; then return; fi
  if [[ -f "$src" ]]; then echo "$src"; return; fi
  [[ -d "$src" ]] || die "no backup at $src"
  local zst
  zst="$(find "$src" -maxdepth 1 -name '*valkey.rdb.zst' -print -quit)"
  [[ -n "$zst" ]] || die "no *valkey.rdb.zst in $src"
  local out="$src/.decompressed/dump.rdb"
  if [[ ! -s "$out" || "$zst" -nt "$out" ]]; then
    mkdir -p "$src/.decompressed"
    log "decompressing $(basename "$zst")"
    zstd -d -f -q "$zst" -o "$out.tmp"
    mv "$out.tmp" "$out"
  fi
  echo "$out"
}

data_tar() {
  local src="$1"
  [[ -d "$src" ]] || return 0
  find "$src" -maxdepth 1 -name '*agentmemory-data.tar.zst' -print -quit
}

# The image's iii compose downloads its state and http workers on first boot,
# which an internal network forbids. Fetch them once into a cache volume from a
# throwaway container that mounts no replica data, then copy them into the
# replica's data volume so the replica boots offline.
prefetch_workers() {
  : "${AM_IMAGE:?set AM_IMAGE}"
  local cache="${REPLICA_PROJECT}_worker-cache" image_id stamp
  image_id="$(docker image inspect -f '{{.Id}}' "$AM_IMAGE")"
  stamp="$(docker run --rm -v "$cache:/cache" valkey/valkey:9 cat /cache/image-id 2>/dev/null || true)"
  [[ "$stamp" == "$image_id" ]] && return 0
  log "fetching iii workers for $AM_IMAGE (registry access, no replica data mounted)"
  docker volume rm "$cache" >/dev/null 2>&1 || true
  docker volume create "$cache" >/dev/null
  docker rm -f "${REPLICA_PROJECT}-prefetch" >/dev/null 2>&1 || true
  docker run -d --name "${REPLICA_PROJECT}-prefetch" --memory 1g -v "$cache:/data" "$AM_IMAGE" >/dev/null
  local i
  for i in $(seq 1 90); do
    docker logs "${REPLICA_PROJECT}-prefetch" 2>&1 | grep -q 'Downloads Complete' && break
    sleep 2
  done
  if ! docker logs "${REPLICA_PROJECT}-prefetch" 2>&1 | grep -q 'Downloads Complete'; then
    docker logs "${REPLICA_PROJECT}-prefetch" 2>&1 | tail -5 >&2
    docker rm -f "${REPLICA_PROJECT}-prefetch" >/dev/null
    die "worker prefetch failed"
  fi
  docker rm -f "${REPLICA_PROJECT}-prefetch" >/dev/null
  docker run --rm --network none -v "$cache:/cache" valkey/valkey:9 sh -c "echo '$image_id' > /cache/image-id"
}

load_valkey() {
  local src="$1" rdb tar
  rdb="$(snapshot_rdb "$src")"
  tar="$( [[ "$src" == none ]] || data_tar "$src")"
  down
  docker volume create "${REPLICA_PROJECT}_valkey-data" >/dev/null
  docker volume create "${REPLICA_PROJECT}_agentmemory-data" >/dev/null
  if [[ -n "$rdb" ]]; then
    log "copying snapshot into the Valkey volume"
    docker run --rm --network none -v "${REPLICA_PROJECT}_valkey-data:/data" -v "$(dirname "$rdb"):/src:ro" \
      valkey/valkey:9 sh -c 'cp "/src/$1" /data/dump.rdb && chown valkey:valkey /data/dump.rdb' sh "$(basename "$rdb")"
  fi
  if [[ -n "$tar" ]]; then
    log "restoring the agentmemory data volume"
    zstd -dc "$tar" | docker run --rm -i --network none -v "${REPLICA_PROJECT}_agentmemory-data:/data" \
      valkey/valkey:9 tar -x -C /data
  fi
  prefetch_workers
  docker run --rm --network none -v "${REPLICA_PROJECT}_worker-cache:/cache:ro" -v "${REPLICA_PROJECT}_agentmemory-data:/data" \
    valkey/valkey:9 sh -c 'mkdir -p /data/compose-state && cp -a /cache/compose-state/packages /data/compose-state/ &&
      rm -rf /data/worker-compose.runtime.lock && cp -a /cache/worker-compose.runtime.lock /data/'
  VALKEY_APPENDONLY=no "${COMPOSE[@]}" up -d --wait valkey >&2
  local deadline=$((SECONDS + READY_TIMEOUT_S))
  until [[ "$(vcli info persistence | tr -d '\r' | awk -F: '$1=="loading"{print $2}')" == "0" ]]; do
    ((SECONDS < deadline)) || die "valkey still loading after ${READY_TIMEOUT_S}s"
    sleep 1
  done
  vcli config set appendonly yes >/dev/null
  deadline=$((SECONDS + READY_TIMEOUT_S))
  while vcli info persistence | tr -d '\r' | grep -q '^aof_rewrite_in_progress:1'; do
    ((SECONDS < deadline)) || die "valkey AOF rewrite still running after ${READY_TIMEOUT_S}s"
    sleep 1
  done
  restart_valkey
  log "valkey loaded $(vcli dbsize | tr -d '\r') keys, AOF on"
}

# Restart Valkey so it loads from its AOF as production does after a restart,
# and so its memory.peak no longer includes the snapshot import and AOF rewrite.
restart_valkey() {
  "${COMPOSE[@]}" up -d --wait --force-recreate valkey >&2
}

REPO="$(cd "$HERE/../.." && pwd)"
BASE_URL="http://agentmemory:3111"

# The internal network is not reachable from the host, so every HTTP client runs
# in this container on the replica network, with the worktree mounted read-only.
client_up() {
  : "${AM_IMAGE:?set AM_IMAGE}"
  local name
  name="$(container client)"
  [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" == true ]] && return 0
  docker rm -f "$name" >/dev/null 2>&1 || true
  local private=()
  [[ -n "${REPLICA_PRIVATE_DIR:-}" ]] && private=(-v "$REPLICA_PRIVATE_DIR:/private:ro")
  docker run -d --name "$name" --network "${REPLICA_PROJECT}_replica" --memory 1g \
    -v "$REPO:/work:ro" "${private[@]}" -w /work --entrypoint sleep "$AM_IMAGE" infinity >/dev/null
}

client() {
  client_up
  docker exec -i "$(container client)" "$@"
}

# Ready means the REST worker answers and the keyword index rebuild has finished,
# so a search sees the whole store.
wait_ready() {
  : "${AM_IMAGE:?set AM_IMAGE}"
  local deadline state
  client_up
  deadline=$((SECONDS + READY_TIMEOUT_S))
  while ((SECONDS < deadline)); do
    state="$(docker inspect -f '{{.State.Status}} {{.State.OOMKilled}}' "$(container agentmemory)" 2>/dev/null || echo missing)"
    [[ "$state" == running* ]] || die "agentmemory stopped ($state)"
    if client node bench/fork/ready.mjs "$BASE_URL" "$SECRET" 2>/dev/null; then
      log "agentmemory ready"
      return 0
    fi
    sleep 1
  done
  die "agentmemory not ready after ${READY_TIMEOUT_S}s"
}

app() {
  : "${AM_IMAGE:?set AM_IMAGE}"
  "${COMPOSE[@]}" --profile app up -d --no-recreate agentmemory >&2
  wait_ready
}

counts() {
  docker exec "$(container valkey)" sh -c 'valkey-cli --scan --pattern "state:*" | while read -r k; do echo "$(valkey-cli hlen "$k") $k"; done' |
    sed -E 's/ state:/ /; s/^([0-9]+) mem:obs:.*/\1 mem:obs:<session>/; s/^([0-9]+) mem:index:bm25:vec:[0-9]+$/\1 mem:index:bm25:vec:<bucket>/;
            s/^([0-9]+) mem:idx:obs:[0-9]+$/\1 mem:idx:obs:<shard>/; s/^([0-9]+) mem:capture:events:.*/\1 mem:capture:events:<shard>/;
            s/^([0-9]+) mem:audit:[0-9]{4}-[0-9]{2}$/\1 mem:audit:<month>/; s/^([0-9]+) mem:emb:.*/\1 mem:emb:<obs>/' |
    awk '{c[$2]+=$1; k[$2]++} END {for (s in c) printf "%-34s %9d records %6d scopes\n", s, c[s], k[s]}' | sort
}

down() {
  docker rm -f "$(container client)" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" --profile app down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "${REPLICA_PROJECT}_valkey-data" "${REPLICA_PROJECT}_agentmemory-data" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up) [[ $# -ge 2 ]] || die "usage: replica.sh up <backup-dir|dump.rdb|none>"; : "${AM_IMAGE:?set AM_IMAGE}"; load_valkey "$2"; app; counts ;;
  prefetch) prefetch_workers ;;
  valkey) [[ $# -ge 2 ]] || die "usage: replica.sh valkey <backup-dir|dump.rdb|none>"; load_valkey "$2" ;;
  app) app ;;
  restart-valkey) restart_valkey ;;
  wait) wait_ready ;;
  counts) counts ;;
  client) shift; client "$@" ;;
  stop) down; log "removed (worker cache kept)" ;;
  down) down; docker volume rm "${REPLICA_PROJECT}_worker-cache" >/dev/null 2>&1 || true; log "removed" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
