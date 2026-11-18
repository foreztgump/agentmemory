# Baseline: the in-memory system on buddy's replica

Date: 2026-11-17 to 2026-11-18. Issue: TEE-1155. Every later change to the fork is judged against these numbers.

The numbers come from upstream v0.9.33 plus the fork's TEE-1153 settings commit (`bfc9cb5`): records in Valkey, and the keyword index, vectors and lesson index in the agentmemory process. Production buddy runs v0.9.31. This baseline uses the code that later issues change, not the code in production.

## Summary

| Run | Fits? | Boot to ready | agentmemory boot peak | agentmemory steady (anon) | Search p50 / p95 | Capture | Recall@10 / MRR |
|---|---|---|---|---|---|---|---|
| buddy, keyword-only, 2560m | yes | 38.5 s | 1,827 MiB | 1,710 MiB | 8.9 / 38.6 ms | 147.4 obs/s | 0.86 / 0.735 |
| buddy, vectors loaded, 2560m | **no**: OOM-killed during boot | — | 2,561 MiB (the limit) | — | — | — | — |
| buddy, vectors loaded, 5g | yes | 55.9 s | 4,291 MiB | 4,127 MiB | 9.7 / 31.2 ms | 132.4 obs/s | 0.86 / 0.735 |
| synthetic 250k, 2560m | yes | 43.5 s | 1,561 MiB | 1,187 MiB | 43.1 / 292.2 ms | 174.9 obs/s | 1.00 / 0.90, graph 10/10 |
| synthetic 500k, 2560m | **no**: worker heap out of memory, 6 crashes in 15 min | — | 1,599 MiB | — | — | — | — |
| synthetic 500k, 6g | yes | 64.7 s | 2,381 MiB | 2,167 MiB | 312.7 / 744.6 ms | 148.3 obs/s | 1.00 / 0.90, graph 10/10 |
| synthetic 1M, 6g | **no**: worker heap out of memory, 11 crashes in 15 min | — | 2,434 MiB | — | — | — | — |

