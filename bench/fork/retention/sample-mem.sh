#!/usr/bin/env bash
# Samples the three replica containers' cgroup memory once a second: current, anonymous and file-cache bytes, into a TSV.
# memory.peak counts page cache (Qdrant's mmap and Kvrocks' RocksDB files fill their limits as cache that the kernel reclaims),
# so the anonymous figure is what an OOM kill answers to. Stop it by creating <out>.stop; `summary` prints the maxima in MiB.
#
#   bench/fork/retention/sample-mem.sh run <out.tsv>       sample until <out.tsv>.stop exists
#   bench/fork/retention/sample-mem.sh summary <out.tsv>   max current, max anon and max file per service, with the sample count
set -uo pipefail
P="${REPLICA_PROJECT:-tee1158s12}"
case "${1:-}" in
  run)
    out="$2"; rm -f "$out.stop"; : > "$out"
    while [[ ! -e "$out.stop" ]]; do
      t=$(date +%s)
      for svc in agentmemory kvrocks qdrant; do
        docker exec "$P-$svc-1" sh -c 'echo $(cat /sys/fs/cgroup/memory.current) $(awk "/^anon /{a=\$2} /^file /{f=\$2} END{print a, f}" /sys/fs/cgroup/memory.stat)' 2>/dev/null |
          awk -v t="$t" -v s="$svc" 'NF==3{print t "\t" s "\t" $1 "\t" $2 "\t" $3}' >> "$out"
      done
      sleep 1
    done
    ;;
  summary)
    awk -F'\t' '{n[$2]++; if($3>c[$2])c[$2]=$3; if($4>a[$2])a[$2]=$4; if($5>f[$2])f[$2]=$5}
      END{for(s in n) printf "{\"service\":\"%s\",\"samples\":%d,\"maxCurrentMiB\":%d,\"maxAnonMiB\":%d,\"maxFileMiB\":%d}\n", s, n[s], c[s]/1048576, a[s]/1048576, f[s]/1048576}' "$2" | sort
    ;;
  *) echo "usage: sample-mem.sh run <out.tsv> | summary <out.tsv>" >&2; exit 2 ;;
esac
