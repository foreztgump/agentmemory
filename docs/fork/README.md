# agentmemory disk fork

This is `foreztgump/agentmemory`, a fork of `rohitg00/agentmemory`. It keeps records, the knowledge graph, the keyword index and vectors on disk instead of in RAM, so the self-hosted stacks stop running out of memory. Every upstream feature stays.

The fork opens no pull requests against upstream. It follows upstream by rebasing.

## Branches

| Branch | Purpose |
|---|---|
| `disk` | The fork's mainline. It starts from an upstream release tag and carries the fork's commits on top. CI runs the upstream test suite on every push and pull request to it. |
| one deploy branch per stack | Coolify builds from these. They are updated from a fork release tag, never edited by hand. |

## Release tags

A fork release is a git tag `vX.Y.Z-am.N` on `disk`:

- `X.Y.Z` is the upstream release tag that `disk` is based on.
- `N` is the fork's release counter for that base. It starts at 1 and resets to 1 after each rebase onto a new upstream tag.

Example: the first fork release on upstream `v0.9.33` is `v0.9.33-am.1`, the next is `v0.9.33-am.2`, and the first release after rebasing onto `v0.9.34` is `v0.9.34-am.1`.

The fork never changes the version in `package.json`. The running server reports upstream's version, and the tag says which fork release it is.

The npm and Docker Hub publish workflows only run in `rohitg00/agentmemory`, so a release on the fork publishes nothing.

## Required settings

Upstream sends nothing to an LLM unless `AGENTMEMORY_LLM_PROVIDER` names a provider and that provider's key is set. A provider key alone is not enough. Without it, session summaries, consolidation and LLM compression do nothing, and the log says the server runs zero-LLM.

The stacks use an Anthropic-compatible endpoint for the LLM and Voyage for embeddings:

| Setting | Value |
|---|---|
| `AGENTMEMORY_LLM_PROVIDER` | `anthropic` |
| `ANTHROPIC_API_KEY` | the endpoint's key |
| `ANTHROPIC_BASE_URL` | the endpoint's URL |
| `ANTHROPIC_MODEL` | the model to use, for example `claude-haiku-5-5` |
| `EMBEDDING_PROVIDER` | `voyage` |
| `VOYAGE_API_KEY` | the Voyage key |
| `VOYAGE_MODEL` | `voyage-code-4` |
| `VOYAGE_OUTPUT_DIMENSION` | `1024` |

`VOYAGE_MODEL` defaults to upstream's `voyage-code-3`. `VOYAGE_OUTPUT_DIMENSION` accepts 256, 512, 1024 or 2048. When it is set, the server sends it to Voyage as `output_dimension` and expects vectors of that size. When it is unset, the server sends no dimension and expects 1024. Any other value stops the server at startup.

Changing the model or the dimension does not re-embed stored vectors. Vectors from different models are not comparable, even at the same size.

### Hybrid search with embeddings

The fork changes two things in hybrid search (TEE-1204). Upstream still has both problems.

- **Query embeddings.** Voyage and Cohere embed a search query with their query input type (`query`, `search_query`) and stored content with their document type. Stored vectors are unchanged, so nothing is re-embedded.
- **Default fusion weights.** The defaults are `BM25_WEIGHT=0.6` and `VECTOR_WEIGHT=0.4`. Upstream uses 0.4 and 0.6. At upstream's weights, any vector-only hit in the top 30 ranks above the keyword rank-1 hit. On buddy's eval, recall@10 was then 0.10, against 0.86 for keyword search alone. Set both variables to override the defaults.

`test/fork-deploy-config.test.ts` checks these settings. It fails if a rebase changes how they select the LLM or the embedding model.

## Scope guard (measurement)

`AGENTMEMORY_SCOPE_GUARD` has three modes. It is `off` by default. `warn` records every read of a whole collection: `list`, `listKeys`, `iterate` (which includes `collectAll`) and `listPage`, which reads every key to return one page. `throw` (or `refuse`) records the same reads and also refuses the ones a scope's class forbids, with a `ScopeTooLargeError` that names the scope, the call and the paged alternative. A `paged-only` scope refuses `list` and allows `listKeys`, `iterate` and `listPage`. A `point-read-only` scope refuses all four, because it is read by key only. A `bounded` scope and a scope that is not in `KV` are never refused. The classes are in `src/fork/kv/scope-classes.ts`.

