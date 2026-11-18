#!/usr/bin/env bash
# Runs the pinned Qdrant release for the TEE-1161 spikes under hard limits.
#   spike.sh up <mem, e.g. 1g> [riops]  start (or restart) Qdrant with that memory limit (swap off) and read-IOPS cap
#   spike.sh mem                        cgroup memory.current/peak, anon/file, Qdrant RSS, io.stat
#   spike.sh evict                      drop the storage files from the page cache (for a cold start)
#   spike.sh fio                        4 KB random reads with direct I/O inside the container, QD1 and QD32
#   spike.sh down                       remove the container (the data directory stays)
#   spike.sh purge                      remove the container and the data directory
# DATA defaults to /home/cownose/am-staging/qdrant-spike/storage. The read-IOPS cap
# defaults to NR1's measured QD32 4 KB random-read rate (66,591 IOPS).
set -euo pipefail
IMAGE=qdrant/qdrant:v1.20.2
NAME=${QDRANT_CONTAINER:-tee1161-qdrant}
PORT=${QDRANT_PORT:-16333}
DATA=${DATA:-/home/cownose/am-staging/qdrant-spike/storage}
DEVICE=${DEVICE:-/dev/nvme0n1}
NR1_RIOPS=66591

in_cgroup() { docker exec "$NAME" sh -c "$1"; }

case "${1:-}" in
  up)
    mem=${2:?usage: spike.sh up <mem> [riops]}
    riops=${3:-$NR1_RIOPS}
    mkdir -p "$DATA"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" \
      -m "$mem" --memory-swap "$mem" --device-read-iops "$DEVICE:$riops" \
      -p "127.0.0.1:$PORT:6333" -v "$DATA:/qdrant/storage" \
      -e QDRANT__TELEMETRY_DISABLED=true -e QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots \
      "$IMAGE" >/dev/null
    until curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null; do
      [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" == true ]] || { docker logs --tail 20 "$NAME" >&2; exit 1; }
      sleep 0.5
    done
    echo "qdrant up: mem=$mem riops=$riops io.max=$(in_cgroup 'cat /sys/fs/cgroup/io.max')"
    ;;
  mem)
    in_cgroup 'cd /sys/fs/cgroup; echo "max=$(cat memory.max) current=$(cat memory.current) peak=$(cat memory.peak)";
      grep -E "^(anon|file|file_mapped|shmem|active_file|inactive_file) " memory.stat | tr "\n" " "; echo;
      grep -E "^(oom|oom_kill) " memory.events | tr "\n" " "; echo;
      for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = qdrant ] && echo "qdrant $(grep -E "^(VmRSS|RssAnon|RssFile)" $p/status | tr -s " \t\n" " ")"; done; cat io.stat'
    ;;
  evict)
    find "$DATA" -type f -exec dd if={} iflag=nocache count=0 status=none \;
    echo "evicted $(find "$DATA" -type f | wc -l) files"
    ;;
  fio)
    docker exec -u 0 "$NAME" sh -c 'command -v fio >/dev/null || (apt-get update -qq && apt-get install -y -qq fio >/dev/null)'
    for qd in 1 32; do
      docker exec -u 0 "$NAME" fio --name=nr1 --filename=/qdrant/storage/fio.test --size=1G --rw=randread --bs=4k \
        --direct=1 --ioengine=libaio --iodepth="$qd" --runtime=15 --time_based --group_reporting \
        --output-format=json |
        python3 -c 'import json,sys; r=json.load(sys.stdin)["jobs"][0]["read"]; print("QD'"$qd"': %d IOPS, clat p99 %d us" % (r["iops"], r["clat_ns"]["percentile"]["99.000000"]/1000))'
    done
    docker exec -u 0 "$NAME" rm -f /qdrant/storage/fio.test
    ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 || true ;;
  purge)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    if [[ -e "$DATA" && ! -d "$DATA/collections" ]]; then echo "refusing to delete $DATA: not a Qdrant storage directory" >&2; exit 1; fi
    echo "deleting $DATA"
    rm -rf "$DATA"
    ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
