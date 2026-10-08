#!/bin/sh
# agentmemory first-boot entrypoint.
#
# Runs as root so it can:
#   1. Overwrite the npm-bundled iii-config.yaml (which binds 127.0.0.1
#      and uses relative ./data paths) with a deploy-tuned version that
#      binds 0.0.0.0 and uses absolute /data paths.
#   2. chown the platform-mounted /data volume to the runtime user
#      (managed platforms mount volumes root-owned 755 by default).
#   3. Generate the HMAC secret on first boot and persist it to
#      /data/.hmac (chmod 600) so the secret survives restarts.
#
# Then it execs the agentmemory CLI under gosu as the unprivileged
# `node` user.

set -eu

DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"
export AGENTMEMORY_DATA_DIR="$DATA_DIR"
HMAC_FILE="${AGENTMEMORY_HMAC_FILE:-/data/.hmac}"
RUN_AS="node:node"
III_CONFIG="/opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml"

if [ -z "${MALLOC_ARENA_MAX:-}" ]; then
  export MALLOC_ARENA_MAX=2
fi
cur_nofile="$(ulimit -n)"
if [ "$cur_nofile" != unlimited ] && [ "$cur_nofile" -lt 10240 ]; then
  ulimit -n 10240 2>/dev/null || ulimit -n "$(ulimit -H -n)" 2>/dev/null || true
fi

mkdir -p "$DATA_DIR"
chown -R "$RUN_AS" "$DATA_DIR"

cat > "$III_CONFIG" <<'EOF'
workers:
  - name: iii-http
    config:
      port: 3111
      host: 0.0.0.0
      default_timeout: 180000
      cors:
        allowed_origins: ["http://localhost:3111", "http://localhost:3113", "http://127.0.0.1:3111", "http://127.0.0.1:3113"]
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          save_interval_ms: 2000
          file_path: /data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3112
      host: 0.0.0.0
      adapter:
        name: kv
        config:
          store_method: file_based
          save_interval_ms: 2000
          file_path: /data/stream_store
  - name: iii-observability
    config:
      enabled: true
      service_name: agentmemory
      exporter: memory
      sampling_ratio: 0.1
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: false
EOF
chown "$RUN_AS" "$III_CONFIG"

# An operator-supplied secret wins over the stored one.
#
# The generate-and-print-once flow assumes the operator can read this
# container's stdout, which is not true on every platform: Coolify's log API
# exposes only one container of a compose stack, so a generated secret can
# become unrecoverable without SSH to the host. Seeding from the environment
# keeps the deployment reproducible and makes rotation a variable change plus
# a restart, rather than a shell on the volume.
#
# The value is still persisted to the volume so the running app keeps a single
# source of truth, and it is never echoed back to the log.
if [ -n "${AGENTMEMORY_SECRET:-}" ]; then
  umask 077
  printf '%s\n' "$AGENTMEMORY_SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"
  chown "$RUN_AS" "$HMAC_FILE"
  echo "agentmemory: using operator-supplied HMAC secret from the environment"
elif [ ! -s "$HMAC_FILE" ]; then
  SECRET="$(openssl rand -hex 32)"
  umask 077
  printf '%s\n' "$SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"
  chown "$RUN_AS" "$HMAC_FILE"
  echo "================================================================"
  echo "agentmemory: generated HMAC secret on first boot"
  echo "AGENTMEMORY_SECRET=$SECRET"
  echo "Copy this value now. It will not be printed again."
  echo "Stored at: $HMAC_FILE (chmod 600)"
  echo "To rotate: set AGENTMEMORY_SECRET in the environment and restart,"
  echo "or delete $HMAC_FILE on the persistent volume and restart."
  echo "================================================================"
fi

AGENTMEMORY_SECRET="$(cat "$HMAC_FILE")"
export AGENTMEMORY_SECRET

# The CLI spawns iii-engine as a detached child and never supervises it. If the
# engine dies after boot, the CLI stays up, so the container sits at
# "unhealthy" with :3111 refusing connections — and Docker never restarts an
# unhealthy container on its own. This watchdog turns a dead engine into a
# container exit so `restart: unless-stopped` recovers it.
#
# It arms only after the first successful probe, so a slow first boot (index
# rebuild) is left to the healthcheck's start_period. It targets $$, which the
# exec below turns into the agentmemory process; tini then exits with it.
# Set AGENTMEMORY_WATCHDOG_INTERVAL=0 to disable.
WATCHDOG_INTERVAL="${AGENTMEMORY_WATCHDOG_INTERVAL:-30}"
WATCHDOG_FAILURES="${AGENTMEMORY_WATCHDOG_FAILURES:-3}"
WATCHDOG_URL="http://127.0.0.1:3111/agentmemory/livez"

if [ "$WATCHDOG_INTERVAL" -gt 0 ]; then
  (
    main_pid=$$
    until curl -fsS --max-time 10 -o /dev/null "$WATCHDOG_URL" 2>/dev/null; do
      sleep 5
    done
    echo "agentmemory-watchdog: engine healthy, watching $WATCHDOG_URL every ${WATCHDOG_INTERVAL}s"
    failures=0
    while sleep "$WATCHDOG_INTERVAL"; do
      if curl -fsS --max-time 10 -o /dev/null "$WATCHDOG_URL" 2>/dev/null; then
        failures=0
        continue
      fi
      failures=$((failures + 1))
      echo "agentmemory-watchdog: livez probe failed ($failures/$WATCHDOG_FAILURES)"
      if [ "$failures" -ge "$WATCHDOG_FAILURES" ]; then
        echo "agentmemory-watchdog: engine unresponsive, stopping container for restart"
        kill -TERM "$main_pid" 2>/dev/null || true
        sleep 20
        kill -KILL "$main_pid" 2>/dev/null || true
        exit 0
      fi
    done
  ) &
fi

exec gosu "$RUN_AS" agentmemory "$@"
