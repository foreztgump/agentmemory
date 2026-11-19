# Records on Kvrocks (TEE-1163)

Records and the knowledge graph move from Valkey (RAM) to Apache Kvrocks 2.17.0 (RocksDB on disk). agentmemory does not change: iii's `redis` state adapter talks to Kvrocks as it talked to Valkey, and the stack selects it with `AGENTMEMORY_STATE_BACKEND=redis` and `AGENTMEMORY_REDIS_URL=redis://:<password>@kvrocks:6666`.

## What the copy relies on

The iii state worker's redis adapter keeps one hash per scope: key `state:<scope>`, field = the state key, value = the JSON text. It sets no TTLs and uses no other key types. iii's own Lua update scripts were proven to store identical data on Kvrocks and Valkey in 21 of 21 cases (research file 05). Buddy's 2026-11-16 snapshot holds 3,725 keys, all hashes, none with a TTL: 3,724 `state:*` scopes and the iii streams hash `stream:mem-live:viewer`.

So a copy of every hash, field by field with the same bytes, is a copy of every record, memory, lesson, session, graph item and persisted vector (`mem:index:bm25:vec:<bucket>`, `mem:emb:<obs>`). The tool checks that layout as it runs: a source key that is not a hash, or that has a TTL, stops the copy with exit code 2. `test/fork-kvrocks-deploy.test.ts` pins the state worker version the layout was proven with.

## The migration tool

`scripts/fork/kvrocks-migrate.ts`, run with `node --import tsx`. The URLs come from `MIGRATE_SOURCE_URL` and `MIGRATE_TARGET_URL`, so the password is not on the command line. It uses a small byte-safe RESP client (`scripts/fork/lib/resp.ts`) and adds no dependency.

| Command | What it does |
|---|---|
| `copy` | Lists the source keys with `SCAN`, then pages each hash with `HSCAN ... COUNT 200` and writes each page with `HSET`, split at 4 MiB. It never reads a whole hash (`HGETALL`, `HKEYS` or `HVALS`), on either side. After each page it records the next cursor in the target hash `fork:migrate` (`cursor:<key>`, or `done`). |
| `verify` | Compares the two key sets, every hash's field count (`HLEN`) and a sample of values. Prints one row per collection family and exits 1 on any difference. |
| `status` | Prints how many hashes `copy` has finished. |

**Resume and idempotency.** A re-run skips hashes marked `done` and continues the others from the recorded cursor. `HSET` of a field that already holds the same bytes changes nothing, and a hash field cannot exist twice, so a replayed page cannot add a duplicate. The cursor is written only after the page's `HSET` is acknowledged, so a kill between the two replays one page. Kvrocks writes both through one RocksDB WAL in order, so a Kvrocks crash loses a suffix of writes, never a page without its cursor. A cursor is only valid for the same source process: when the source's `run_id` changed, unfinished hashes restart from cursor 0. The source must not change while the copy runs (capture paused, or a restored snapshot).

**A target that is not empty.** With no `fork:migrate` hash, `copy` refuses a target that holds any key (exit 3). Use a fresh Kvrocks volume. The `fork:migrate` hash stays after the copy; iii's adapter only scans `state:*`, and verify ignores it.

**Verify sampling.** A field is sampled when the first 4 bytes of `sha256(key, field)` are divisible by `--rate` (default 32, about 3 % of fields), so the same fields are picked on every run whatever the scan order. Hashes with at most 64 fields are checked in full, and `--full` checks every field. The sampled checksum of a family is the XOR of `sha256` over length-prefixed `(key, field, value)` tuples, so it does not depend on order; the target's checksum uses the target's value for the same fields. Values are never printed.

## Stack service

`deploy/coolify/docker-compose.yml` and `.buddy.yml` run `kvrocks` with:

| Setting | Value | Why |
|---|---|---|
| `rocksdb.block_cache_size` | 384 MB | The design's memory budget (design synthesis, memory table). |
| `rocksdb.write_buffer_size`, `max_write_buffer_number` | 64 MB, 2 | Memtables bounded at 128 MB. |
| `rocksdb.max_background_jobs` | 2 | Compaction and flush threads. |
| `requirepass` | `KVROCKS_PASSWORD` | Required. It goes into a `redis://` URL, so use hex or URL-safe characters. |
| `mem_limit` | `KVROCKS_MEM_LIMIT`, default `1280m` | No swap. |

The cache cap does not bound a whole-hash read: one `HGETALL` costs about 5× the hash size in transient RSS. The paged reads from TEE-1160 are what keep Kvrocks inside its limit.

