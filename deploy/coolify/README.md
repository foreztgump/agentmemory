# Deploy agentmemory on Coolify

This directory deploys agentmemory as a Coolify *Application* built from a
Docker Compose stack. It runs agentmemory 0.9.30 with iii engine 0.22.1,
keeps state in a Valkey sidecar, embeds with Voyage `voyage-code-4`, and
writes summaries through an Anthropic-format LLM endpoint.

This branch (`coolify-deploy`) serves agentmemory-buddy. A `cloudflared` service in the stack dials out to Cloudflare, so Traefik is bypassed and the host publishes no port. `CF_TUNNEL_TOKEN`, `VIEWER_ALLOWED_HOSTS` and `VIEWER_ALLOWED_ORIGINS` are required; the viewer listens on `3113` behind a Cloudflare Access application.

## What runs

| Service | Purpose |
|---|---|
| `agentmemory` | REST API on `3111`, built from `Dockerfile`. Memory limit `AGENTMEMORY_MEM_LIMIT` (default set in the compose file). |
| `valkey` | State and stream store (`AGENTMEMORY_STATE_BACKEND=redis`). Append-only file on, `noeviction`, memory limit `VALKEY_MEM_LIMIT`. |

Volumes:

- `valkey-data` holds every memory, session, observation and index. Back up this one.
- `agentmemory-data` holds `/data/.hmac` and the generated engine config. On a stack that was migrated from the file backend it also holds the old `state_store.db`, which is no longer read.

## Build-time patches

The `Dockerfile` installs `@agentmemory/agentmemory` from npm and patches the bundle in two places. Each patch has a grep gate, so an upstream change fails the build instead of silently dropping the fix.

- **Embedding model.** The Voyage provider hardcodes the legacy `voyage-code-3` and has no override. The build rewrites it to `VOYAGE_EMBEDDING_MODEL` (default `voyage-code-4`, the current Voyage model for code retrieval). Both models emit 1024 dimensions, and `withDimensionGuard()` rejects a mismatch, so a wrong model fails closed.
- **Worker startup wait.** The CLI waits a hardcoded 15 s for the worker to report ready, then stops the engine and exits. On a slow VM, restoring the search index for a few thousand memories takes longer, and the container restart-loops. The build raises the wait to 180 s.

The entrypoint also writes the engine config. Keep `allowed_origins` as an inline list: the 0.9.30 CLI rewrites that one line, and a block list under it no longer parses.

## Configuration

Coolify passes every application variable into the container, and the compose file references the ones it needs at interpolation time. Set these in the Coolify dashboard:

| Variable | Value |
|---|---|
| `VOYAGE_API_KEY` | Voyage key. `EMBEDDING_PROVIDER` is pinned to `voyage` in the compose file, so adding an LLM key never switches the embedding backend. |
| `AGENTMEMORY_SECRET` | 64-hex bearer secret. The entrypoint writes it to `/data/.hmac`. Clients send `Authorization: Bearer <secret>`. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | Key and base URL of an Anthropic-format endpoint, for example a CLIProxy gateway. |
| `ANTHROPIC_MODEL` | Summary model. Defaults to `claude-haiku-5-5` in the compose file; without it agentmemory uses a Sonnet-class model. |

Behaviour settings in use:

| Variable | Setting | Reason |
|---|---|---|
| `AGENTMEMORY_AUTO_COMPRESS` | `false` | Compression costs one LLM call per tool use. Summaries and consolidation give recall at a fraction of the calls. |
| `CONSOLIDATION_ENABLED` | `true` | Distils session summaries into semantic facts and procedures. The semantic step waits for at least 5 session summaries. |
| `AGENTMEMORY_CONSOLIDATION_COOLDOWN_MS`, `CONSOLIDATION_INTERVAL_MS` | `21600000`, `86400000` on high-traffic stacks | Session-end consolidation otherwise runs every 5 min, and repeated runs can write reworded duplicate facts (upstream #1486). |
| `LESSON_DECAY_ENABLED` | `false` | Decay lowers an unreinforced lesson by 0.05 a week and soft-deletes it at 0.1, so unused lessons disappear in about three months (upstream #1065). |

## Old and stale memories

- Auto-forget runs hourly and stays on. It deletes memories past their `forgetAfter`, deletes observations older than 180 days with importance ≤ 2, and hides the older of two memories that share a concept and are more than 90 % similar. `POST /agentmemory/auto-forget` with `{"dryRun":true}` shows what it would do.
- Nothing ages regular memories: search has no recency term and does not read `strength`. Retire an outdated fact when you save its replacement. A new memory more than 70 % similar to an existing one in the same project supersedes it. For a fact that expires, use `POST /agentmemory/remember` with `ttlDays`; the MCP `memory_save` tool has no TTL field.
- `mem::evict` and `mem::retention-evict` delete permanently and have no timer. Do not run them until upstream #1005 and #1157 are fixed: eviction leaves stale counters and search entries behind. If you must, export first and use `dryRun`.

## Deploy, restart and verify

- **Deploy** rebuilds the image: `POST /api/v1/deploy?uuid=<app>&force=true`. Use it for any change to the `Dockerfile` or entrypoint.
- **Restart** reuses the existing image: `POST /api/v1/applications/<app>/restart`. Use it for variable changes only.
- Coolify's edge rejects the default curl user agent (error 1010); send a browser `User-Agent`.

```bash
curl "https://<host>/agentmemory/livez"
curl -H "Authorization: Bearer $AGENTMEMORY_SECRET" -H "Accept: application/json" \
  "https://<host>/agentmemory/status"
```

`/agentmemory/status` reports the providers (`voyage (1024 dims)`, `llm`), index counts, vector coverage and any problems.

## Engine watchdog

The CLI starts the iii engine as a detached child and does not supervise it. If the engine dies, the container keeps running while `:3111` refuses connections. The entrypoint's watchdog waits for the first successful `livez` probe, then probes every `AGENTMEMORY_WATCHDOG_INTERVAL` seconds (default 30). After `AGENTMEMORY_WATCHDOG_FAILURES` consecutive failures (default 3) it stops agentmemory, and `restart: unless-stopped` brings the container back. Its log lines start with `agentmemory-watchdog:`.

## Moving data between backends

agentmemory does not copy data when `AGENTMEMORY_STATE_BACKEND` changes; the new backend starts empty. `migrate-state.sh` copies a store through the REST API:

```bash
SRC_SECRET=... DST_SECRET=... ./migrate-state.sh <src-url> <dst-url> SRC_SECRET DST_SECRET [workdir]
```

It exports in session chunks (the engine caps a response at about 15 MiB), imports each with `strategy: merge`, and copies sessions too large to export through `/agentmemory/observations`. Merge never deletes, so a partial run can be repeated. The import endpoint returns HTTP 200 with `success: false` on a rejected payload; the script checks `success`.

To migrate a file-backed stack: back up the volume, deploy the Valkey stack, copy the old `state_store.db` out of `agentmemory-data`, serve it from a temporary file-backed container (give it the same `EMBEDDING_PROVIDER` and Voyage key), and run the script against the live stack. Imports re-embed every document, so expect Voyage usage proportional to the store.

## Resources

Measured on the buddy store (28,037 documents, 508 memories): the file backend held 2.65 GB, almost all of it in the engine process. On Valkey the same data used 0.34 GB engine, 0.39 GB worker and 0.28 GB Valkey. A store of 4,061 memories runs at about 0.5 GB plus 50 MB Valkey.

## Backups

Back up the `valkey-data` volume, for example:

```bash
docker run --rm -v <app-uuid>_valkey-data:/data:ro -v "$PWD":/b alpine \
  tar czf /b/valkey-data-$(date -u +%Y%m%dT%H%M).tgz -C /data .
```

An export (`GET /agentmemory/export`, chunked with `?maxSessions=&offset=`) is a portable alternative that `migrate-state.sh` can restore.