The rows that fit come from the final end-to-end run of `bench/fork/baseline.sh` on 2026-11-18. [Repeatability](#repeatability) lists the earlier runs.

Main findings:

- **Buddy's vectors do not fit in production's 2,560 MiB limit.** With an embedding provider set, the boot loads 242,653 vectors into the process and the container is OOM-killed at its limit. With a 5 GB limit it needs 4.3 GB at boot and 4.1 GB steady. Without vectors (how buddy runs today) it needs 1.7 to 1.8 GB.
- **The keyword-only system stops fitting between 357k and 500k observations at the production limit, and at 1M it never starts.** The cause is the Node heap limit, not the container limit. Node sets the agentmemory worker's heap limit to 1,472 MiB under a 2,560 MiB container and to 2,240 MiB under 6 GB. The in-memory keyword index for 1M observations (about 640k indexed documents) does not fit in 2,240 MiB. The worker crashes with `JavaScript heap out of memory`, the engine restarts it, and the next keyword rebuild crashes again. A larger container does not fix this.
- **Recall@10 on buddy's own data is 0.86 and MRR is 0.735.** Memories recall at 1.00 and observations at 0.825. Loading vectors did not change either number, because the query embedding fails offline and search falls back to keyword and graph.
- **Buddy's graph cannot return evidence through an edge.** No edge has an endpoint backed by a stored observation, so the private tier has no graph-only cases. Graph-only behaviour is covered by the synthetic tier only. See [Graph](#graph).

## Environment

| | |
|---|---|
| Host | The owner's workstation, used as the staging host. AMD Ryzen 9 8945HS (16 threads), 28 GiB RAM, Linux 7.0.0-43, Docker 29.9.3. The host was shared during the runs: load average 5 to 8, and another agent's replica was running. |
| agentmemory image | `am-baseline:bfc9cb5`, `sha256:e9e526d06413bdfc4ef4be65f4d6c260cef0bd0319f2582661ef1d1e72dc4658`, built from this branch with `deploy/Dockerfile` (iii 0.25.1, state worker 0.22.22, http worker 0.22.8) |
| Valkey | `valkey/valkey:9` (9.1.3), `sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7`. AOF on (`everysec`), `maxmemory 3gb`, `noeviction`. |
| Limits | agentmemory `mem_limit` 2560m (production's default) unless the run says otherwise. Valkey 4g. Swap is off for both (`memswap_limit` equals `mem_limit`), so a store that does not fit is killed instead of swapping. |
| Network | An `internal` Docker network with no route out. Dummy secrets and keys. The embedding provider is unset, or set to `voyage` with a dummy key, so no Voyage call can succeed. |
| Data | Buddy's nightly backup of 2026-11-16: `valkey.rdb.zst` (1,815,218,165 bytes uncompressed, written by Valkey 9.1.3, 2.13 GB in memory) and `agentmemory-data.tar.zst` (857 MB uncompressed). |

Production's compose default `VALKEY_MAXMEMORY` of 2gb is below buddy's 2.13 GB dataset, so buddy's production setting must be higher. This session could not read production's configuration to confirm it. The replica uses 3gb.

## Buddy's data

### Records per KV scope

Counts at restore, from `replica.sh counts`:

| Scope | Records | Scopes |
|---|---:|---:|
| `mem:obs:<session>` | 357,592 | 2,979 |
| `mem:idx:obs:<shard>` | 357,594 | 64 |
| `mem:index:bm25:vec:<bucket>` | 249,289 | 395 |
| `mem:graph:retrieval-data` | 148,945 | 1 |
| `mem:semantic` | 14,336 | 1 |
| `mem:access` | 9,357 | 1 |
| `mem:graph:nodes` | 4,418 | 1 |
| `mem:audit:<month>` | 4,095 | 2 |
| `mem:graph:name-index` | 3,533 | 1 |
| `mem:graph:node-degree` | 3,533 | 1 |
| `mem:sessions` | 3,094 | 1 |
| `mem:capture:events:<shard>` | 2,719 | 256 |
| `mem:summaries` | 1,810 | 1 |
| `mem:image-refs` | 1,349 | 1 |
| `mem:capture:inbox` | 1,000 | 1 |
| `mem:graph:edges` | 839 | 1 |
| `mem:capture:prompts` | 770 | 1 |
| `mem:memories` | 760 | 1 |
| `mem:insights` | 485 | 1 |
| `mem:lessons` | 88 | 1 |
| `mem:procedural` | 43 | 1 |
| `mem:idx:project-sessions` | 38 | 1 |
| `mem:graph:index-manifest` | 17 | 1 |
| `mem:config` | 5 | 1 |
| `mem:crystals`, `mem:graph:retrieval-control`, `mem:health`, `mem:index:bm25`, `mem:audit:months` | 2 each | 1 each |
| `mem:graph:snapshot`, `mem:graph:index-migration`, `mem:metrics`, `mem:state` | 1 each | 1 each |

### Vectors

The replica has persisted vectors: 249,289 rows in Valkey under `mem:index:bm25:vec:<bucket>`. They are not in the agentmemory data volume. That volume holds a state store left over from before the stack moved to Valkey, the image store, the stream store, logs and the iii worker cache. With `EMBEDDING_PROVIDER=voyage` the boot loads 242,653 of the 249,289 rows into the vector index. This baseline did not investigate the difference of 6,636 rows.

Both modes were run: keyword-only (no provider, as buddy runs today) and vectors loaded (`voyage`, dummy key). In the vectors mode every query embedding fails on the internal network, so search uses keyword and graph only. The vectors mode measures memory and boot, not vector recall.

### Keyword index coverage

The boot indexes 229,476 documents: 228,716 observations and 760 memories. 128,876 observations have no narrative, and upstream does not keyword-index an observation without a title and a narrative.

### Observation shape

Measured by `bench/fork/profile.ts` and stored in `bench/fork/profiles/buddy-2026-11-16.json`. It holds counts and quantiles only, no content.

| Type | Observations | Share |
|---|---:|---:|
| `other` | 249,752 | 69.8% |
| `command_run` | 33,276 | 9.3% |
| `file_read` | 28,541 | 8.0% |
| `search` | 13,643 | 3.8% |
| `file_edit` | 12,023 | 3.4% |
| `subagent` | 9,629 | 2.7% |
| `conversation` | 4,230 | 1.2% |
| `file_write` | 3,352 | 0.9% |
| `error` | 2,298 | 0.6% |
| `web_fetch` | 823 | 0.2% |
| no type | 25 | 0.0% |

Hook types, from the 236,048 observations that record their source:

| Hook type | Observations | Payload p50 bytes | Payload p95 bytes |
|---|---:|---:|---:|
| `assistant_message` | 84,139 | 357 | 389 |
| `post_tool_use` | 72,200 | 2,082 | 8,681 |
| `step_finish` | 27,953 | 175 | 178 |
| `reasoning` | 12,982 | 91 | 4,143 |
| `session_status` | 7,878 | 90 | 90 |
| `session_updated` | 5,603 | 183 | 205 |
| `subagent_stop` | 4,384 | 127 | 4,106 |
| `llm_params` | 3,926 | 201 | 233 |
| `session_diff` | 3,882 | 89 | 89 |
| `prompt_submit` | 2,984 | 1,308 | 7,108 |
| `permission_replied` | 2,826 | 112 | 112 |
| `patch_applied` | 2,793 | 210 | 497 |
| `post_tool_failure` | 1,851 | 745 | 4,639 |
| `session_finalized` | 1,249 | 57 | 57 |
| `stop` | 510 | 515 | 4,568 |
| `subagent_start` | 461 | 104 | 112 |
| `task_completed` | 150 | 275 | 843 |
| `config_loaded` | 116 | 4,284 | 4,432 |
| 6 other types | 161 | | |

Stored observation size (the JSON value in Valkey): mean 1,459 bytes, p50 743, p90 3,410, p99 9,719.

| Stored size (bytes) | Observations |
|---|---:|
| 0–255 | 1 |
| 256–511 | 101,806 |
| 512–1,023 | 113,555 |
| 1,024–2,047 | 88,706 |
| 2,048–4,095 | 23,558 |
| 4,096–8,191 | 17,321 |
| 8,192–16,383 | 12,267 |
| 16,384–65,535 | 377 |
| 65,536 and more | 1 |

Indexed observations: title p50 11 characters, narrative p50 323 and p90 400 characters, 38 terms per document at p50, 144,918 distinct terms. No indexed observation has facts or concepts. 5,704 have one file. Observations per session: p50 72, p90 238, p99 913, maximum 2,000.

## Benchmarks

### What each number means

| Metric | Measured as |
|---|---|
| `boot.seconds` | From the agentmemory container's start to the first status report that shows the keyword rebuild finished over a non-empty index. Valkey has already loaded its AOF. |
| `boot.peakMiB.<container>` | cgroup `memory.peak` at ready. For Valkey this includes the page cache from reading its AOF. |
| `steady.MiB` / `steady.anonMiB` | cgroup `memory.current` and the `anon` line of `memory.stat` after 5 idle minutes. `anon` excludes page cache. |
| `search.<suite>.p50Ms` / `p95Ms` | Latency of the eval queries, one at a time, from a client container on the same network |
| `recall.<suite>.*` | The recall eval: recall@10, MRR and graph cases passed |
| `capture.storedPerSecond` | 3,000 hook events POSTed to `/agentmemory/observe` by 8 concurrent clients, with the measured hook-type mix and payload sizes, timed until all 3,000 are stored as observations |
| `run.peakMiB.<container>` | `memory.peak` at the end, after search and capture |
| `index.bm25Documents` / `index.vectorDocuments` | Documents in each index at ready, from the status report |

### Results

These are from the final end-to-end run of `bench/fork/baseline.sh` on 2026-11-18. The result files are in `/home/cownose/am-staging/bench-results/final/`.

| Metric | buddy keyword 2560m | buddy vectors 5g | synthetic 250k 2560m | synthetic 500k 6g |
|---|---:|---:|---:|---:|
| `boot.seconds` | 38.5 | 55.9 | 43.5 | 64.7 |
| `boot.peakMiB.agentmemory` | 1,827 | 4,291 | 1,561 | 2,381 |
| `boot.peakMiB.valkey` | 3,967 | 3,793 | 589 | 1,162 |
| `steady.MiB.agentmemory` | 1,793 | 4,217 | 1,232 | 2,230 |
| `steady.anonMiB.agentmemory` | 1,710 | 4,127 | 1,187 | 2,167 |
| `steady.MiB.valkey` | 2,243 | 2,595 | 509 | 890 |
| `steady.anonMiB.valkey` | 2,214 | 2,213 | 440 | 871 |
| `run.peakMiB.agentmemory` | 1,886 | 4,539 | 1,576 | 2,448 |
| `run.peakMiB.valkey` | 3,967 | 3,793 | 590 | 1,162 |
| search p50 ms | 8.9 | 9.7 | 43.1 | 312.7 |
| search p95 ms | 38.6 | 31.2 | 292.2 | 744.6 |
| `capture.storedPerSecond` | 147.4 | 132.4 | 174.9 | 148.3 |
| recall@10 | 0.86 | 0.86 | 1.00 | 1.00 |
| MRR | 0.7347 | 0.7347 | 0.90 | 0.90 |
| graph cases passed | n/a | n/a | 10 of 10 | 10 of 10 |
| `index.bm25Documents` | 229,476 | 229,476 | 159,565 | 320,043 |
| `index.vectorDocuments` | 0 | 242,653 | 0 | 0 |

The runs that did not fit:

| Run | Result |
|---|---|
| buddy, vectors, 2560m | The container was OOM-killed during boot. `memory.peak` was 2,561 MiB, the limit. |
| synthetic 500k, 2560m | Not ready after 15 minutes. The worker hit `JavaScript heap out of memory` 6 times. Container peak 1,599 MiB. |
| synthetic 1M, 6g | Not ready after 15 minutes, in both runs: 12 and 11 heap out-of-memory crashes, container peaks 2,430 and 2,434 MiB. While a 1M snapshot was being built, one more attempt ran for 30 minutes with 22 crashes and a peak of 2,444 MiB. |
| synthetic 3M | Not run. The generator produces it (4.95 GB of Valkey commands in 59 s, 161 MB of RAM), but 1M already does not start. |

### Repeatability

The host was shared, so time and throughput numbers vary between runs. Memory varies by up to 10%, and recall did not vary at all. The last run in each cell is the final matrix run.

| Metric | buddy keyword | buddy vectors 5g | synthetic 250k | synthetic 500k 6g |
|---|---|---|---|---|
| `boot.seconds` | 41.9, 41.8, 51.9, 38.5 | 60.2, 55.9 | 52.9, 42.3, 43.5 | 64.7, 64.7 |
| `boot.peakMiB.agentmemory` | 1,774, 1,780, 1,625, 1,827 | 4,335, 4,291 | 1,539, 1,590, 1,561 | 2,381, 2,381 |
| `steady.anonMiB.agentmemory` | 1,553, 1,710 | 4,175, 4,127 | 1,346, 1,198, 1,187 | 2,134, 2,167 |
| search p50 / p95 ms | 7.8 / 29.6, 7.1 / 26.5, 19.4 / 43.7, 8.9 / 38.6 | 16.7 / 58.4, 9.7 / 31.2 | 112.6 / 437.6, 60.4 / 331.0, 43.1 / 292.2 | 268.0 / 649.9, 312.7 / 744.6 |
| `capture.storedPerSecond` | 183.0, 161.6, 100.0, 147.4 | 93.5, 132.4 | 84.7, 138.3, 174.9 | 170.1, 148.3 |
| recall@10 / MRR | 0.86 / 0.7347 every run | 0.86 / 0.7347 every run | 1.00 / 0.90 every run | 1.00 / 0.90 every run |

- The first two buddy keyword runs used an earlier restore procedure. Valkey's `memory.peak` still included the snapshot import, and agentmemory sometimes started while Valkey was loading. The `steady.anonMiB` metric did not exist yet in those runs.
- The first two synthetic 250k runs and the first 500k run used snapshots built before the generator's weighted picks were made independent of key order. Those snapshots have the same distributions, but different observations carry each type label.
- The ceilings use the highest memory and time, and the lowest throughput, from any of these runs.

The synthetic search latency is higher than buddy's because the generated vocabulary follows a Zipf distribution, so the common words in the synthetic queries match far more documents than buddy's rarer query terms. Compare synthetic latency only with other synthetic runs.

## Recall eval

Scoring is deterministic: the cases have a fixed order, the queries run one at a time, and no LLM is involved. A case counts as recalled when any of its expected ids is in the top 10 of smart search. Several expected ids are alternatives, for example identical copies of the same text. MRR uses the rank of the first expected id. Graph cases are also reported as passed or failed.

### Synthetic tier (committed)

`bench/fork/eval/synthetic-cases.json` holds 50 cases. The generator plants their facts with seed 1155, before the bulk records, so the same cases hold for every corpus size. A unit test checks that the generator still reproduces the file.

- 40 keyword cases. A target observation holds three planted words, and each of three distractors in the same session holds one of them. The query names two of the three plus two common words.
- 10 graph-only cases. Observation A has a concept (the entity) and a file. Observation B has the same file but not the entity. The heuristic graph extraction, run through `POST /agentmemory/graph/extract`, links the entity to the file. The query is the entity's name in quotes. B shares no term with the query, so only the graph edge can reach it.

Baseline: recall@10 1.00, MRR 0.90 (keyword 1.00, graph 0.50, because B ranks second after A), 10 of 10 graph cases passed.

### Private tier (buddy's data, not in git)

`bench/fork/private-cases.ts` builds the cases from a fresh restore (`replica.sh valkey`, before agentmemory writes anything) into `/home/cownose/am-staging/eval-private/buddy-2026-11-16.json`. The case file holds private text and stays outside the repository. Building the cases twice gives identical files.

- 80 observation cases and 20 memory cases. Seeded sampling picks a record, and the query is its four rarest title and narrative terms that occur in 2 to 200 records, in seeded order. Every record with the same text counts as a hit.
- 0 graph cases, see the next section.

Baseline: recall@10 0.86 and MRR 0.7347 overall. Observations: 0.825 and 0.6996. Memories: 1.00 and 0.875.

### Graph

Buddy's graph has 4,418 nodes (3,668 file and 750 concept) and 839 edges, and its graph retrieval index is built. Graph retrieval only returns an observation that still exists. 5,544 of the observation references on nodes resolve to stored observations, and 7,593 point to observations that no longer exist. Every resolving reference is on a node with no edges. So no edge leads to evidence, and an edge-based graph-only case cannot exist on this data. The design's gate that every graph-only golden case still returns its evidence is checked on the synthetic tier only.

## Ceilings

`bench/fork/ceilings.json` has one entry per run. `bench.ts` exits 1 when a number breaks a limit or a limited metric was not measured.

- Memory ceilings are 15% above the highest baseline run.
- Boot time ceilings are 50% above the baseline.
- Search latency ceilings are twice the baseline.
- Capture throughput floors are half the lowest run.
- Recall@10 and MRR floors are the baseline minus 0.02.
- Graph cases passed and index document counts may not drop.

Each memory or time ceiling has recall and index floors next to it. A change that saves memory by indexing less, or by searching less, fails the floors.

The `synthetic-1m` entry holds the project's targets, such as ready in under 60 seconds, not regression ceilings. The in-memory baseline fails it by design. When a build first boots 1M, replace that entry with ceilings from its numbers.

`bench/fork/baseline.sh` exited 0 on the final run: all four regression entries passed, and `synthetic-1m` missed its targets as expected. Every earlier result also passes its entry. `--check-only` checks a saved result without running anything:

```
$ node --import tsx bench/fork/bench.ts --name buddy-keyword --check-only final/buddy-keyword.json   # PASS 12 limits
$ node --import tsx bench/fork/bench.ts --name buddy-vectors --check-only final/buddy-vectors.json   # PASS 11 limits
$ node --import tsx bench/fork/bench.ts --name synthetic-250k --check-only final/synthetic-250k.json   # PASS 13 limits
$ node --import tsx bench/fork/bench.ts --name synthetic-500k-6g --check-only final/synthetic-500k-6g.json   # PASS 13 limits
```

A ceiling set below the baseline fails the run. For example, `--ceiling boot.peakMiB.agentmemory=1000` on the synthetic 250k run printed `FAIL boot.peakMiB.agentmemory: measured 1590, limit <= 1000` and exited 1.

## How to re-run

Everything is under `bench/fork/`. The scripts need Docker, `zstd` and this repository's `node_modules`. Run one replica at a time. Each one uses up to 4 GB for Valkey plus the agentmemory limit.

```sh
docker build -f deploy/Dockerfile -t am-baseline:$(git rev-parse --short HEAD) .
export AM_IMAGE=am-baseline:$(git rev-parse --short HEAD)

# Restore buddy's backup and print counts per scope; remove everything afterwards.
bench/fork/replica.sh up /home/cownose/am-staging/buddy-2026-11-16
bench/fork/replica.sh down

# Measure the shape of a running replica's data (counts and quantiles only).
node --import tsx bench/fork/profile.ts --container amreplica-valkey-1 --out bench/fork/profiles/<name>.json

# Build the private eval tier from a running replica (writes outside the repository).
node --import tsx bench/fork/private-cases.ts --container amreplica-valkey-1 \
  --out /home/cownose/am-staging/eval-private/buddy-2026-11-16.json

# Build a synthetic snapshot of N observations.
AM_MEM_LIMIT=6g bench/fork/make-synthetic.sh 250000 /home/cownose/am-staging/synthetic/250000

# One benchmark run, checked against its ceilings.
node --import tsx bench/fork/bench.ts --name synthetic-250k \
  --data /home/cownose/am-staging/synthetic/250000/dump.rdb --cases bench/fork/eval/synthetic-cases.json

# The whole matrix (about an hour, longer when snapshots must be built).
bench/fork/baseline.sh /home/cownose/am-staging/buddy-2026-11-16 \
  /home/cownose/am-staging/eval-private/buddy-2026-11-16.json \
  /home/cownose/am-staging/synthetic /home/cownose/am-staging/bench-results

# The eval alone, on a running replica.
REPLICA_PRIVATE_DIR=/home/cownose/am-staging/eval-private \
  bench/fork/replica.sh client node --import tsx bench/fork/eval.ts \
  --cases bench/fork/eval/synthetic-cases.json --cases /private/buddy-2026-11-16.json
```

### How the replica works

- `replica.sh` creates the Valkey and agentmemory volumes, copies the RDB in, and starts Valkey with AOF off so it reads the RDB. It then turns AOF on and recreates the Valkey container so it loads from the AOF, as production does after a restart. This also resets Valkey's `memory.peak`.
- iii compose downloads its state and http workers on first boot, and the internal network forbids that. `replica.sh` fetches them once into a cache volume from a throwaway container that mounts no replica data, then copies them into the replica's data volume.
- The host cannot reach the internal network, so every HTTP client (readiness, eval, capture, graph seeding) runs in a client container on that network, with the worktree mounted read-only.
- `--down` removes the containers, volumes, network and worker cache. `stop` keeps the worker cache.

### Why the generator writes to Valkey directly

`generate.ts` writes records in agentmemory's Valkey layout: one hash per scope, `state:<scope>`, with JSON values, through `valkey-cli --pipe`. It writes sessions, observations and the observation-to-session index. The keyword index and the session index are rebuilt by agentmemory itself at boot.

The REST capture path was not used for bulk loading for two reasons:

- At 85 to 185 observations per second on this host, 1M observations would take 1.5 to 3.3 hours.
- Without an LLM, capture compresses each event into a narrative of at most 400 characters. It would not reproduce the stored size distribution measured from buddy's data.

The REST path is the capture-throughput benchmark instead.

The generator follows the measured profile: the type mix, the share of observations that are keyword-indexed (64%), the title and narrative length distributions, the share with a subtitle and with a file, observations per session, and the stored size. Text comes from a Zipf-distributed pseudo-word vocabulary, which grows with the corpus by Heaps' law (β = 0.5) from buddy's measured 144,918 terms. The generated mean stored size is 1,354 bytes against 1,459 measured (−7%), because the sampler leaves out the single largest record. Planted eval words contain `q` and `x`, which the vocabulary never produces.
