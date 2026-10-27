# Deploy agentmemory on Coolify

This directory deploys agentmemory as a Coolify *Application* built from a
Docker Compose stack. It runs agentmemory 0.9.31 under iii 0.25 Worker Compose,
keeps state in a Valkey sidecar, embeds with Voyage `voyage-code-4`, and
writes summaries through an Anthropic-format LLM endpoint.

In Coolify, set the base directory to `/` and the Compose path to
`/deploy/coolify/docker-compose.yml`. The stack builds upstream's shared
`deploy/Dockerfile` from the repository root.

This branch serves agentmemory-buddy. A `cloudflared` service in the stack dials out to Cloudflare, so Traefik is bypassed and the host publishes no port. `CF_TUNNEL_TOKEN`, `VIEWER_ALLOWED_HOSTS` and `VIEWER_ALLOWED_ORIGINS` are required; the viewer listens on `3113` behind a Cloudflare Access application. Auto-deploy is off for this application: deploy it from Coolify or `POST /api/v1/deploy?uuid=<app>&force=true` after a push. Viewer live updates now use SSE on the REST port (`/agentmemory/viewer/events`); port 3112 is unused.

## What runs

| Service | Purpose |
|---|---|
| `agentmemory` | REST API on `3111`, built from `deploy/Dockerfile`. `iii compose` runs the engine and supervises the `state`, `http` and `agentmemory` workers, restarting a worker that exits. Memory limit `AGENTMEMORY_MEM_LIMIT`. |
| `valkey` | State and stream store (`AGENTMEMORY_STATE_BACKEND=redis`). Append-only file on, `noeviction`, memory limit `VALKEY_MEM_LIMIT`. |

Volumes:

- `valkey-data` holds every memory, session, observation and index. Back up this one.
- `agentmemory-data` holds `/data/secret`, the generated `worker-compose.runtime.yaml`, the capture spool and the registry workers that compose downloads on first boot. On a stack that was migrated from the file backend it also holds the old `state_store.db`, which is no longer read. The 0.9.31 entrypoint copies a 0.9.30 `/data/.hmac` to `/data/secret` when `AGENTMEMORY_SECRET` is unset.

## Changes from upstream

- **Embedding model.** This branch carries a source fix that makes the Voyage provider read `VOYAGE_MODEL` (upstream sends `voyage-code-3` whatever the variable says). The compose file defaults it to `voyage-code-4`. Both models emit 1024 dimensions, and the dimension guard rejects a mismatch, so a wrong model fails closed.
- **Compose file.** Upstream's `deploy/coolify/docker-compose.yml` plus a Valkey service, memory limits, a 300 s health-check start period, and pinned values for the embedding provider, summary model, compression and state backend.

The 0.9.30 build patches (the bundle's `voyage-code-3` literal and the CLI's 15 s worker-ready wait), the stale-pidfile cleanup and the engine watchdog are gone. Compose allows each worker 300 s to start and restarts a worker that exits, and the engine is the container's main process, so an engine crash restarts the container.

## Configuration

Coolify passes every application variable into the container, and the compose file references the ones it needs at interpolation time. Set these in the Coolify dashboard:

| Variable | Value |
|---|---|
| `VOYAGE_API_KEY` | Voyage key. `EMBEDDING_PROVIDER` is pinned to `voyage` in the compose file, so adding an LLM key never switches the embedding backend. |
| `AGENTMEMORY_SECRET` | 64-hex bearer secret. When unset, the entrypoint uses `/data/secret`. Clients send `Authorization: Bearer <secret>`. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | Key and base URL of an Anthropic-format endpoint, for example a CLIProxy gateway. |
| `ANTHROPIC_MODEL` | Summary model. Defaults to `claude-haiku-5-5` in the compose file; without it agentmemory uses a Sonnet-class model. |

Behaviour settings in use:

| Variable | Setting | Reason |
|---|---|---|
| `AGENTMEMORY_AUTO_COMPRESS` | `false` | Compression costs one LLM call per tool use. Summaries and consolidation give recall at a fraction of the calls. |
| `CONSOLIDATION_ENABLED` | `true` | Distils session summaries into semantic facts and procedures. The semantic step waits for at least 5 session summaries. |
| `AGENTMEMORY_CONSOLIDATION_COOLDOWN_MS`, `CONSOLIDATION_INTERVAL_MS` | `21600000`, `86400000` | Session-end consolidation otherwise runs every 5 min, and repeated runs can write reworded duplicate facts (upstream #1486). |
| `MAX_OBS_PER_SESSION` | `2000` | Each capture lists the whole session before it checks this cap. At 5000, two sessions passed 4,000 observations and every capture from them timed out at 180 s. Captures past the cap are dead-lettered; end an agent session that reaches it rather than raising it. |
| `AGENTMEMORY_FINALIZE_IDLE_MS` | `900000` | A session is finalized and summarized after 15 idle minutes instead of 2, so fewer summary passes (about 14 s each) run. |
| `AUTO_FORGET_INTERVAL_MS` | `86400000` | Auto-forget lists every observation in the store. Hourly runs deleted nothing on a store under 180 days old. |
| `AGENTMEMORY_AUDIT_RETENTION_MONTHS` | `1` | The default `0` keeps the audit log forever. A daily sweep drops calendar months older than the previous one. |
| `AGENTMEMORY_VECTOR_BACKFILL`, `AGENTMEMORY_VECTOR_BACKFILL_MAX` | `all`, `30000` | Embeds documents that lack a vector on each boot. The cap applies per boot, and the default 500 needed dozens of restarts for buddy's 28k gap. |
| `AGENTMEMORY_MEM_LIMIT` | main `3200m`, buddy `2g` | The worker keeps every vector in memory (about 4 KB per document) and Node caps its heap at about 60 % of the container limit: 830 MB at 1536m, 1.54 GB at 2560m, 1.88 GB at 3200m. Main ran 2.0-2.1 GB RSS at 91k documents. |
| `VALKEY_MAXMEMORY`, `VALKEY_MEM_LIMIT` | main `5gb`, `6g`; buddy `3gb`, `3584m` | On 2026-10-27 main used 1.02 GB and grew about 50 MB a day; buddy used 0.76 GB and grew about 25 MB a day. Main reaches 5 GB around mid-January 2027. Raise both values together before then. |
| `LESSON_DECAY_ENABLED` | `false` | Decay lowers an unreinforced lesson by 0.05 a week and soft-deletes it at 0.1, so unused lessons disappear in about three months (upstream #1065). |

## Old and stale memories

- Auto-forget runs daily (`AUTO_FORGET_INTERVAL_MS`) and stays on. It deletes memories past their `forgetAfter`, deletes observations older than 180 days with importance ≤ 2, and hides the older of two memories that share a concept and are more than 90 % similar. `POST /agentmemory/auto-forget` with `{"dryRun":true}` shows what it would do.
- Nothing ages regular memories: search has no recency term and does not read `strength`. Retire an outdated fact when you save its replacement. A new memory more than 70 % similar to an existing one in the same project supersedes it. For a fact that expires, use `POST /agentmemory/remember` with `ttlDays`; the MCP `memory_save` tool has no TTL field.
- `mem::evict` and `mem::retention-evict` delete permanently and have no timer. Do not run them until upstream #1005 and #1157 are fixed: eviction leaves stale counters and search entries behind. If you must, export first and use `dryRun`.

## Deploy, restart and verify

- **Deploy** rebuilds the image: `POST /api/v1/deploy?uuid=<app>&force=true`. Use it for any change to the `Dockerfile` or entrypoint.
- **Restart** reuses the existing image: `POST /api/v1/applications/<app>/restart`. Use it for variable changes only.
- Coolify's edge rejects the default curl user agent (error 1010); send a browser `User-Agent`.
- Coolify runs compose with `--project-directory` at the repository root, so the build context in `docker-compose.yml` is `.`, not `../..`.

```bash
curl "https://<host>/agentmemory/livez"
curl -H "Authorization: Bearer $AGENTMEMORY_SECRET" -H "Accept: application/json" \
  "https://<host>/agentmemory/status"
```

`/agentmemory/status` reports the providers (`voyage (1024 dims)`, `llm`), index counts, vector coverage and any problems.

## Upgrading from 0.9.30

1. Back up `valkey-data` (see Backups). The vector index format is unchanged from 0.9.30, but 0.9.31 writes new records (compression recovery, summary watermarks, graph index controls), so the backup is the way back to 0.9.30.
2. Check Valkey's size: `docker exec <valkey-container> valkey-cli info memory | grep -E 'used_memory_human|maxmemory_human'`. With `noeviction`, writes fail once `used_memory` reaches `maxmemory`. The compose defaults are now `VALKEY_MAXMEMORY=2gb` and `VALKEY_MEM_LIMIT=3g`; an app variable overrides them, so remove or raise any old 1gb/1536m values.
3. Switch the application's branch, base directory and Compose path, then deploy (a restart reuses the old image).
4. Watch `/agentmemory/status`: `indexPersistence` should report buckets, and `index.vectorDocuments` should match the count before the upgrade.
5. Optional: graph indexes for existing graph data are built only on request, with `agentmemory graph-index migrate --allow-legacy-scan --json` run in the container. Discovery reads every legacy graph scope at once, so run it at a quiet time. Keyword and vector search work without it.

## Known limits, left to upstream

These need code changes in agentmemory. The deployment tracks upstream releases rather than patching them.

- `mem::observe` lists every observation in the session for each capture, before it checks `MAX_OBS_PER_SESSION`. Cost grows with session length, and a refused capture costs as much as a stored one.
- Each session stop lists the whole session and runs the heuristic graph pass even with `GRAPH_EXTRACTION_ENABLED=false`, and writes an audit row naming every observation ID (up to about 120 KB).
- The Voyage provider embeds search queries with `input_type: "document"`; Voyage recommends `"query"` for queries.
- Short prompt observations (for example "yes proceed to push") often rank first in semantic search, above relevant lessons and memories.
- `RERANK_ENABLED=true` needs `@huggingface/transformers`, an optional dependency that `deploy/Dockerfile` prunes.

## Moving data between backends

agentmemory does not copy data when `AGENTMEMORY_STATE_BACKEND` changes; the new backend starts empty. `migrate-state.sh` copies a store through the REST API:

```bash
SRC_SECRET=... DST_SECRET=... ./migrate-state.sh <src-url> <dst-url> SRC_SECRET DST_SECRET [workdir]
```

It exports in session chunks (the engine caps a response at about 15 MiB), imports each with `strategy: merge`, and copies sessions too large to export through `/agentmemory/observations`. Merge never deletes, so a partial run can be repeated. The import endpoint returns HTTP 200 with `success: false` on a rejected payload; the script checks `success`.

To migrate a file-backed stack: back up the volume, deploy the Valkey stack, copy the old `state_store.db` out of `agentmemory-data`, serve it from a temporary file-backed container (give it the same `EMBEDDING_PROVIDER` and Voyage key), and run the script against the live stack. Imports re-embed every document, so expect Voyage usage proportional to the store.

## Resources

Measured on the buddy store (28,037 documents, 508 memories): the file backend held 2.65 GB, almost all of it in the engine process. On Valkey the same data used 0.34 GB engine, 0.39 GB worker and 0.28 GB Valkey.

On 2026-10-27, after the 0.9.31 upgrade: main held 91k documents (86k observations, 4.7k memories) at 2.0-2.1 GB container RSS and 1.02 GB Valkey, capturing about 5,000 observations a day; buddy held 47k documents at 1.2 GB RSS and 0.76 GB Valkey.

## Backups

Back up the `valkey-data` volume, for example:

```bash
docker run --rm -v <app-uuid>_valkey-data:/data:ro -v "$PWD":/b alpine \
  tar czf /b/valkey-data-$(date -u +%Y%m%dT%H%M).tgz -C /data .
```

An export (`GET /agentmemory/export`, chunked with `?maxSessions=&offset=`) is a portable alternative that `migrate-state.sh` can restore.
