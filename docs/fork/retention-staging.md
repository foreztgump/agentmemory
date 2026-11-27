# Retention staging proof (TEE-1158, slice 12, part 1)

Date: 2026-11-27. Code: `disk` at f188861 (slices 1 to 10 merged). Scripts: `bench/fork/retention/`.
Plan row: [retention-architecture.md](retention-architecture.md), slice 12.

Result in one line: **R1 passes. R12 fails on f188861 and passes with a one-line fix. R9 passes (forced). Restore under the lease passes. The pin passes, but R3 (the vector coming back) could not be proven on a keyword-only replica. The 23 h and 25 h grace check is running (Part 2).**

| Item | Result |
|---|---|
| 1. R1 dry run | **Pass.** 30 user scope families (1,175,279 records) and every Qdrant count equal before and after. Report has every field. 245 to 308 s. |
| 2. Memory peak | **Pass.** No OOM kill. Agentmemory anonymous peak 486 to 607 MiB of 2 GiB, in all runs. |
| 3. R12 kill and resume | **Fail on f188861, pass with the fix below.** The resume answers HTTP 500 and the run stays open. With the fix the same run id resumed and closed `kept`; no item both live and vaulted; `held` equals the vault. |
| 4. R9 forced loss | **Pass, but only by forcing it.** The recall check's own accesses protect the evidence, so the sweep never moves it. After the access logs were deleted, the run restored itself. The first attempt's in-sweep restore died at its start. |
| 5. Restore of a full run | **Pass.** 78,023 and 78,026 entries in 496 s and 683 s. The lease was beaten every 2 to 5 s, and no other owner took it. |
| 6. Pin on a demoted memory | **Pass for the keyword path.** Back in Qdrant, 0 embedding calls. The vector was not restored: see "R3 is not proven here". |
| 7. Grace check | **Started.** Run `ret_mwzimb9x_ea6167a7991d`, `closedAt` 2026-11-27T22:06:58.528Z. |

## Findings that need a decision

**Status since this run.** Findings 1 and 4 are fixed by #46 (`StateKV.set` is typed as the engine's reply, the test doubles answer the same shape, an in-sweep restore failure is logged, and the first `restoredBecause` is kept). Finding 2 is fixed by #44 (TEE-1443). Finding 6 is fixed by #45: the plan computes each memory's score itself at upstream's defaults. The R12 kill and resume has to be re-run against code with #46, and R3 against a replica with a dummy embedding provider.

1. **Resume of a crashed sweep fails (R12).** `recover()` in `src/fork/retention/sweep.ts` ends with `return s.runs.save(row)`. On the real store `save` returns what `state::set` returns, `{ old_value, new_value }`, not the `RunRow`. `drive` gets an object with no `id` or `phase`, skips every phase and fails in `checkAfter` at `loadDraft(undefined)`: HTTP 500, `invocation_failed: serialization error: missing field 'key'`. The unit tests pass because their KV double returns the value. Found with a debug image that logs the stack of a `StateKV` call with no key. The fix (verified, not committed on this branch):

   ```diff
   -  return s.runs.save(row);
   +  await s.runs.save(row);
   +  return row;
   ```

   It is the only call site that uses the returned value (`grep "runs.save("`). A test should run `runSweep` against a KV double whose `set` returns `{ old_value, new_value }`.
