#!/usr/bin/env bash
# 4 KiB random-read IOPS of the volume that holds DIR.
# Usage: scripts/fork/fio-iops.sh DIR [RUNTIME_SECONDS] [SIZE] [IODEPTH]
# Lays out a test file (default 2G) in DIR, reads it with direct I/O for
# RUNTIME_SECONDS (default 60), prints one line, and removes the file.
# Uses fio from PATH, else runs fio in an alpine container with DIR mounted.
set -euo pipefail

dir="${1:?usage: fio-iops.sh DIR [RUNTIME_SECONDS] [SIZE] [IODEPTH]}"
runtime="${2:-60}"
size="${3:-2G}"
iodepth="${4:-32}"
[ -d "$dir" ] || { echo "not a directory: $dir" >&2; exit 2; }
[[ "$runtime$size$iodepth" =~ ^[0-9A-Za-z]+$ ]] || { echo "runtime, size and iodepth must be plain values" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
dir="$(cd "$dir" && pwd)"
file="fio-iops-$$.dat"
trap 'rm -f "$dir/$file"' EXIT

args=(--name=randread4k --rw=randread --bs=4k --direct=1 --ioengine=libaio --iodepth="$iodepth"
  --numjobs=1 --size="$size" --runtime="$runtime" --time_based --group_reporting
  --output-format=json)

if command -v fio >/dev/null 2>&1; then
  json="$(fio "${args[@]}" --filename="$dir/$file")"
elif command -v docker >/dev/null 2>&1; then
  json="$(docker run --rm -v "$dir:/fio" alpine:3.22 sh -c \
    "apk add --no-cache -q fio >/dev/null && fio ${args[*]} --filename=/fio/$file; rc=\$?; rm -f /fio/$file; exit \$rc")"
else
  echo "needs fio or docker" >&2
  exit 2
fi

printf '%s' "$json" | jq -r --arg dir "$dir" --arg size "$size" --arg rt "$runtime" --arg qd "$iodepth" '
  .jobs[0].read as $r
  | "dir=\($dir) size=\($size) runtime_s=\($rt) bs=4k iodepth=\($qd) direct=1 iops=\($r.iops | floor) p99_latency_us=\(($r.clat_ns.percentile["99.000000"] // null) | if . == null then "missing" else (. / 1000 | floor) end) mean_latency_us=\(($r.clat_ns.mean // null) | if . == null then "missing" else (. / 1000 | floor) end)"'