`npm run test:scope-guard` runs the suite with `throw` on. Its setup file, `test/helpers/scope-guard-setup.ts`, checks every whole read made through `StateKV` or the shared `mockKV()` double, but only when the nearest caller outside the KV layer is under `src/`, so a test that lists its own fixtures is not refused. A refusal fails the test even if the code under test caught it. A KV double that a test file defines for itself is not covered. CI runs this command in the `scope-guard` job.

Each record holds the collection with ids replaced by `*` (`mem:obs:*`), the call site, the number of calls, the most items and bytes one reply returned, and the totals. The call site is the iii function that was running, then the function name, file and line of the first stack frame outside the state layer. In the built server the file is `index.mjs`, so the function name is the part to search for.

The server writes the records to `scope-guard-inventory.json` in the data directory every 30 seconds, sorted by largest reply. It also logs one warning per call site per minute. A restarted server reads the file back and keeps counting, and `restarts` in the file says how many times that happened; delete the file to start a fresh count.

`scripts/fork/replay-day.ts` drives a compressed day of traffic against a running server so the inventory fills. `scripts/fork/read-inventory.ts` turns inventory snapshots taken at boot, at the end of the replay and after one-off calls into one row per collection and call site, with calls and bytes per day. The buddy run is in `docs/fork/baseline/read-inventory.md`.

## Records on Kvrocks

[kvrocks.md](kvrocks.md) describes the Kvrocks state store (TEE-1163): the stack service, the resumable Valkey-to-Kvrocks copy and its verify (`scripts/fork/kvrocks-migrate.ts`), and how the replica and the bench run on Kvrocks.

## Filling the disk search index

[search-migration.md](search-migration.md) describes the migration that fills Qdrant from a memory-mode stack's records and persisted vectors with no embedding calls (TEE-1168): `scripts/fork/search-migrate.ts`, its verify, the measured results on buddy's snapshot, Qdrant's memory during a fill (TEE-1201) and the cutover order.

## Baseline and benchmarks

[baseline/README.md](baseline/README.md) records the in-memory system's numbers on a replica of buddy's stack and on synthetic stores, and how to re-run them. The scripts are in `bench/fork/`, and `bench/fork/ceilings.json` fails a run that regresses.

## Disk keyword search ceilings

Disk keyword search expands query prefixes and ranks with SearchIndex's exact BM25 (TEE-1195). Two checks hold its costs:

- **Latency under capture writes.** Keyword search p99 under capture writes must stay at or under 60 ms at 200,000 documents. Measured on 2026-11-20 at 41–44 ms. Run it before a change to the keyword path ships. It needs a Qdrant of its own with a 1 GB limit and takes about 15 minutes:

  ```
  docker run -d --name kw-qdrant -m 1g --memory-swap 1g -p 127.0.0.1:16345:6333 qdrant/qdrant:v1.20.2
  node --import tsx bench/fork/qdrant/keyword-capture.ts --qdrant http://127.0.0.1:16345 --count 200000
  ```

  It prints p50, p95 and p99 for each phase. It exits 1 when a capture phase's p99 is above `--ceiling-p99-ms` (default 60).
- **Worker heap.** `bench/fork/qdrant/prefix-vocabulary-heap.ts` fills the prefix vocabulary to its 1,000,000-term bound and exits 1 above 78 MiB. `npm test` runs it, in `test/fork-prefix-vocabulary-heap.test.ts`.

## Search engine spikes

[spikes/qdrant.md](spikes/qdrant.md) records the Qdrant memory, recall, latency and point-lifecycle spikes (TEE-1161), the engine decision and the settings for the search worker. The scripts are in `bench/fork/qdrant/`.

## Retention (operator guide)

Retention trims, hides and later deletes old observations and memories, after a session summary covers them. Nothing is deleted at once: a row moves to a restorable vault and is purged after the grace period. The design is in [retention-design.md](retention-design.md) and the code layout in [retention-architecture.md](retention-architecture.md).

**Turn it on.** A stack is on only when every one of these is set. A missing or malformed one keeps retention off, and the log says which.

| Variable | Value | Meaning |
|---|---|---|
| `AM_RETENTION` | `enforce` | The kill switch. Anything else is off. |
| `AM_RETENTION_WINDOWS` | `trim:45,obs:180,sup:180,cold:365` | Project-active days before raw `source` is trimmed, observations are moved, superseded memories are moved and cold memories are demoted. Each at least 1. |
| `AM_RETENTION_GRACE_DAYS` | `30` | Days a moved row stays restorable before the purge deletes it. At least 1. |
| `AM_RETENTION_RECALL_CASES` | `/path/cases.json` | Golden recall cases. With none, every run is refused and only reports. |
| `AM_RETENTION_INTERVAL_MS` | `604800000` | Sweep interval. Unset is weekly, `0` is manual only, blank is off, and above `2147483647` (about 24.8 days, the longest delay a Node timer honours) is off. The purge runs daily whatever this is. |

