# Retention architecture

Issue: TEE-1158, phase 1 (architecture and slice plan). Date: 2026-11-19.
Design: [retention-design.md](retention-design.md). Its section 9.1 holds the owner's decisions, and this document does not reopen them. Sketch: `src/fork/retention/` (types and signatures, bodies `not implemented`).

## Problem

Retention has to hide, trim and later delete observations and memories in both search modes. Three readers rebuild the index from the records, and none of them may bring back what retention removed:
- the memory-mode boot rebuild;
- the TEE-1169 docs reconciler and its re-embed loop;
- the TEE-1196 lessons and images reconciler.

Each of them decides "index this" from the KV record. Restore must not call the embedder (R3). Retention must also hold bounded memory on about 360k observations (R12), survive a crash at any step, and touch upstream files only at small seams.

Facts from the code that shape the design:
- `VectorStorePort.get` returns an identity token, not the vector, and the worker has no op that returns one.
- `restoreIndexEntries` re-embeds.
- `RemoteVectorStore.add` drops a vector whose rev the DocLedger does not know.
- The project session index keeps only the 50 newest sessions per project.
- `docOfRecord` and the boot rebuild check only `isLatest`, `title` and `content` on a memory, so they would re-index a demoted memory.

## Usage (caller's view)

```ts
// src/index.ts, once, after the search runtime exists
registerRetention(sdk, kv);

// in-process (the weekly timer and the REST handlers call the same functions)
await sdk.trigger({ function_id: "mem::retention-sweep", payload: { dryRun: true } });   // report only
await sdk.trigger({ function_id: "mem::retention-sweep", payload: { dryRun: false } });  // enforce
await sdk.trigger({ function_id: "mem::retention-restore", payload: { runId } });       // or { ids: [...] }
await sdk.trigger({ function_id: "mem::retention-pin", payload: { id, kind: "memory", who: "owner", reason: "runbook" } });

// src/functions/summarize.ts, at the top of mem::summarize
if (await summaryRebuildVetoed(sessionId)) return { success: true, unchanged: true, summary: existing };

// src/functions/remember.ts, at the end of mem::forget
await afterForget(kv, { observations: deletedObs, memories: deletedMemoryIds });
```

```http
POST /agentmemory/retention/sweep    {"dryRun": true}
POST /agentmemory/retention/restore  {"runId": "ret_..."} | {"ids": ["obs_..."]}
POST /agentmemory/retention/purge    {}
POST /agentmemory/retention/pin      {"id": "mem_...", "kind": "memory", "reason": "..."}
GET  /agentmemory/retention/report?runId=ret_...
```

Settings, parsed once: `AM_RETENTION=enforce`, `AM_RETENTION_WINDOWS=trim:45,obs:180,sup:180,cold:365`, `AM_RETENTION_GRACE_DAYS=30` and `AM_RETENTION_RECALL_CASES=<path>`. A stack without all of them is off (R15).

## Shape

**One table says what each stage does** (`STAGE_DISPOSITION`):

| Stage | Disposition | What readers see |
|---|---|---|
| T | trim | Only `source` goes to the vault. The row stays live and indexed. The summary fingerprint does not hash `source`, so it is unchanged. |
| O, S, X | trash | The row leaves its live scope, so every upstream reader, the reconciler and the boot rebuild see it as deleted. No reader learns a flag. |
| C | demote | The row stays in `mem:memories`, so export, the viewer and supersede lookups still see it (D6). It carries `retention.demotedAt`. One predicate, `hiddenFromIndex`, is applied by the boot rebuild, by `indexRecords` and by TEE-1169's `docOfRecord`, so neither a restart nor a reconcile re-adds it. |

**Per-run vault plus a locator.**
- A moved row goes to `mem:retention:vault:<runId>`, with snapshots of its satellites: the stored vector, the capture event, and the image embedding row when this row held the last live reference.
- `mem:retention:items` maps an item id to its run, so restore by id and erase by id are each one point read. A demote is a point read of `mem:retention:demoted`.
- Restore of a run pages one scope. Purge deletes a run's scope once it empties.
- Demote records are not purged, so they live in `mem:retention:demoted`, outside the vault.

**Satellite table.**
- `SATELLITES` lists everything that hangs off a row: the search index, the capture event, the observation-to-session index, the image, the session count, and per-id metadata.
- Soft delete walks the table one way and restore walks it back, so the two cannot drift apart. Purge runs `finalize`.
- Each verb is idempotent.
- The session count is assigned from `ObservationStats`, not incremented, so it converges after any replay (L4, R11).

