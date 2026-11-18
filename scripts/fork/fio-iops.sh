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
dir="$(cd "$dir" && pwd)"
name="fio-iops-$$"
trap 'rm -f "$dir/$name.0.0"' EXIT

args=(--name="$name" --rw=randread --bs=4k --direct=1 --ioengine=libaio --iodepth="$iodepth"
  --numjobs=1 --size="$size" --runtime="$runtime" --time_based --group_reporting
  --output-format=json)

if command -v fio >/dev/null 2>&1; then
  json="$(fio "${args[@]}" --directory="$dir")"
else
  json="$(docker run --rm -v "$dir:/fio" alpine:3.22 sh -c \
    "apk add --no-cache -q fio >/dev/null && fio $(printf '%q ' "${args[@]}") --directory=/fio; rc=\$?; rm -f /fio/$name.0.0; exit \$rc")"
fi

printf '%s' "$json" | jq -r --arg dir "$dir" --arg size "$size" --arg rt "$runtime" --arg qd "$iodepth" '
  .jobs[0].read as $r
  | "dir=\($dir) size=\($size) runtime_s=\($rt) bs=4k iodepth=\($qd) direct=1 iops=\($r.iops | floor) p99_latency_us=\(($r.clat_ns.percentile["99.000000"] // 0) / 1000 | floor) mean_latency_us=\(($r.clat_ns.mean // 0) / 1000 | floor)"'