Also set `AGENTMEMORY_AUDIT_RETENTION_MONTHS=13`, so a run's audit outlives its grace period, and `MAX_OBS_PER_SESSION=5000`.

**Routes.** All six need `Authorization: Bearer <secret>`. With no secret configured they answer 503. `dryRun` is true unless it is exactly `false`.

| Route | Body or query | Does |
|---|---|---|
| `POST /agentmemory/retention/sweep` | `{"dryRun": true}` | Seals, plans and, when `false`, moves what the protection rules clear, then checks recall and restores the run by itself if recall fell. |
| `GET /agentmemory/retention/report` | `?runId=ret_...` (optional) | The run's report and run row; the newest run without `runId`. |
| `POST /agentmemory/retention/restore` | `{"runId": "ret_..."}` or `{"refs": [...]}` (at most 100) | Puts rows back from the vault, with no embedding call. |
| `POST /agentmemory/retention/purge` | `{"dryRun": true}` | Deletes the runs whose grace has ended. |
| `POST /agentmemory/retention/pin` | `{"ref": {...}, "reason": "...", "who": "..."}` or `{"ref": {...}, "unpin": true}` | Protects one item. |
| `GET /agentmemory/retention/job` | `?id=job_...` | The state of a sweep, purge or restore that answered 202. |

A ref is `{"kind": "memory", "id": "mem_..."}` or `{"kind": "observation", "sessionId": "ses_...", "id": "obs_..."}`. Status codes: 400 for a bad body, 401 for a wrong token, 404 for an unknown run or item (a pin also answers 404 for an item nothing could restore, such as one the purge has started on), 409 when a sweep, purge or restore already holds the lease or took it over mid-call (retry later; every step repeats safely), 503 for no secret or, on sweep and purge, retention off.

**Long calls.** The engine ends an HTTP request at 180 s (`default_timeout: 180000` in `deploy/runtime/worker-compose.yaml` and `src/cli/compose-project.ts`, and the worker's `invocationTimeoutMs: 180000` in `src/index.ts`), and the work it started keeps running. So sweep, purge and restore stop waiting after 150 s, 30 s before that limit, and answer `202 {"kind": "running", "jobId": "job_...", "poll": "/agentmemory/retention/job?id=job_..."}`. A call that finishes in time answers as before, with no job id. Poll `GET /agentmemory/retention/job?id=<jobId>` until `job.state` is not `running`:

| `job.state` | Meaning |
|---|---|
| `running` | The call is still working. |
| `done` | Finished. `job.outcome` is what the call would have answered (`kind: "done"`, `busy`, `off`, `lease-lost`, `not-found` or `invalid`), so read its `kind`, not only the state. For a sweep, `job.outcome.runId` names the run for `GET report`. |
| `failed` | The call threw. `job.error` holds the message and the log has the rest. Repeating the call is safe. |
| `lost` | The worker restarted while the call ran. Nothing finishes it. Read the run's report and repeat the call, which resumes safely. |

An unknown job id answers 404 and a malformed one 400. Job rows stay in `mem:retention:jobs`; nothing prunes them.

**First rollout.**

1. Set the variables and restart. Run `{"dryRun": true}` first and read the report: counts and bytes per stage, 20 samples per stage with reasons, what each protection signal held back, and the sessions that have no seal yet.
2. Run `{"dryRun": false}`. The first enforcing run moves at most 10% of observations. It restores itself if the recall check fails, and the report says why.
3. During the grace period `GET report` shows `held` (rows still restorable) and `graceEndsAt`. Restore one item or a whole run with the restore route. The daily purge deletes what is still held after `graceEndsAt` and sets `purgedAt`.
4. Pin what must never go. A pinned item is skipped by the sweep and by the purge. Pinning a demoted memory brings it back at once. Pinning an item that is already in the vault does not restore it: the purge restores it at the end of grace, or restore it now.

Restore, pin and report keep working when retention is switched off, so the kill switch never blocks an undo. Restoring a run a sweep left unfinished also closes it, with retention on or off.

## Rebasing

See [rebase-runbook.md](rebase-runbook.md).