**Ordering invariant (R12).**
- For the trash stages, the vault entry is written before the live row is deleted, and `take` is the last step of a restore or a purge. A crash can leave an item in both places, but never in neither. A trimmed row is live with its `source` in the vault by design. A demote writes its record, then the mark, then the index removals, so re-running it converges.
- `recoverRun` runs first on every resume and settles the doubles by row fingerprint. A row rewritten after the plan read it stays live.

**Restore never embeds (R3).** `reattachDocument` adds the keyword doc, then the stored vector, in one synchronous tick. The keyword doc comes first because the ledger must know the rev before the vector lands. Both ops ride the docs outbox, so the re-embed loop does not see the doc without its vector.

**Stored vectors.**
- A new optional `VectorStorePort.readVectors` reads stored vectors: `VectorIndex.get` in memory mode, and a new `search::read-vectors` worker op in disk mode.
- When a backend cannot read vectors, the sweep refuses to trash a row that has one and counts it in the report.

**The plan is a stream.**
- `planCandidates` yields one sealed session's rows (at most 5000) or one page of memories, with a cursor.
- Dry run, apply and resume read the same generator, and no plan is stored.

**Protection.**
- Protection signals are point reads, plus one paged pass per sweep over memories and insights into a `Set` of cited ids.
- Only `Protector.judge` mints `Cleared`, and `displace` accepts nothing else.
- Stages T and O need a `SealProof`, and stage S needs a `ChainProof`.

**The run is a state machine** over a persisted `RunRow`: seal, plan, check-before, apply, check-after, settle, done.
- The lease and an in-process keyed lock admit one sweep at a time.
- Dry run stops after plan.
- With no golden recall cases, the run is refused and reports only.
- A failed after-check calls `restoreRun` with its reason (R9).
- The first enforcing run caps stage O at 10% of observations.

**Explicit forget** keeps its immediate hard delete. It then calls `afterForget` once:
- marks graph items stale through the observation postings, by the cascade path;
- assigns session counts;
- erases any vault copy or demote record of the ids.

The call is visible at its one caller. Other delete paths keep their behaviour, and their fixes (L2 to L5) are separate commits.

**Lessons** are never candidates. Retention does not touch the lessons collection, and TEE-1196 treats a `deleted` lesson as not indexable.

**Images.**
- Soft delete takes the image out of search only when no other live row references the file. Live references are the ref count minus `mem:retention:image-holds`.
- In that case the embedding row moves to the vault and `images.remove` runs. TEE-1196 then sees no record and removes the entry instead of repairing it, and memory-mode vision search, which reads those rows, stops finding it.
- `decrementImageRef` runs once, at purge (R4).

**Interface depth.**
- Five iii functions, five REST routes and three seam calls hide the vault, the satellites, both modes, the stream, the lease and the recall check.
- No wire type reaches the public surface.

### Upstream seams

| File | Lines | What | Slice |
|---|---|---|---|
| `src/index.ts` | 2 | import and `registerRetention(sdk, kv)` | 1 |
| `src/state/schema.ts` | ~12 | `RETENTION_KV` re-exported under `KV` | 1 |
| `src/types.ts` | ~8 | audit operations `retention_seal`, `_soft_delete`, `_restore`, `_purge`, `_demote`; `Memory.retention?` | 1, 8 |
| `src/functions/summarize.ts` | ~4 | the veto call | 3 |
| `src/functions/remember.ts` | ~4 | `afterForget` and `eraseFromVault` in `mem::forget` | 9 |
| `src/functions/search.ts` | 2 | `hiddenFromIndex` in the rebuild and in `indexRecords` | 8 |
| `src/triggers/api.ts` | 2 | `registerRetentionTriggers` | 10 |

Fork-owned files outside `src/fork/retention/`:
- `src/fork/kv/scope-classes.ts`: about 11 lines.
- `src/state/search-ports.ts`: about 3 lines, `readVectors?`.
- The worker op in `protocol.ts`, `client.ts` and `worker/engine.ts`: about 60 lines.
- TEE-1169's `doc-of-record.ts`: 1 line.

## Synthesis decision

The architect runners were Sonnet 5.5 @high, DeepSeek V4.1 Flash and Codex GPT. The Codex seat produced nothing: its first run had a read-only sandbox, and its second run hit a 429 rate limit, so it was dropped. Muse Spark judged against a six-criterion rubric: no resurrection; crash safety; no data loss; footprint; reader load; test path. It scored Sonnet 23 and DeepSeek 24.