`agentmemory` depends on `kvrocks` being healthy. `valkey` stays in the file behind the `valkey-source` profile, with its volume, as the migration source and the rollback target. It no longer starts with the stack.

## Replica and bench

`REPLICA_STORE=kvrocks bench/fork/replica.sh valkey <backup>` loads the snapshot into Valkey, copies it into Kvrocks, verifies, stops Valkey and restarts Kvrocks, so its `memory.peak` starts fresh. `replica.sh migrate copy|verify|status` runs the tool on the replica network. `bench.ts` names its store metrics after `REPLICA_STORE` (`run.peakMiB.kvrocks`), and `capture.ts` counts stored events through the same RESP client (`--store-url`).

## The adapter's reply timeout

iii's redis adapter sends every state call over one connection behind a lock, and fails a call whose reply takes longer than the redis client's default response timeout, about 500 ms, with `Failed to get group from Redis: timed out`. It retries only a dropped connection. Its only setting is `redis_url`.

Valkey answers a whole-hash read from RAM: a 2,000-observation session (about 10.7 MB) lists in about 20 ms. Kvrocks takes 55 ms for the same `HGETALL` alone, about 160 ms through the engine, and more under load. On the first boot after the copy, the index rebuild lists ten sessions at a time while Kvrocks starts cold. In two of three runs, the two 2,000-observation sessions timed out. The rebuild skipped them, 4,000 observations stayed out of the keyword index, and the replica never became ready.

`StateKV.list` now catches that one error on the redis backend and reads the same scope again through `state::list_keys` and point reads (`src/fork/kv/list-timeout.ts`), each far below the limit. It returns the same rows in the same order. Valkey never reaches the fallback.

What is still exposed, measured through the engine on buddy's data: `list_keys` of `mem:graph:retrieval-data` (148,945 keys) takes 260-510 ms, and a whole `list` of `mem:semantic` (14,336 rows) 310-360 ms. Both grow with data. A `list_keys` has no smaller read through iii to fall back to. The lasting fix is in iii: a configurable response timeout, or a paged list built on `HSCAN`.

## Measured on buddy's snapshot

Workstation, 2026-11-19, image `am-tee1163:b67d0a5`, keyword-only, agentmemory limit 2560m (`bench/fork/bench.ts`, private recall cases).

| | Valkey | Kvrocks |
|---|---|---|
| copy, verify (3,725 hashes, 1,166,246 records) | | copy 22 s by the tool on an idle host, 16-43 s inside `replica.sh` runs; verify 11 s (`--full` 28 s) |
| boot to ready | 42.9 s | 40.6 s |
| recall@10, MRR | 0.86, 0.7347 | 0.86, 0.7347 |
| search p50, p95 | 9, 46.8 ms | 11.5, 35 ms |
| capture | 190 obs/s | 200.7 obs/s |
| agentmemory peak | 1,775 MiB | 1,779 MiB |
| store steady anon | 2,210 MiB | 484 MiB |
| store process peak (VmHWM) | | 524 MiB, no OOM kill |
| store cgroup `memory.peak` | 3,825 MiB | 1,280 MiB (the cap; page cache, reclaimed) |
| data on disk | | 3.8 GB (uncompacted) |

The Valkey column ran on the image before the timeout fix, which the Valkey path never reaches.

A day of capture on the Kvrocks replica (`scripts/fork/replay-day.ts --replica`, buddy's daily volume compressed 24× into one hour: 12,200 observations, 98 sessions, 600 searches) finished with 0 failed calls in any of its 15 call types and no `timed out` in the agentmemory log. Kvrocks stayed under its 1,280 MiB cap: anon at most 587 MiB, RSS 602 MiB, VmHWM 616 MiB, `oom_kill` 0, cgroup `memory.peak` 1,280 MiB (page cache). Data on disk stayed 3.8 GB. agentmemory peaked at 2,001 MiB with no restart.

## Rejected alternatives

- `DUMP`/`RESTORE` or `MIGRATE`: one payload per key, so the 149k-field `mem:graph:retrieval-data` is read and written whole, and a kill cannot resume inside a key.
- redis-shake or replication: another tool, the same whole-key payloads, and no verify of our own.
- Parsing the RDB file: a parser tied to Valkey's RDB version.
- `/export` and `/import` (`migrate-state.sh`): not byte for byte, limited by the response frame, and it does not carry the vector scopes, so every document would be re-embedded.