2. **The REST routes answer 504 after 180 s.** The agentmemory worker's `invocationTimeoutMs` is 180000. A dry run took 245 to 308 s and every enforcing sweep (16 to 18 min) and every restore of a full run (8 to 23 min) took longer. The 504 is only the answer: the function keeps running and finishes. A caller has to poll `GET /agentmemory/retention/report`. The operator guide (`README.md`) says nothing about this. The daily purge timer and the sweep timer call the functions in process and are not affected. TEE-1443 (#44) has since changed the routes to answer 202 with a job id after 150 s; the scripts here poll past a 504 and were run against f188861, so against code with #44 they would need to follow the job id.
3. **The recall check protects its own evidence (R9).** `mem::smart-search` records an access for every hit, and the `retrieved` signal protects any row accessed since the cold window. So a golden case that hits before the run can only lose its evidence through collateral loss. In the three natural enforcing runs (B, R12 and F) the 8 cases stayed at 100 and the evidence was held back: the plan counts `retrieved` hits 1,896 before the cases had run and 1,938 after.
4. **An in-sweep restore died at its start once.** In run E the after-check failed and set `restoredBecause`, then the restore stopped with `restored: 0`. The lease was released, `held` was unchanged and the run stayed in `check-after`. The error was not logged: the route logs only the 180 s timeout. A run of the same size (r9b) restored in the sweep. `POST restore {runId}` closed run E, as documented, but it replaced `restoredBecause` with "restore requested; the run had stopped in phase check-after", so the golden-loss reason survives only in the first audit entry.
5. **R3 is not proven here.** See below.
6. **Stage C does nothing on buddy as it stands.** A memory with no row in `mem:retention` is never cold, and nothing computes the scores: `mem::retention-score` is registered but no route, tool or timer calls it. Buddy has none. For this run the function was triggered once with `lambda` 0.03 (upstream's 0.01 leaves one memory below the 0.15 cold score). Buddy also has no superseded memory and none with `forgetAfter`, so **stages S and X were not exercised at full size**.
7. **The production windows move nothing on buddy.** The windows count project-active days, and buddy's projects have few: `cath-alert` 7, `plus-one-engine` 51, `t00th1e55` 18 (the rest 6 or fewer). `trim:14,obs:30` plans 0 rows. The proof used `trim:2,obs:4,sup:4,cold:4`, which plans 87,935 observations (24.6%).
8. **Only 1,327 of 3,094 sessions seal.** No summary 1,258, summary out of date 483, active 26. The rest of the store is invisible to retention.

## R3 is not proven here

The replica has no embedding provider, as asked. With none, `runtime.vector` is null and `activeVectorReader` answers "nothing to keep". So no vault entry holds a stored vector (`withStoredVector` 0 of 77,964), and a move removes the document's dense vector from Qdrant with the point. A restored document comes back keyword-only. Measured: live dense points 207,793 before run B, 172,082 after B and its restore, a loss of 35,711, the number of indexed observations B moved. Keyword search, the recall check and the vault are not affected. On a stack with a provider the vector store exists, and `readVectors` and `reattachDocument` run; that path has unit and small live tests (slice 2 and 4) but **no full-size run**. A dummy provider (`REPLICA_EMBEDDING_PROVIDER=voyage`, the internal network, no key) would build the vector store without egress; I did not do it because the brief said keyword-only. Do it before slice 13 on a store with vectors.

## Setup

| | |
|---|---|
| Host | 16 cores, 28 GB, Docker, cgroup v2 |
| Image | `am-ret:f188861` (`sha256:63dc10dc…`), `docker build -f deploy/Dockerfile` of the worktree. The R12 resume used `am-ret:f188861-fix1` (`sha256:6a4a640e…`): the same plus the diff above. |
| Backup | `/home/cownose/am-staging/buddy-2026-11-16` |
| Limits | agentmemory 2048m, Kvrocks 1280m, Qdrant 1g (the stack defaults, except agentmemory's 2560m) |
| Mode | `AM_SEARCH_BACKEND=disk`, `REPLICA_STORE=kvrocks`, no embedding provider, network internal |
| Load | `replica.sh valkey` 78 s: 3,725 hashes, 1,166,246 records copied in 14 s, `VERIFY OK` |
| Fill | `search-migrate fill` 253.6 s (421.1 s the second time, after the Qdrant volume was wiped): 229,564 docs, 207,793 vectors, `VERIFY OK`, 0 embedding calls |
| Boot | 10 s to ready |
| Store | 3,094 sessions, 357,592 observation rows (228,716 indexed), 760 memories, 88 lessons, 1,810 summaries, 8 projects in the plan |
| Settings | `AM_RETENTION=enforce`, `AM_RETENTION_WINDOWS=trim:2,obs:4,sup:4,cold:4`, `AM_RETENTION_GRACE_DAYS=30` (1 for the grace run), `AM_RETENTION_INTERVAL_MS=0`, `AGENTMEMORY_AUDIT_RETENTION_MONTHS=13`, `MAX_OBS_PER_SESSION=5000` |
| Golden cases | 8 cases (`g-O-1` to `g-O-3`, `g-T-4`, `g-C-5` to `g-C-8`), one evidence id each, all at rank 1 on keyword search. Evidence comes from the dry run's planned samples. The file is private (it holds buddy's text) and is not committed; `golden-cases.ts` builds it. |
| Staging steps | `mem::retention-score` with `lambda` 0.03 (finding 6). `enforced-runs` deleted from `mem:retention:control` before runs B, r9b and F, so each is a first run with the 10% cap. |

```
export AM_IMAGE=am-ret:f188861
bench/fork/retention/stage.sh load        # Valkey load, copy to Kvrocks, verify
bench/fork/retention/stage.sh fill        # Qdrant, search-migrate fill and verify
S12_RETENTION=enforce S12_WINDOWS=trim:2,obs:4,sup:4,cold:4 S12_GRACE_DAYS=30 S12_INTERVAL_MS=0 \
  S12_RECALL_CASES=/retention-cases/cases.json bench/fork/retention/stage.sh app
docker cp bench/fork/retention/score-memories.mjs tee1158s12-agentmemory-1:/opt/agentmemory/
docker exec -e S12_LAMBDA=0.03 -w /opt/agentmemory tee1158s12-agentmemory-1 node score-memories.mjs
```

The plan at these windows (the same in every run): **O 87,935 rows (203.7 MB), T 44,017 (40.9 MB), C 381 (0.7 MB), S 0, X 0**. Protection hits: `cited-by-graph` 4,057 (counted, not a veto), `retrieved` 1,938, `deliberate-save` 221, `memory-type` 84, `lesson` 88. The first-run cap is 35,759 observations, `floor(0.1 × 357,592)`.

## 1. R1, dry run

`stage.sh run bench/fork/retention/dry-run.ts` (run `ret_mwytv8qa_cbc39b4da7ba`). It records the counts, calls `POST /agentmemory/retention/sweep {"dryRun":true}` with the replica's secret, records them again and compares.

| | Before | After |
|---|---|---|
| User scope families / records | 30 / 1,175,279 | 30 / 1,175,279, **0 differ** |
| Qdrant `agentmemory`: points / live / live dense | 229,476 / 229,476 / 207,793 | same |
| Qdrant `agentmemory_lessons` / `_images` | 88 / 0 | same |
| Bookkeeping (allowed) | `mem:audit:<month>` 4,115, `mem:retention:reports` 3, `runs` 3 | 4,121, 4, 4 |
| Report fields missing | | **0** (`report-check.ts`: every stage, signal and refusal key) |
| Wall time | | 308 s (the route answered 504 at 180 s; the run closed at 308 s) |

A second dry run (`ret_mwzf7yb6_988ad08affc4`, after the restores) took 245 s and again changed no user scope or index count.

The user scopes (before = after): `mem:idx:obs:<shard>` 357,594; `mem:obs:<session>` 357,592 (2,979 hashes); `mem:index:bm25:vec:<bucket>` 249,289; `mem:graph:retrieval-data` 148,945; `mem:retention` (scores) 15,096; `mem:semantic` 14,336; `mem:access` 9,423; `mem:graph:nodes` 4,418; `mem:graph:name-index` and `node-degree` 3,533; `mem:sessions` 3,094; `mem:obs-stats` 2,980; `mem:summaries` 1,810; `mem:image-refs` 1,349; `mem:graph:edges` 839; `mem:memories` 760; `mem:insights` 485; `mem:lessons` 88; `mem:procedural` 43; `mem:idx:project-sessions` 38; and 8 more of 17 or fewer records.

## 2. Memory peak

`bench/fork/retention/run-enforce.sh` restarts Kvrocks, Qdrant and agentmemory (a fresh `memory.peak`), records the boot peak, samples `memory.current`, anonymous and file bytes once a second (`sample-mem.sh`) and records `memory.peak` at the end. `memory.peak` counts page cache: **Qdrant's reads the container limit in every run, including at boot, and Kvrocks' in every enforcing run**, so the anonymous maximum is the figure that answers to an OOM kill. All values are MiB.

| Window | Wall | agentmemory peak / max anon | Kvrocks peak / max anon | Qdrant peak / max anon |
|---|---|---|---|---|
| After boot, before any sweep | | 423 to 493 / | 65 to 1,280 / | 1,024 / |
| **Dry run** (`ret_mwzf7yb6…`) | 245 s | 595 / 504 | 1,082 / 503 | 1,024 / 743 |
| First dry run (no sampler) | 308 s | 594 / n.a. | 779 / n.a. | 1,024 / n.a. |
| **Enforcing, first run, 10% cap** (B, `ret_mwywu2p5_4a7e68f2af6a`) | 1,062 s | 578 / 494 | 1,280 / 578 | 1,024 / 711 |
| Enforcing, grace run (F) | 983 s | 598 / 514 | 1,280 / 575 | 1,024 / 666 |
| Restore of B (item 5) | 496 s | 598 / 529 | 894 / 281 | 1,024 / 717 |
| Restore of the R12 run | 683 s | 661 / 591 | 1,280 / 567 | 1,024 / 815 |
| Forced R9 run with its restore (r9b) | 1,441 s | 695 / 607 | 1,280 / 606 | 1,024 / 790 |

No container was OOM-killed in any run. Agentmemory's peak is 28 to 34% of its 2 GiB in a sweep or a restore, so the 180 s timeout, not memory, is the limit at this size. Qdrant's anonymous peak of 815 MiB in the restore leaves 20% of its 1 GiB. The 1 GiB Qdrant limit is the margin to watch: a fill alone reached 816 MiB (TEE-1171).

## 3. R12, kill and resume

`bench/fork/retention/kill-resume.sh`, run `ret_mwzganlk_d654be895649` (a first run, cap 35,759). The run started at 12:45:32; at 12:53:10 (`phase=apply`, `held=10,036`, `moved.O=10,036`) the agentmemory container was killed with `docker kill`.

- **On f188861 the resume fails.** The first sweep call after the restart answered 500 (`missing field 'key'`) after 48.7 s. Triggering `mem::retention-sweep` inside the container gave the same error at 25.7 s and 59.1 s. The run stayed at `apply`, with `held` recounted to 10,081 by `recover()`, and its lease released. See finding 1.
- **With the fix** (`am-ret:f188861-fix1`) the next call resumed **the same run id**: `resumed: true`, `observationCap` 35,759, closed `kept` at 2026-11-27T21:36:24.9Z, 780 s after the call (13:23:25 to 13:36:25). Moved: T 42,205, O 35,759, C 62. The recall check kept it (100 to 100).
- The kill came 30 minutes before the resume, so the lease (stale after 5 min) did not stand in the way. How long a restart waits on a fresh lease was not measured: my script called `replica.sh wait` without `AM_IMAGE`, which returned at once, and the loop that should have retried on 409 ended. `kill-resume.sh` now waits through `stage.sh wait`, which sets `AM_IMAGE`, and stops with exit 4 when the replica is not ready; the lease gap stays unmeasured. From the code, a sweep called within 5 minutes of the kill answers `busy` and then takes over.

`vault-check.ts --run ret_mwzganlk_d654be895649 --baseline …/r12-before.json` pages every vault straight from Kvrocks (`HSCAN`) and the live scopes (`HEXISTS`):

| Check | Result |
|---|---|
| Vault entries (paged) / `HLEN` / `RunRow.held` | 77,964 / 77,964 / 77,964 (O 35,759, T 42,205) |
| Stage O, S, X item both live and in a vault | **0** (35,759 O entries, none live) |
| Entries with no locator in `mem:retention:items` | 0 |
| Conservation | live observations 321,833 + vaulted O 35,759 = baseline 357,592; memories 760 = 760 |
| Qdrant: sampled vaulted rows that are live points | 0 of 300 |
| Audit | six entries (seal, T, O, S, X, C), outcome `kept` |
| `state::list_keys` of the vault (adapter limit 500 ms) | 185, 172 and 160 ms at 77,964 keys. The app warns at 40,000 keys. |

Moved rows also gain 24,908 delete markers in `mem:capture:events:<shard>` (1 to 24,909); the restore removes them.

## 4. R9, forced recall loss

The 8 golden cases hit before every run. `strip-access.ts` waits for the run's before-score (`recall.verdict` = `pending` in the draft report), then deletes the access logs of the 8 evidence ids from `mem:access`, as if they had never been retrieved. Everything after that is the sweep's own work.

| | Run E (`ret_mwyu2ghd_eefe27d193ab`, REST) | Run r9b (`ret_mwzfdv22_72d2afd2f279`, direct trigger) |
|---|---|---|
| Start to close | 02:23:17 to 03:23:28 (60 min, with the failed in-sweep restore) | 12:20:02 to 12:44:03 (24 min) |
| Moved before the restore | T 42,206, O 35,759, C 68, held 77,965 | T 42,206, O 35,759, C 66 |
| After-check | failed: "golden recall case lost its evidence: g-C-5, g-C-6, g-C-7, g-C-8, g-O-1, g-O-2, g-O-3" | same list; recall@10 100 to 12.5, verdict `restore` |
| In-sweep restore | **died at its start** (`restored 0`), run left in `check-after` | restored 78,031 |
| Audit | `retention_restore` with `restored: 0` and the reason; later one with `restored: 78,033` from the route | `retention_restore` (restored 78,031), then six entries, each `outcome: restored`, `restored: true` |
| Report | outcome `restored`, but `why` overwritten (finding 4) | outcome `restored`, `why` = the loss reason, `restored.restored` 78,031 |
| Counts after | live rows 357,592, memories 760, vault 0 | same |

For r9b the user scopes after the restore equal those before in every family except `mem:access` (9,435 to 9,428: the 8 logs deleted, 1 recorded by the after-check). `vault-check.ts` passed: conservation exact, no vault left. Qdrant live points 229,476 before and after; live dense points 172,082 to 172,075 (the keyword-only effect above).

Not natural: finding 3. `T` (g-T-4) stays live by design, so it never lost its evidence.

## 5. Restore of a full run under the lease

`restore.ts` calls `POST /agentmemory/retention/restore {"runId":…}`, reads the lease from Kvrocks every 2 s, and every 20 s makes the calls that must be refused. The route answers 504 at 180 s; the wall time runs to the moment the lease is gone and `held` is 0.

| Run | Entries restored | Wall | Heartbeats seen | Longest gap | Oldest heartbeat | Competing calls |
|---|---|---|---|---|---|---|
| B (`ret_mwywu2p5…`) | 78,023 | **496 s** (12:04:55 to 12:13:11) | 87 changes | 3.6 s | 2.3 s | sweep dry run 409 ×9, second restore 409 ×9, purge 200 ×9 |
| R12 run (`ret_mwzganlk…`) | 78,026 | **683 s** (13:38:02 to 13:49:25) | 270 | 4.9 s | 4.2 s | 409 ×34, 409 ×34, purge 200 ×34 |
| E (unfinished run, after `recoverRun`) | 78,033 | 1,379 s | | | | |

- **The lease holds.** The restore beats it before every page (about every 200 entries), so a heartbeat is never more than 5 s old against the 300 s stale limit. The 100 s renewal timer was never needed. One owner (`restore-…`) held it throughout, and it was gone at the end.
- A sweep and a second restore answer **409 busy**. The purge answers 200 with nothing done: with no run past its grace it takes no lease, by design (`runPurge`). It was not refused because there was nothing to refuse.
- After each restore the user scopes equal the run's baseline except `mem:access` (+7 reads by the checks), the Qdrant live point count equals the baseline (229,476), and `vault-check.ts` reports no vault left.
- The sweep timer meeting a lease was not tested (the interval was 0, so no timer swept).

## 6. Pin on a real demoted memory

Run B demoted 64 memories (stage C: 381 planned, 305 held back by `deliberate-save` (221) or `memory-type` (84), 64 moved). `pin.ts` pins one through `POST /agentmemory/retention/pin`.

| | `mem_mshw5oql_d5778e437bf4` and `mem_msimoy25_b5dae1096d43` |
|---|---|
| Response | 200, `pinned`, `undemoted: true`, `vaulted: false` |
| Memory row | `retention.demotedAt` cleared; demote record deleted |
| Qdrant point | tombstoned (`deleted: true`) before; live after, once the docs outbox drained (10 s) |
| Search | the memory ranks 1 for its title |
| Embedding calls | 0: no provider, and the agentmemory log gained no embed line (8 before and after, all the zero-LLM start-up banner) |
| Vector | **not restored**: the point is keyword-only (`dense: false`), because the demote record held none (R3 section above) |

Restore by ref (`restore-refs.ts`, 3 indexable observations of B): `restored: 3`, `reembedNeeded: 0`, each point tombstoned before and live after.

## 7. Grace check, started

Run `ret_mwzimb9x_ea6167a7991d` (F): `AM_RETENTION_GRACE_DAYS=1`, a first run (cap 35,759), `kept`, recall 100 to 100, 983 s.

| | |
|---|---|
| `closedAt` | **2026-11-27T22:06:58.528Z** (14:06:58 PST) |
| `graceEndsAt` | 2026-11-28T22:06:58.528Z |
| Moved | T 42,205, O 35,759, C 62; `held` 77,964 = vault entries |
| `vault-check.ts` | pass; conservation exact; 0 sampled vaulted rows live in Qdrant |
| Sample | 10 indexable stage O observations in `/home/cownose/am-staging/s12/grace.json`, group A (5, restored at 23 h) and group B (5, purged at 25 h) |
| Replica | project `tee1158s12`, kept up. Agentmemory restarted at 2026-11-27T22:07:59Z so that its purge timer is aligned with the grace end. |
| **Purge timer** | daily from boot: first tick **2026-11-28T22:07:59Z**, 61 s after the grace ends, so it should purge the run by itself; the next ticks follow every 24 h |
| Lock | `/tmp/am-replica.lock` is held, owner file rewritten with the reason |

The sample refs at the start (`grace-check-start.json`): all 10 in the vault, none live, a locator for each, no purge tombstone, the Qdrant point tombstoned.

## Part 2: what to check at 23 h and 25 h

Run from the worktree (or any checkout of this branch) with `export AM_IMAGE=am-ret:f188861 REPLICA_PROJECT=tee1158s12`. `stage.sh run <script>` runs a script in the replica's client container; it reads `/private/…` from `/home/cownose/am-staging/s12`. The container must not be restarted before the 25 h check (a restart moves the purge timer). If the replica was torn down, Part 2 cannot be run.

R=ret_mwzimb9x_ea6167a7991d

**At 23 h: 2026-11-28T21:06:58Z (13:06:58 PST). The purge must do nothing and group A must restore.**

1. All 10 refs are still held:
   `bench/fork/retention/stage.sh run bench/fork/retention/refs-check.ts --file /private/grace.json` gives `inVault 10 of 10`, `liveRow false`, `locator true`, `purgeTombstone false`, `qdrantPoint tombstoned` for each.
2. Purge does nothing: `bench/fork/retention/stage.sh run bench/fork/retention/rest.ts POST /agentmemory/retention/purge '{"dryRun":false}'` gives `purged 0`, `runsEmptied 0`, `restoredBack 0`, `dropped 0`. (The run is not due yet, so it takes no lease.)
3. `…/report.ts --run $R` gives `held 77964`, `purgedAt null`.
4. Group A restores: `…/refs-restore.ts --file /private/grace.json --group A` gives status 200 and `restored 5`. Then `…/refs-check.ts --file /private/grace.json --group A` gives `liveRow true`, `inVault false`, `qdrantPoint live`. `report.ts --run $R` now gives `held 77959`.

**At 25 h: 2026-11-28T23:06:58Z (15:06:58 PST). The purge must have removed group B everywhere.**

1. The timer should have run at 22:07:59Z. `…/audit.ts --run $R` has a `retention_purge` entry, `…/report.ts --run $R` gives `held 0` and a `purgedAt` after 22:06:58Z. (If not: `rest.ts POST /agentmemory/retention/purge '{"dryRun":false}'` answers 504 after 180 s but runs on; poll `report.ts` until `purgedAt` is set. Put `sample-mem.sh run /home/cownose/am-staging/s12/purge-mem.tsv &` before it for the purge's memory peak, and `touch purge-mem.tsv.stop` after.)
2. Group B is gone: `…/refs-check.ts --file /private/grace.json --group B` gives `liveRow false`, `inVault false`, `locator false`, `purgeTombstone true`, `qdrantPoint tombstoned` (or `absent`).
3. Group A is untouched: `refs-check.ts --group A` still `liveRow true`.
4. The vault is gone: `…/vault-check.ts --run $R --baseline /private/b-peak-before.json` shows no vault in `perRun`; the baseline counts differ only by the rows the purge removed (live observations 321,833 + 5 restored = 321,838; the purge took the O entries, 35,759 − 5 rows, for good).
5. A purged observation leaves a tombstone: `mem:retention:tombstones` grows by the O entries purged (about 35,754). Memories (the 62 demoted) are never purged: `mem:retention:demoted` keeps its records.
6. The sample's search: `rest.ts POST /agentmemory/smart-search '{"query":"<a title from grace.json>","limit":10}'` does not return a group B id.

**Tear down** after the 25 h check: `bench/fork/retention/stage.sh down`, then `rm -rf /tmp/am-replica.lock`.

Not covered by this slice (listed in the architecture notes, still open): the facet scan cost per page of a purge, purge against a live image store (the buddy store has no image files), a sweep timer that meets a purge's lease, the purge's memory peak over a full vault (Part 2 can sample it), and the S and X stages at full size.

## Scripts

All in `bench/fork/retention/`, driven by `stage.sh` (which wraps `bench/fork/replica.sh`; that file gained a colon-separated `REPLICA_COMPOSE_EXTRA` and mounts a symlinked `node_modules`).

| Script | Does |
|---|---|
| `stage.sh`, `replica-retention.yml` | load, fill, app, restart-all, peaks, run; the retention overlay |
| `lib.ts`, `snapshot.ts`, `diff-snapshots.ts` | KV scope counts (RESP, `HLEN`), exact Qdrant counts, comparison |
| `dry-run.ts`, `report-check.ts` | R1 |
| `sweep.ts`, `report.ts`, `poll-run.ts`, `audit.ts` | sweeps through the route (polls past the 504), reports, run rows, audit |
| `run-enforce.sh`, `sample-mem.sh` | one run with fresh peaks, a 1 s memory sampler, snapshots, checks |
| `kill-resume.sh`, `vault-check.ts` | R12 and its checker |
| `golden-cases.ts`, `strip-access.ts` | R9 |
| `restore.ts`, `restore-refs.ts`, `pin.ts` | restore under the lease, by ref, the pin |
| `grace-sample.ts`, `refs-check.ts`, `refs-restore.ts`, `rest.ts` | the grace check and Part 2 |
| `score-memories.mjs`, `trigger.mjs` | `mem::retention-score`, and any iii function with no 180 s limit |