**Base: DeepSeek's stance.**
- A demote leaves the row in place, marks it, and one predicate gates indexing.
- Seams are explicit; there is no global hook.
- Settings that are not decided mean off.
- The sweep refuses to trash a row whose vector it cannot read.
- A run with no golden cases is report-only.

The judge chose the same base for the same reason: kept data stays visible to export and supersede.

**Grafted from Sonnet:**
- the symmetric satellite table, and `recoverRun` with a fingerprint check;
- the streamed plan with a cursor;
- the session count assigned from stats;
- branded proofs (`SealProof`, `ChainProof`, `Cleared`);
- image handling at soft delete;
- an R8 test that runs a reconcile pass and a boot rebuild after the sweep.

**Rejected:**
- **Sonnet's shelf** (cold memories moved out of `mem:memories`). Export (`export-import.ts` reads `KV.memories`), the viewer and supersede lookups would lose them, which breaks D6's "demote only" and goal G3.
- **Sonnet's `withErasureTap`** around every `kv.delete`. It is a hidden behaviour change for evict, import-replace and governance-delete, and the judge found it unsafe for evict and import wipes.
- **Sonnet's Bloom filter.** Memories number about 1% of observations, so a `Set` is enough. A `ponytail:` note marks the spill path.
- **DeepSeek's single trash scope keyed by item.** Purge and restore of a run would page all trash. The per-run vault plus the `items` locator keeps restore by id as one point read and makes purge delete one scope.
- **DeepSeek's release of images only at purge.** A soft-deleted observation's image stayed searchable for 30 days, and TEE-1196 would repair it.
- **DeepSeek's per-stack windows in code.** Env settings match how both stacks are configured. A missing setting is an undecided stack.

Both candidates left one gap: the re-embed race in disk mode. It is closed by the one-tick reattach, and the R3 test runs with the re-embed loop on.

## Tradeoffs accepted

