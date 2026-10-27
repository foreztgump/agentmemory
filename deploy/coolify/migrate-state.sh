#!/usr/bin/env bash
# usage: migrate-state.sh SRC_URL DST_URL SRC_SECRET_ENV DST_SECRET_ENV [WORKDIR]
# Copies an agentmemory store via chunked /export -> /import (strategy merge).
# Secrets are read from the named environment variables, never from argv.
set -euo pipefail
SRC=$1 DST=$2 SRC_SECRET=${!3} DST_SECRET=${!4} WORK=${5:-$(mktemp -d)}
AUTH="Authorization: Bearer $SRC_SECRET"
DST_AUTH="Authorization: Bearer $DST_SECRET"
SESSION_KEYS='["version","exportedAt","sessions","observations","summaries","pagination"]'
mkdir -p "$WORK"

import_file() {
  jq -c '{exportData: ., strategy: "merge"}' "$1" > "$WORK/body.json"
  local code
  code=$(curl -sS -m 900 -o "$WORK/import.out" -w '%{http_code}' -X POST -H "$DST_AUTH" \
    -H 'Content-Type: application/json' --data-binary @"$WORK/body.json" "$DST/agentmemory/import")
  [ "$code" = 200 ] && [ "$(jq -r '.success' "$WORK/import.out")" = true ] \
    || { echo "import failed http=$code: $(head -c 400 "$WORK/import.out")" >&2; exit 1; }
}

off=0 max=1 first=1 total=0
while :; do
  code=$(curl -sS -m 900 -o "$WORK/chunk.json" -w '%{http_code}' -H "$AUTH" \
    "$SRC/agentmemory/export?maxSessions=$max&offset=$off")
  if [ "$code" = 413 ]; then
    if [ "$max" -gt 1 ]; then max=$(( max / 2 )); continue; fi
    echo "offset=$off: one session exceeds the export frame limit, copied in the reconcile pass"
    off=$(( off + 1 )); max=20; continue
  fi
  [ "$code" = 200 ] || { echo "export failed http=$code: $(head -c 400 "$WORK/chunk.json")" >&2; exit 1; }
  got=$(jq '.sessions | length' "$WORK/chunk.json")
  if [ "$first" = 1 ]; then
    cp "$WORK/chunk.json" "$WORK/full-first-chunk.json"
    first=0
  else
    jq --argjson keep "$SESSION_KEYS" 'with_entries(select(.key as $k | $keep | index($k))) + {memories: []}' \
      "$WORK/chunk.json" > "$WORK/slim.json" && mv "$WORK/slim.json" "$WORK/chunk.json"
  fi
  if [ "$got" -gt 0 ] || [ "$total" = 0 ]; then import_file "$WORK/chunk.json"; fi
  total=$(( total + got ))
  echo "offset=$off sessions=$got total=$total max=$max"
  [ "$(jq -r '.pagination.hasMore // (.sessions | length > 0)' "$WORK/chunk.json")" = true ] || break
  [ "$got" -gt 0 ] || break
  off=$(( off + got )); max=20
done
echo "chunked export copied $total sessions"

# Sessions too large to export alongside the shared collections are rebuilt
# from the per-session observation list, which carries the same fields.
curl -sS -m 300 -H "$AUTH" "$SRC/agentmemory/sessions" > "$WORK/src-sessions.json"
curl -sS -m 300 -H "$DST_AUTH" "$DST/agentmemory/sessions" > "$WORK/dst-sessions.json"
jq -r --slurpfile d "$WORK/dst-sessions.json" '($d[0].sessions | map(.id)) as $have | .sessions[] | select(.id as $i | $have | index($i) | not) | .id' \
  "$WORK/src-sessions.json" > "$WORK/missing.txt"
echo "reconcile: $(wc -l < "$WORK/missing.txt") sessions missing at destination"
while read -r sid; do
  curl -sS -m 300 -G -H "$AUTH" --data-urlencode "sessionId=$sid" "$SRC/agentmemory/observations" > "$WORK/obs.json"
  jq -n --arg sid "$sid" --slurpfile s "$WORK/src-sessions.json" --slurpfile o "$WORK/obs.json" '{
      version: "0.9.30", exportedAt: (now | todate),
      sessions: [$s[0].sessions[] | select(.id == $sid)],
      observations: {($sid): $o[0].observations}, summaries: [], memories: []}' > "$WORK/one.json"
  import_file "$WORK/one.json"
  echo "reconciled $sid ($(jq '.observations | length' "$WORK/obs.json") observations)"
done < "$WORK/missing.txt"
curl -sS -m 300 -H "$DST_AUTH" "$DST/agentmemory/sessions" | jq -r '"destination now has \(.sessions | length) sessions"'