- We accept about 4 KB of vector per trashed item in Kvrocks for 30 days, in exchange for restores that never embed.
- We accept three upstream seams for the demote predicate (`types.ts`, `search.ts` and TEE-1169's `docOfRecord`). In exchange, cold memories stay in export and supersede lookups.
- We accept recomputing the plan on resume, in exchange for storing no plan.
- We accept that a crash during purge can leak one image reference, in exchange for never freeing a file another row still uses.
- We accept that a forget during grace erases the vault copy through `eraseFromVault`, because upstream `mem::forget` cannot see a moved row.
- Trash is not part of `/export`, so a stack rebuilt from an export loses the restore window. See the open questions.

## Alternatives considered

- **An in-place `deletedAt` flag on observations and memories.** Every upstream reader and the stats wrapper would have to learn to skip it. It exposes the most complexity to callers.
- **Moving everything out of the live scopes, cold memories included.** Readers would need no predicate, but kept data would disappear from export and supersede lookups.
- **A KV-delete tap for erasure.** It touches one seam, but it changes behaviour on every delete path without the caller seeing it.
- **A stored plan in pages** (design 4.3). Resume is simpler, but a scope grows with the plan. The stream needs none.

## Points where the design, the ACs and the code disagree

1. **Design 4.5 and the AC agent notes reuse `restoreIndexEntries` for restore.** It re-embeds (`observe.ts:59-65`), which violates R3. Restore uses `reattachDocument` with the stored vector instead.
2. **Design 4.4 and note 5 say the trash vector is read "through the vector port".** The port returns an identity token only. A new `readVectors` port method and a `search::read-vectors` worker op are required. Design 10 says the worker does not change; it must change.
3. **Design 4.4 says a demote is recorded only in `mem:retention:demoted`.** The memory-mode boot rebuild (`search.ts:378`, `:631`) and TEE-1169's `docOfRecord` would re-add the memory. A row mark and the `hiddenFromIndex` predicate are needed. Design 10 says search code does not change; two lines in `search.ts` and one in `docOfRecord` must.
4. **Design 6 computes the project-active clock from the project session index.** That index keeps the 50 newest sessions per project (`session-index.ts:6`), too few for windows of 180 and 365 days. Retention keeps its own `mem:retention:active-days`.
5. **The brief requires soft deletes to reach the images collection.** Design 3 releases images only at hard delete, so the image of a soft-deleted observation would stay searchable for the whole grace period, and TEE-1196 would repair it. Soft delete therefore moves the embedding row when no other live row holds the file.
6. **Design 4.4 writes observation tombstones at soft delete.** Here the vault plus the `items` locator serve that role during grace, and the tombstone is written at purge. The provenance answer is the same.
7. **D8 sets audit retention to 13 months.** Both NR1 stacks run `AGENTMEMORY_AUDIT_RETENTION_MONTHS=1`, read on 2026-11-19. With a 30-day grace, the audit of a run would be dropped before its purge. The R15 rollout must raise it on main.
8. **D9 sets `MAX_OBS_PER_SESSION=5000`.** NR1 runs 2000 on main and 1000 on buddy. Raising main to 5000 on 2026-10-27 was reverted, because `mem::observe` then listed the whole session under its lock. The fork now reads `ObservationStats` at `observe.ts:201`, but R14's slice must time a 5000-row session before the config changes.
9. **Design 8 says to turn auto-forget off on the fork.** Both stacks run it daily (`AUTO_FORGET_ENABLED` unset, `AUTO_FORGET_INTERVAL_MS=86400000`), and its TTL clause hard-deletes expired memories with no grace. That overlaps stage X. Section 9.1 does not decide it.
10. **The importance-floor signal (≥ 8) never fires in production.** Both stacks run `AGENTMEMORY_AUTO_COMPRESS=false`, so every row has importance 5. R5's importance-9 case is fixture-only.
11. **AGENTS.md says "1,596+ tests" and "Current Stats (v0.9.29)".** The suite has about 5,000 tests on v0.9.33.

## Slice plan

Each slice is one PR against `disk`, at most about 800 changed lines, with its tests in `test/fork/retention/`. "Unmerged" names work that must land first.

| # | Slice | Proves | Tests | Upstream seams | Unmerged deps |
|---|---|---|---|---|---|
| 1 | Foundation: scopes, scope classes, audit ops, settings parser, `Vault`, run row and lease, `registerRetention` wired off by default | R15 (off part), R14 | Settings table test, and with no decided windows a sweep is a no-op. A 1,000-row session stores all rows with the cap at 5000, and a 5000-row session captures within the old latency. | `index.ts` 2, `schema.ts` ~12, `types.ts` ~6 | none |
| 2 | Stored-vector read: `readVectors` port method, memory implementation, `search::read-vectors` op | prerequisite for R3 | Unit tests for both modes; a live-Qdrant test that round-trips an exact vector | none (fork files) | none |
| 3 | Seal, active-day clock, summarize veto | R7, the seal half of R2 | Table tests for `judgeSeal` over the four R2 sessions; R7 byte-identical summary after a trim and soft delete; clock tests with 51 or more sessions | `summarize.ts` ~4 | none |
| 4 | Move core: satellites (index, capture event, session index, session count), `displace`, `reinstate`, `recoverRun` for stages T, O and X; `restoreRun` and `restoreItems` | R3, R11, R8 (replay), R12 (crash half) | R3 in both modes with an embedding spy at 0 and the re-embed loop on; crash injected after each step and then `recoverRun`; capture replay after a sweep; stats count equals rows | none | 2, 3; the disk-mode reconcile assertion of R8 needs TEE-1169 merged |
| 5 | Protection and plan: `Protector`, `planCandidates`, stage S chain proof | R2, R5, R6 | Fixtures with zero windows: the four R2 sessions; the six R5 items, each under its signal; R6 supersede, then plan and move | none | 3, 4 |
| 6 | Sweep state machine, report, audit; recall check and auto-restore | R1 (fixture), R9, R13 (sweep half), R12 (resume half), the 10% cap | A dry run leaves every user scope and index size unchanged, and the report has every field; a forced golden loss triggers `restoreRun`, recorded in audit and report; resume from the cursor; one audit entry per run and stage | none | 4, 5 |
| 7 | Purge, grace, images and tombstones | R4, R13 (purge) | Injected clock: restorable at 23 h, gone from KV, vault and both indexes at 25 h; a shared image file survives while one file-only referrer is removed; protection is re-checked at purge | none | 4; the disk image-reconcile assertion needs TEE-1196 merged |
| 8 | Demote (stage C) | stage C of the design (D6), R8 for demote | Demote, then boot rebuild and a reconcile pass: not re-added; un-demote restores without embedding; export still contains the memory | `types.ts` `Memory.retention?` ~2, `search.ts` 2, `doc-of-record.ts` 1 | TEE-1169 merged (for `docOfRecord`) |
| 9 | Explicit forget: `afterForget`, `eraseFromVault` | R10, R11 (forget) | Forget an observation cited by a node and an edge: gone from KV and both indexes with no grace, graph items stale and not returned; forget during grace erases the vault copy | `remember.ts` ~4 | 1 (vault) |
| 10 | REST endpoints, pins, timers, docs | R13 (end to end), the pin endpoint (D3) | Endpoint auth and field whitelist; a pinned item survives; `docs:sync` counts | `api.ts` 2, README and plugin counts per AGENTS.md | 6, 7 |
| 11 | Upstream-able fixes, one commit each: L2 evict orphans, L5 auto-forget index removal, lesson recall records access | supports G2 and the near-duplicate rule in design 5.4 | One failing-then-passing test per fix | `evict.ts`, `auto-forget.ts`, `lessons.ts` | none; can run in parallel with anything |
| 12 | Staging proof on a replica (takes the replica lock) | R1, R4, R9 and R12 at full size | Dry run on a staging copy with collection counts and index sizes before and after; memory peak sampled during a full sweep; a kill mid-sweep, then resume; a one-day grace observed at 23 h and 25 h; a forced recall loss | none (bench scripts) | 1 to 10 merged; TEE-1169 and TEE-1196 merged |
| 13 | First production run (owner) | R15 | Owner sets main's env; see the rollout below | none | 12, and the owner's answers below |

Rollout for slice 13, on main only. Set:
- `AM_RETENTION=enforce`, with the D1 windows, grace 30 and the recall-cases path;
- `AGENTMEMORY_AUDIT_RETENTION_MONTHS=13` (D8);
- `MAX_OBS_PER_SESSION=5000` on both stacks (D9);
- auto-forget per open question 1.

Buddy keeps retention unset.

## Open questions and risks

1. **Owner.** Once retention is on, should auto-forget be turned off on main (`AUTO_FORGET_ENABLED=false`), as design 8 recommends? Its TTL and observation clauses hard-delete with no grace. Should buddy, where retention stays off, keep it?
2. **Owner.** Which golden recall cases does main's recall check use, and may that private file be mounted on the NR1 stack? Without cases, every run is report-only. That would conflict with D4's "enforce from the first sweep".
3. **Owner.** Trash is not part of `/export`. Is it acceptable that a stack rebuilt from an export loses the 30-day restore window? Kvrocks-level backups keep it.
4. **Risk.** A writer that rebuilds a `Memory` object from scratch could drop `retention.demotedAt` and so un-demote a memory. Slice 8 pins this against `mem::remember`, consolidate and import.
5. **Risk.** The 10% cap counts stage O only, because R15 names observations. Memory stages are uncapped.

## Implementation reconciliation

Each slice records its accepted deviations here before handing off.

**Slice 1 (foundation).**
- `run-store.ts` is new. It holds `newRunRow`, `RunStore` (run rows) and the sweep lease with its heartbeat, because the sketch had no home for them.
- The `KV` keys are `retentionVault`, `retentionItems` and so on, one line each in `schema.ts` that points at `RETENTION_KV`. Bare names such as `items` or `runs` would be ambiguous in the shared `KV` object.
- The settings parser rejects a window or a grace of 0. The sketch said "a whole number", but 0 would delete everything eligible at once or leave no restore window. Tests reach zero windows through `windowsOverride`, which the REST layer does not accept.
- `registerRetention` registers only `mem::retention-sweep` and starts no timer. Its deps say `vectors.canRead: false` and its recall harness throws, so an enforcing build before slices 2 and 6 cannot trash a row. Slices 2 and 6 replace both.
- `Vault.put` and `Vault.take` do not touch `RunRow.held`; the sweep and purge own that counter, and `runsHolding` reads it. `take` deletes the locator first, and only when it still names the run, so a later run's claim on the same id survives.
- A trim entry and a later stage O entry for one observation share a key, so each lands in its own run's scope and the locator names the later run. Slice 4 must restore a trim by run, or key the locator by stage.
- R14 (open risk 8): the fork's capture path reads `ObservationStats`, not the session. In-process timing with the cap at 5000: median 0.64 to 0.86 ms per `mem::observe` from 100 to 4,900 rows, against 1.3 ms to 26 ms for the upstream path that lists the session. The config change to 5000 on the stacks is still the owner's step in slice 13.

## Next implementation step

Slice 1: the foundation scopes, the settings parser and the vault, so that slices 2, 3 and 9 can start in parallel.
