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
await sdk.trigger({ function_id: "mem::retention-restore", payload: { runId } });       // or { refs: [...] }
await sdk.trigger({ function_id: "mem::retention-pin", payload: { ref: { kind: "memory", id }, who: "owner", reason: "runbook" } });

// src/functions/summarize.ts, at the top of mem::summarize
if (await summaryRebuildVetoed(sessionId)) return { success: true, unchanged: true, summary: existing };

// src/functions/remember.ts, at the end of mem::forget
await afterForget(kv, { observations: deletedObs, memories: deletedMemoryIds });
```

```http
POST /agentmemory/retention/sweep    {"dryRun": true}
POST /agentmemory/retention/restore  {"runId": "ret_..."} | {"refs": [{"kind": "observation", "sessionId": "ses_...", "id": "obs_..."}]}
POST /agentmemory/retention/purge    {}
POST /agentmemory/retention/pin      {"ref": {"kind": "memory", "id": "mem_..."}, "reason": "..."}
GET  /agentmemory/retention/report?runId=ret_...
```

These routes fail closed. `checkAuth` allows a call when no secret is set, and sweep, purge and restore delete data. With `AGENTMEMORY_SECRET` unset, the routes are not registered or return 503 through `requireConfiguredSecret`.

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
- `mem:retention:items` maps an item key to its run, so restore by ref and erase by ref are each one point read. A demote is a point read of `mem:retention:demoted`.
- The key is `itemKey(ref)`, not the bare id. Observation ids repeat across imported sessions (see disagreement 12), so the session is part of every key for an observation: vault entries, locators, tombstones and pins.
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
- `planCandidates` yields one page of a sealed session's rows, or one page of memories, with a cursor. The cursor records progress inside a session, so a session of any size is walked in pages. Imported sessions bypass `MAX_OBS_PER_SESSION`, so no bound assumes a small session.
- Sealing is paged too: `readSessionFacts` computes the summary fingerprint piece by piece, so `judgeSeal` is pure over a few facts and never sees the rows.
- Dry run, apply and resume read the same generator, and no plan is stored.

**Protection.**
- Protection signals are point reads, plus one paged pass per sweep over memories and insights into a `Set` of cited ids.
- Only `Protector.judge` mints `Cleared`, and `displace` accepts nothing else.
- `createProtector(kv, windows, clock)` takes the sweep's `supersededDays` (which superseded memories still cite) and `coldDays`, and the active clock. The `retrieved` signal compares the access time with `clock.cutoffForActiveDays(project, coldDays)`, so it counts project-active days, not wall-clock days. The clock's boundary rules are pinned in `clock.ts`.
- Purge re-checks protection with `Protector.recheck`. The caller builds one Protector per purge pass from the current settings' windows.
- Stages T and O need a `SealProof`, and stage S needs a `ChainProof`.

**The run is a state machine** over a persisted `RunRow`: seal, plan, check-before, apply, settle, check-after, done. Settle drains the docs outbox before the recall check reads the index.
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
- Soft delete takes the image out of search only when no other live row references the file. Live references are the ref count minus the holders in `mem:retention:image-holds`.
- In that case the embedding row is parked in the hold record and `images.remove` runs. TEE-1196 then sees no record and removes the entry instead of repairing it, and memory-mode vision search, which reads those rows, stops finding it.
- `decrementImageRef` runs once per purged item, at purge (R4), with `imageReleased` written first.

**Interface depth.**
- Five iii functions, five REST routes and three seam calls hide the vault, the satellites, both modes, the stream, the lease and the recall check.
- No wire type reaches the public surface.

### Upstream seams

| File | Lines | What | Slice |
|---|---|---|---|
| `src/index.ts` | 2 | import and `registerRetention(sdk, kv)` | 1 |
| `src/state/schema.ts` | ~12 | `RETENTION_KV` re-exported under `KV` | 1 |
| `src/types.ts` | ~9 | audit operations `retention_seal`, `_soft_delete`, `_restore`, `_purge`, `_demote`, `_pin`; `Memory.retention?` | 1, 8, 10 |
| `src/functions/summarize.ts` | ~4 | the veto call | 3 |
| `src/functions/remember.ts` | ~11 | one `afterForget` call in `mem::forget`, a ref list for the rows it deletes, and the reconciliation of ids it did not find live | 9 |
| `src/functions/search.ts` | 2 | `hiddenFromIndex` in the rebuild and in `indexRecords` | 8 |
| `src/triggers/api.ts` | 9 | import, `registerRetentionTriggers`, the five `registerTrigger` lines, and `export` on `requireConfiguredSecret` | 10 |

Fork-owned files outside `src/fork/retention/`:
- `src/fork/kv/scope-classes.ts`: about 12 lines, one per retention scope, `sweepScratch` included.
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

12. **Observation ids are not globally unique, so bare-id keys would collide.** Native captures mint unique ids (`generateId("obs")`, or `observationIdFor` from a hash that includes the session id). Imported sessions do not. The jsonl replay builds ids with `fingerprintId("obs", entry.uuid ...)` in `jsonl-parser.ts:149`, from the transcript's own `uuid` with no session in the hash, and a resumed or forked Claude Code transcript repeats earlier uuids under a new session id. Export import (`export-import.ts:595`) writes any string id under the session it names. Two sessions can therefore hold the same observation id. The sketch keys items, vault entries, tombstones and pins by `itemKey(ref)`, which includes the session. A citation from a graph node or memory holds a bare id, so the tombstone lookup for it needs the citing record's session ids.
13. **Design 10 names two scopes differently.** It lists `mem:retention:trash:<run>` and `mem:retention:runs:<run>` with the plan stored per run. The sketch uses `mem:retention:vault:<runId>` and one bounded `mem:retention:runs`, with the plan as a stream. Section 10 of the design carries a note.

## Slice plan

Each slice is one PR against `disk`, at most about 800 changed lines, with its tests in `test/fork/retention/`. "Unmerged" names work that must land first.

| # | Slice | Proves | Tests | Upstream seams | Unmerged deps |
|---|---|---|---|---|---|
| 1 | Foundation: scopes, scope classes, audit ops, settings parser, `Vault`, run row and lease, `registerRetention` wired off by default | R15 (off part), R14 | Settings table test, and with no decided windows a sweep is a no-op. A 1,000-row session stores all rows with the cap at 5000, and a 5000-row session captures within the old latency. | `index.ts` 2, `schema.ts` ~12, `types.ts` ~6 | none |
| 2 | Stored-vector read: `readVectors` port method, memory implementation, `search::read-vectors` op | prerequisite for R3 | Unit tests for both modes; a live-Qdrant test that round-trips an exact vector | none (fork files) | none |
| 3 | Seal, active-day clock, summarize veto | R7, the seal half of R2 | Table tests for `judgeSeal` over the four R2 sessions; `readSessionFacts` fingerprint equals `summaryFingerprint` on a session larger than one page; R7 byte-identical summary after a trim and soft delete; clock tests with 51 or more sessions, and the boundary cases (a timestamp on a day edge, `since`'s own day, an empty project, the cutoff for 0 days and for more days than exist) | `summarize.ts` ~4 | none |
| 4 | Move core: satellites (index, capture event, session index, session count), `displace`, `reinstate`, `recoverRun` for stages T, O and X; `restoreRun` and `restoreItems` | R3, R11, R8 (replay), R12 (crash half) | R3 in both modes with an embedding spy at 0 and the re-embed loop on; crash injected after each step and then `recoverRun`; capture replay after a sweep; stats count equals rows | none | 2, 3; the disk-mode reconcile assertion of R8 needs TEE-1169 merged |
| 5 | Protection and plan: `Protector`, `planCandidates`, stage S chain proof | R2, R5, R6 | Fixtures with zero windows: the four R2 sessions; the six R5 items, each under its signal; R6 supersede, then plan and move | none | 3, 4 |
| 6 | Sweep state machine, report, audit; recall check and auto-restore | R1 (fixture), R9, R13 (sweep half), R12 (resume half), the 10% cap | A dry run leaves every user scope and index size unchanged, and the report has every field; a forced golden loss triggers `restoreRun`, recorded in audit and report; resume from the cursor; one audit entry per run and stage | none | 4, 5 |
| 7 | Purge, grace, images and tombstones | R4, R13 (purge) | Injected clock: restorable at 23 h, gone from KV, vault and both indexes at 25 h; a shared image file survives while one file-only referrer is removed; protection is re-checked at purge | none | 4; the disk image-reconcile assertion needs TEE-1196 merged |
| 8 | Demote (stage C) | stage C of the design (D6), R8 for demote | Demote, then boot rebuild and a reconcile pass: not re-added; un-demote restores without embedding; export still contains the memory | `types.ts` `Memory.retention?` ~2, `search.ts` 2, `doc-of-record.ts` 1 | TEE-1169 merged (for `docOfRecord`) |
| 9 | Explicit forget: `afterForget`, `eraseFromVault` | R10, R11 (forget) | Forget an observation cited by a node and an edge: gone from KV and both indexes with no grace, graph items stale and not returned; forget during grace erases the vault copy | `remember.ts` ~4 | 1 (vault) |
| 10 | REST endpoints, pins, timers, docs | R13 (end to end), the pin endpoint (D3) | Endpoint auth and field whitelist; a pinned item survives; `docs:sync` counts | `api.ts` 9 (see the slice 10 note), README and plugin counts per AGENTS.md | 6, 7 |
| 11 | Upstream-able fixes, one commit each: L2 evict orphans, L5 auto-forget index removal, lesson recall records access | supports G2 and the near-duplicate rule in design 5.4 | One failing-then-passing test per fix | `evict.ts`, `auto-forget.ts`, `lessons.ts` | none; can run in parallel with anything |
| 12 | Staging proof on a replica (takes the replica lock) | R1, R4, R9 and R12 at full size | Dry run on a staging copy with collection counts and index sizes before and after; memory peak sampled during a full sweep; a kill mid-sweep, then resume; a one-day grace observed at 23 h and 25 h; a forced recall loss | none (bench scripts) | 1 to 10 merged; TEE-1169 and TEE-1196 merged |
| 13 | First production run (owner) | R15 | Owner sets main's env; see the rollout below | none | 12, and the owner's answers below |

Slice notes:
- Slices 1 to 11 are done. Slice 3: `setSummarizeVeto` now throws on a second registration, and `resetSummarizeVeto` clears it for tests. See the reconciliation below.

Rollout for slice 13, on main only. Set:
- `AM_RETENTION=enforce`, with the D1 windows, grace 30 and the recall-cases path;
- `AGENTMEMORY_AUDIT_RETENTION_MONTHS=13` (D8);
- `MAX_OBS_PER_SESSION=5000` on both stacks (D9);
- auto-forget per open question 1.

Buddy keeps retention unset.

## Open questions and risks

1. **Decided (owner, 2026-11-19).** Auto-forget stays on, on both stacks, alongside retention. Design 8's recommendation to turn it off is not taken.
2. **Decided (owner, 2026-11-19).** Main gets its own private golden recall set, built from main's data the way buddy's was for TEE-1155, mounted on main's NR1 stack only.
3. **Decided (owner, 2026-11-19).** Leaving the trash out of `/export` is acceptable. Restores that need the trash come from the nightly Kvrocks backup.
4. **Risk.** A writer that rebuilds a `Memory` object from scratch could drop `retention.demotedAt` and so un-demote a memory. Slice 8 pins this against `mem::remember`, consolidate and import.
5. **Risk.** The 10% cap counts stage O only, because R15 names observations. Memory stages are uncapped.

**Owner decisions, 2026-11-27.**
- Buddy uses main's windows and grace: trim raw `source` at 45 project-active days, observations 180, superseded memories 180, cold memories demoted at 365, grace 30 days. Retention turns on for buddy as well as main.
- Deliberate save keeps the narrow reading: a latest memory with `origin.channel` user or agent is never demoted; a consolidated or imported memory can be.
- AC6 means graph items from deleted observations. Forgetting a memory marks no graph items.
- Sessions without a project never age. Accepted; the first run reports how many there are.
- Observations keep their bare-id access log and facets at purge. Accepted.
- Pinning a vaulted item does not restore it at once; purge restores it at the end of grace. Accepted.

## Implementation reconciliation

Each slice records its accepted deviations here before handing off.

**Slice 1 (foundation).**
- `run-store.ts` is new. It holds `newRunRow`, `RunStore` (run rows) and the sweep lease with its heartbeat, because the sketch had no home for them.
- The `KV` keys are `retentionVault`, `retentionItems` and so on, one line each in `schema.ts` that points at `RETENTION_KV`. Bare names such as `items` or `runs` would be ambiguous in the shared `KV` object.
- The settings parser rejects a window or a grace of 0. The sketch said "a whole number", but 0 would delete everything eligible at once or leave no restore window. Tests reach zero windows through `windowsOverride`, which the REST layer does not accept.
- `registerRetention` registers only `mem::retention-sweep` and starts no timer. Its deps say `vectors.canRead: false` and its recall harness throws, so an enforcing build before slices 2 and 6 cannot trash a row. Slices 2 and 6 replace both.
- After the sketch ocr round, `Vault.locate`, `get` and `take` take an `ItemRef`, and every vault and locator key is `itemKey(ref)`. `ItemLocator` no longer holds a session id, because the ref carries it. `retentionSweepScratch` is a `KV` key and is classified `paged-only`, though nothing reads it before slice 5.
- `Vault.put` and `Vault.take` do not touch `RunRow.held`; the sweep and purge own that counter, and `runsHolding` reads it. `take` deletes the locator first, and only when it still names the run, so a later run's claim on the same id survives.
- A trim entry and a later stage O entry for one observation share a key, so each lands in its own run's scope and the locator names the later run. Slice 4 must restore a trim by run, or key the locator by stage.
- R14 (open risk 8): the fork's capture path reads `ObservationStats`, not the session. In-process timing with the cap at 5000: median 0.64 to 0.86 ms per `mem::observe` from 100 to 4,900 rows, against 1.3 ms to 26 ms for the upstream path that lists the session. The config change to 5000 on the stacks is still the owner's step in slice 13.

**Slice 2 (stored-vector read).**
- `VectorStorePort.readVectors?` returns `ReadonlyMap<string, Float32Array>`; `vectorReaderFor` encodes it to the base64 the `VectorReader` contract keeps. It rejects when the backend cannot answer, so an unreadable vector never looks like a row with no vector. `read` on a reader with `canRead: false` also rejects.
- Memory mode needed a 7-line `VectorIndex.readVectors` in `src/state/vector-index.ts`, which the fork-owned list did not name; `VectorIndex` is the memory runtime's port, so there is no other place for it.
- Disk mode returns what Qdrant holds, not what the provider returned. The collection is cosine at float16, so a vector comes back normalized to unit length and rounded to float16. It ranks the same, and writing it back stores the same bytes, so restore is a fixed point after the first trash. "Exact" holds in memory mode, and in disk mode for the stored bytes. The live test pins both: a unit vector float16 holds comes back bit for bit, and an arbitrary one comes back normalized within 2^-10 relative.
- `register.ts` uses `activeVectorReader(getSearchRuntime)`, which calls `vectorReaderFor` on the vector store at each use. Built once at registration, a reader would see no store if the runtime did not exist yet, and a null store reads as "nothing to keep".
- `search::read-vectors` reads at most 1000 ids per call and rejects more, so an absent id always means no stored vector, and the client asks 200 at a time, about 1 MB at 1024 dimensions. It drains the docs outbox first, so a vector added a moment ago is readable.

**Slice 3 (seal, clock, veto).**
- The veto is read before summarize generates, so a stage O delete can land while a rebuild is in flight. summarize's publish step re-checks the fingerprint under `obs:<sessionId>` and drops the rebuild as `source_changed`, which closes the race only if slice 4 deletes stage O rows and sets `trimmed` under that same lock. Slice 4 must, and should pin it with a test. `sealSession` takes the lock itself, so the sweep must not call it while holding the lock.
- `SealRefusal` gains `"no-session"`, for a session deleted between listing and sealing. `sealSession` returns it and leaves no seal.
- `judgeSeal` keeps an existing seal that still matches (same fingerprint and row count) as the same object, so sealing twice keeps the first `sealedAt`. `sealSession` deletes a seal on any refusal and writes only a new or changed one. `graphExtracted` is written `false`: nothing records that graph extraction ran, and nothing reads the flag yet.
- `readSessionFacts` takes `allCompressed` from `needsCompression` (compression-state.ts): a pending or failed row, or a raw row with no title, counts as awaiting. It reads the rows twice, once for order and timestamps, once to hash in order. A row that changed or vanished between the passes gives an empty `summaryFingerprint`, which matches no summary.
- `loadActiveClock` unions the days from the sessions pass with the stored `mem:retention:active-days`, so a deleted session's day stays active. A project with no session left reads as empty (age 0), the safe side.
- The veto is `trimmedSealVeto(kv)`, one point read of the seal. `registerRetention` registers it in every mode and a second `registerRetention` in one process throws. `mem::summarize` falls through to its normal path when the veto holds but no summary is stored.

**Slice 4 (move core).**
- Done: the four satellites (search index, capture event, observation-to-session index, session count), `displace`, `reinstate` and `recoverRun` for stages T, O, S and X (S and X share one code path), `restoreRun`, `restoreItems`, `reattachDocument`. Left for later slices: the image and metadata satellites (slice 7), `reinstateDemote`, the demote branch of `displace` and `recoverRun`, and restore of demotes (slice 8). Each throws `not implemented: slice 8`.
- **A trim and a later stage O share a key: the locator stacks.** Restore by run only was rejected, because stage O's `put` overwrote the trim's locator, so restore or forget by ref could not find the raw source. `ItemLocator.under` keeps the claim it replaced (one level, which is all T then O can stack). `Vault.take` pops it back, so after a restore of the O entry the ref locates the trim. `restoreItems` walks a ref newest first and gives back the whole row. `restoreRun` restores the entries of that run only. A trim entry whose row is not live is deferred and stays held, never dropped, because dropping it would lose the raw source while the row sits in a later run's vault. Slice 9's `eraseFromVault` must walk both claims (`locate`, then `under`).
- **`reinstate` writes `restoring` on the entry before its first change.** After a crash the row can be live with the entry still held either way round, a move before its delete or a restore before its take, and the fingerprint is equal in both. Only the flag tells recoverRun to finish a restore and not delete the restored row again. `Vault.update` rewrites an entry without touching the locator, and `Vault.relocate` repairs a locator lost between the two writes of `put`, which recoverRun calls for every entry it visits.
- **Locks.** Stage O deletes the row and sets `seal.trimmed` under `withKeyedLock("obs:<session>")`, the lock summarize publishes under. A memory move holds `"mem:remember"`, the lock `mem::remember` and `mem::forget` write memories under. Detach runs inside the same hold, so a move is one step to every writer of the row. `reinstate` takes it per item, `recoverRun` per entry (locator repair, settle or finish-restore in one hold, from the entry re-read once the lock is held, so an entry a restore took since the page was read is skipped), and `restoreItems` per ref (locator reads, stale-claim cleanup and each reinstate in one hold, one visit per run id). The keyed mutex is not reentrant, so a holder calls `reinstateLocked`, never `reinstate`. Nothing inside calls `sealSession`. Satellite snapshots are taken inside the lock, from the row re-read there, so the vault holds the state that is deleted; a session being moved has ended, so holding `obs:<session>` across the vector read (a network call in disk mode) is acceptable. A rejecting read returns `unreadable` from inside the lock. `Vault.relocate` puts a recovered entry under a head that is a later move (by `movedAt`), so a lost locator never inverts the newest-first stack.
- **Refusal.** A snapshot that rejects makes `displace` return `{ moved: false, skipped: "unreadable" }` with no write, since a rejected vector read is not "no vector". `displace` also returns `row-changed`, `gone` and `nothing-to-trim`. `ReinstateResult` has `deferred`, and `RestoreResult` has `deferred` too.
- **Observation ids repeat across sessions** (disagreement 12), and the index holds one doc per id. A doc another session owns is not snapshotted, removed or overwritten, and the observation-to-session index entry is removed only while it names this session and added only when empty.
- **Held count.** `displace` does not touch `RunRow.held`. `restoreRun` and `restoreItems` lower it (clamped at 0) and `restoreRun` sets `restoredBecause`. The sweep must re-read the run row after calling `restoreRun`, and must add the moved count to `held` itself.
- **Index persistence.** A detach and an attach call `runtime.openPersistence().scheduleSave()` (the port, a no-op in disk mode), not `scheduleIndexSave` from `functions/search.ts`: importing that module drags `hybrid-search` and `reranker` into `tsconfig.fork.json`, whose upstream type errors fail `fork-tripwires`. `mem::forget` flushes after a delete; the sweep should flush once at settle (slice 6).
- **Audit.** `restoreRun` and `restoreItems` write one `retention_restore` entry each, through `safeAudit`.
- **Tests.** Crash injection counts every write to the state store, the keyword index and the vector store (`test/fork/retention/crash.ts`), so a crash lands between every two writes, finer than the named steps. `move-disk.test.ts` needs `QDRANT_URL`.

**Slice 5 (protection and plan).**
- Done: `createProtector`, `planCandidates`, `proveChain` and `successorIndex` (plan.ts), and slice 4's tests now mint `Cleared` through the real Protector (`candidate(r, stage, row, seal?)` in `move-fixtures.ts`, async; a stage S candidate seeds a successor memory and uses `proveChain`).
- **Contract changes.** `ChainProof` carries a brand like `Cleared`. `Candidate` gains `graphCited?: true`, set by the plan on a stage O row that a graph posting cites; the judge counts it for the report and never vetoes on it. `Protector` gains `release()`, which empties `sweepScratch` when this Protector spilled. `createProtector` takes an optional fourth argument `{ spillIds }` (default `RETENTION_SPILL_IDS`) so a test can spill. `planCandidates` takes `now: Date` as a fifth argument: stage X compares `forgetAfter` with it, and the clock has no wall time. `RETENTION_COLD_SCORE` (0.15) is new in settings.ts.
- **Signal order and stages.** `judge` returns the first of pin, importance, memory-type, deliberate-save, cited-by-memory, cited-by-insight, retrieved. Importance, pin and retrieved apply to stages T and O alike; cited-by-memory applies to observations (T and O), cited-by-insight to memories. `lesson` is `hits().lesson`: the live lessons, counted once when the Protector is built.
- **Deliberate save is an origin test, and only stage C meets it.** The design says a latest memory is never trashed on age alone and that C demotes. Read as "every latest memory is protected" the rule would leave C empty, so it protects a latest memory with `origin.channel` user or agent (everything `mem::remember` writes) from C. A consolidated or imported memory with a cold score can still be demoted. A stage X memory is not protected by it: the save named its own end. R5's "latest memory with no access for two years" is a fixture with agent origin. Slice 8 or the owner may want a different rule.
- **Stage rules.** A row past both windows is one stage O candidate, never a T and an O in one run (they would share a vault key in one run's scope). X wins over S and C: any memory with `forgetAfter` past is X, latest or not. S ages from `updatedAt` (`supersededAt` sets it when a row stops being latest). C needs a `mem:retention` score below the cold tier and age past `coldDays`; a memory with no score is never cold. A memory with no `project` reads the clock of project "" (no active days), so only a zero window ages it.
- **Chain proof.** A superseded memory has no pointer to its successor, so `successorIndex` makes one paged pass and keeps, for each id listed in another row's `supersedes` or `parentId`, the highest-version row. `proveChain` walks to a latest row and accepts a hop only if the version is strictly higher and `createdAt` is not earlier. The version rises on every hop, so a loop cannot resolve and no seen-set is needed. Memories that other paths marked non-latest (auto-forget, relations) have no successor and are never S.
- **Plan walk.** Sealed sessions in id order, rows in key order, two passes per session (uncited, graph-cited), so a session is read twice. The graph verdict of a stage O id is read once per `planSession` call and reused by the second pass, so a graph change between the passes never yields a row twice. A reader that fails to be created, like a failing posting read, counts the chunk as cited and logs at warn. An empty batch is yielded per page, so the cursor moves. Seals are read as stored; the sweep's seal phase judges them just before. The plan holds the sorted key list of the unit it walks (ids only).
- **Cited-by-memory** counts a memory that is latest, or superseded and still inside `supersededDays` on its own project's clock (an unparseable `updatedAt` counts as inside). Over the spill threshold the set moves to `sweepScratch` at the first spill (the scope is cleared then, for a crashed run's leftovers), and `release()` empties it.
- **Left for slice 6.** Build one Protector per sweep and call `release()` in a `finally`; pass `deps.now()` to the plan; re-seal before planning; sum the batch counts into the stage counters; `hits()` and the `graphCited` count go in the report. The sweep lease must also cover purge's Protector when a spill is possible, because a spilling Protector clears the scope. **Left for slice 8:** `recheck` does not evaluate the memory-only signals (memory-type, deliberate-save); it reads importance for stage O from the entry's row and for stage T from the live row (one point read, since a trim entry holds no row). A crashed sweep leaves its `sweepScratch` keys until a spilling Protector clears them, and `release` on a Protector that did not spill does nothing, so run recovery (slice 6) must clear the scope itself.

**Slice 9 (explicit forget).**
- **Contract.** `afterForget(sdk, kv, outcome)` replaces the sketch's `afterForget(kv, erased)` and `eraseFromVault`. It takes `sdk` because releasing an image reference needs it, and it takes forget's request and its not-found list, not only the ids it deleted, because an observation id means nothing without its session. It returns `trashed`, the ids forget did not find live but erased from retention's copies. `mem::forget` counts those as deleted, drops them from `notFound` and adds them to its audit entry and facet cleanup. There is no separate `eraseFromVault` export.
- **Seam.** `remember.ts` grew by 14 lines, not 4: the import, a list of `{ id, sessionId }` for the rows forget deletes, one push into it, and one block that calls `afterForget`, reconciles the ids it erased from the vault (a set, so an id absent from `notFound` removes nothing) and passes its failures on to `cleanupFailures`. The call sits inside forget's own `cleanup`, so a failure shows as `cleanupFailed` and never undoes the delete. It runs in every mode and reads no retention setting: with retention off nothing is held and every lookup answers none.
- **Vault.** Under the item lock, `afterForget` takes each claim newest first (`locate`, then `under`), so a trim under a stage O entry goes too, and lowers each run's `held`. A row forget deleted live is looked up by an unlocked point read first, so a session of thousands of rows takes the lock only for the few that retention holds. A ref forget did not find live is always locked. A demote record is deleted by memory id.
- **Images.** A vault-only item still holds its image reference, because soft delete keeps it until purge. `afterForget` releases it once, writing `imageReleased` first, as purge will. Slice 7 must also drop the image hold when it adds `imageHolds`; erase releases the reference and nothing else.
- **Graph (L3, R10).** `graph-stale.ts` marks nodes and edges stale through the `observation` and `edgeObservation` postings and `mutateIndexedGraphRecord`, as `cascade-update` does, in batches of 15 ids under one bounded reader (4096 reads) that is checked with `finish()` before any write. 15 is the most ids whose postings can all be full pages of 128 entries, 2 postings and 129 reads each, within the reader's 4092 usable reads, so a fully cited batch is not split; `graph-stale.ts` derives it from those numbers. A batch the read budget still cannot cover is split. An error that escapes the call is logged at warn with its message, and the call reports `deferred`. It covers the ids of rows deleted live and of rows erased from a vault. A graph item that cites a forgotten id among others goes stale whole, the same rule `cascade-update` applies on supersede. With no graph index the call does nothing. With an index that is not ready, or an id the index cannot hold, it reports `deferred`, writes an audit entry, and nothing retries. One `forget` audit entry names up to 100 of the items marked.
- **Bare ids.** Graph postings cite bare observation ids. Forgetting one session's row marks the graph items of that id stale even when another session still holds a row with the same id. The graph cannot say which session a citation came from, and the search index and the observation-to-session index already hold one entry per id that forget removes by bare id. Stale is the safe side of an erasure. Vault entries, locators and held counts stay per session: forgetting session A's row never touches session B's vault entry for the same id.
- **Memories.** Forgetting a memory deletes the row, both index entries, its vault claims and its demote record. It marks no graph items, because graph items cite observations and the memory's source observations are still live. This is the answer to open question 4 for now.
- **Session count (L4, R11).** The stack's `ObservationStats` wrapper already assigns `observationCount` on every row write, so a live delete was already correct on the production store. `afterForget` assigns it again from the rows for each session it touched, which repairs earlier drift, covers a store without the wrapper, and covers a forget of a vault-only row.
- **Whole session.** Forgetting a session pages the vault of every run that still holds entries (`Vault.runsHolding`, about 60 runs a year), 64 entries at a time, and erases each entry of that session as it erases an absent ref: both claims of a stacked ref (each found in its own run, even when its locator was lost), the image reference, and `held`. The KV has no prefix scan, so the filter is on `ref.sessionId`; nothing lists a vault. These ids count in `trashed`, so graph items that cite them go stale and the session is recounted.
- **Isolation.** Each ref, the graph step and each session recount fail alone. A failure is logged at warn and listed in `ForgetCleanup.failures`; `mem::forget` adds each to `cleanupFailed` and `cleanupFailures`. Nothing retries it.
- **Count lock.** `assignObservationCount` runs under `obs-count:<sessionId>`, a leaf lock, because `afterForget` calls it with no lock and the satellite detach and attach already hold `obs:<sessionId>`.
- **Not covered.** A crash between forget's delete and `afterForget` leaves a trim entry for a row that is gone, and purge removes it at the end of grace. Forget cannot retry a deferred graph mark.
- **Behaviour change in `mem::forget`.** An id a run displaced no longer comes back in `notFound`. It counts in `deleted` and its audit entry lists it. A forget that marks graph items also writes one extra audit entry. `notFound` no longer keeps an id the request named twice once it is erased. A failed ref adds to `cleanupFailed` and `cleanupFailures` (one entry per ref, not one `retention` entry for the whole pass). Nothing else in the response changes.

**Slice 6 (sweep, report, recall check).**
- Done: `runSweep` as the state machine (seal, plan, check-before, apply, settle, check-after, done), the report builder, the recall harness (`createRecallHarness`, which replaces register.ts's stub), the audit entries and the first-run cap. `mem::retention-sweep` still takes only `dryRun`; no timer or REST route (slice 10).
- **Contract changes.** `RecallHarness` gains `cases()`, so the sweep can tell a run with no golden case from a harness that cannot score. `RecallScore.recallAt10` is percentage points (0 to 100), the unit of `recallStopPoints`. `ReportBuilder.candidate(c)` measures bytes itself; `finish` takes the protection hits and `resumed`. `RunReport` gains `outcome`, `why`, `resumed`, `perStage[stage].moved`, `sealed`, `injectedContextScanned`, `observationCap` and `restored`, and `recall` carries `goldenBefore` and a nullable `after`, so a resumed run can still judge its after-check. `SweepRequest` gains `pauseMs` (tests only) and `SweepResult` gains `lease-lost`. `clearSweepScratch(kv)` is exported from protect.ts. The reports are stored in `mem:retention:reports` at the end of the plan and rewritten at done.
- **Fix in slice 4's `move.ts`.** `attachSatellites` accumulated `reembedNeeded ||= await attach(...)`, which short-circuits: once the search index reported an item with no stored vector, the capture event, observation-session index and session count were never re-attached. Two lines changed in `attachSatellites`; `restore-no-vector.test.ts` pins it. The slice 8 demote branches are untouched.
- **Resume.** An unfinished enforcing run is resumed whatever the new request says. `recoverRun` runs first, then `clearSweepScratch`, then `held` and each stage's `moved` are recounted from the run's vault, since a crash can land between a move and its count. An unfinished dry run is closed (`dry-run`), never resumed, and a dry run request never resumes or recovers anything. A resume at `seal` or `plan` redoes both, so the report stays whole. A run whose `restoredBecause` is set finishes its restore instead of re-scoring. A crash leaves the lease until `LEASE_STALE_MS`; the tests move the clock past it.
- **Plan streamed twice.** An enforcing run streams the plan once for the report and once to apply, so it reads each sealed session twice (ponytail note in `sweep.ts`). The apply pass judges again with the same Protector, so its protection hits are not counted twice: the report keeps the hits of the plan pass.
- **Lease.** Heartbeat before every plan and apply batch and after every seal page; a lost lease returns `lease-lost`, does not release the scratch (another sweep may own it) and leaves the run open. A throw releases the lease and leaves the run open too.
- **First-run cap.** `mem:retention:control` key `enforced-runs` counts runs that ended `kept`. While it is 0 the apply phase caps stage O at `floor(share x observations)`, summed from the observation stats at the start of apply and stored in `RunRow.observationCap`. A refused or restored run does not lift the cap. A stack with fewer than 10 observations gets a cap of 0.
- **Recall cases.** `AM_RETENTION_RECALL_CASES` names a JSON file, `{ "cases": [...] }` or a bare array, each case `{ "id", "query", "evidence": [ids], "golden"?: boolean }`; `golden` defaults to true. See `recall-check.ts`. No golden case, a missing file or a malformed one refuses the run. A check that cannot run after the delete restores it. Rare-fact cases drawn from protected memories (design 7.4) are not built.
- **Evidence protects itself.** `mem::smart-search` records access, so the before-score marks every golden case's evidence as retrieved, and the apply pass's `retrieved` signal then protects it. With the real harness an R9 restore therefore needs a loss the cases did not name directly (collateral loss, or an index fault), and the tests force the loss with a harness that reads the index without recording access.
- **Audit.** Every run, dry runs included, writes one `retention_seal` entry and one entry per stage (`retention_soft_delete` for T, O, S and X, `retention_demote` for C), all with `runId`, `dryRun`, `outcome`, `reason`, `restored`, and the stage's `planned`, `moved`, `bytes` and `protectedHits`. A restore adds slice 4's `retention_restore` entry. A crash between the audit and the final row save can leave a second set after a resume. No new audit operations.
- **Dry run.** Writes only `mem:retention:*` (seals, active days, run row, report, lease) and the audit log. The R1 test compares every other scope and both index sizes.
- **Injected-context count.** Counted over the observation candidates the plan reads, with the number scanned beside it. A trimmed row holds no source and a row that is not a candidate is not read, so it is a floor. A full count needs its own paged pass over every row.
- **Stage C is wired.** The apply pass sends a cleared C candidate through `displace` like any other stage; the `demoteSkipped` branch and report field are gone. A demote counts in `counters.C.moved` and `counters.C.bytes` (the size of its demote record) and so in the `retention_demote` audit entry, but never in `RunRow.held`, because it makes no vault entry. A candidate `displace` answers `already-demoted` or any other skip counts nothing. The first-run cap applies to stage O only, so a first run demotes as many cold memories as the plan clears. `recover` recounts stage C's `moved` from the run's demote records (`demotedBy`, skipping a record already `restoring`) after `recoverRun` has settled them, as it recounts the vault stages from the vault. R9 needs no sweep code: `restoreRun` un-demotes, from the stored vector with no embedding call. The R12 resume test includes a cold memory and ends with it fully demoted.
- **Left for later slices.** Slice 7: purge's Protector must run under the sweep lease when it can spill. Slice 10: the timer, REST routes and the report endpoint. Not built: `diffFromLastReport`, and the memory-only signals in `recheck` (slice 8).

**Slice 8 (demote, stage C).**
- Done: `demote.ts` (new), the demote branch of `displace`, stage C in `recoverRun`, un-demote in `restoreRun` and `restoreItems`, `hiddenFromIndex` in the two `search.ts` readers and in `docOfRecord`, and `plan.ts` skips a memory that is already demoted.
- **The mark is bound to its memory.** `Memory.retention` is `{ demotedAt, runId, memoryId }` and `hiddenFromIndex` is true only when `memoryId` equals the row's own id. `mem::evolve` builds the new version with `{ ...existing }`, so a bare `demotedAt` would hide the new live version. With the id in the mark, no copying writer needs a change. The new version carries a stale mark that names the old id and is ignored. `mem::remember` and `mem::consolidate` mutate the old row in place or spread it, so the mark stays on the superseded version.
- **Where the vector is kept.** `DemoteRecord.vector` in `mem:retention:demoted`, keyed by memory id, base64 float32 as in the vault's `satellites.vector`. It is read with the same `search-index` snapshot a trash move uses, so a vector read that rejects refuses the demote (`unreadable`) and a memory with no vector is demoted with none (un-demote then reports `reembedNeeded`). Disk mode keeps what Qdrant returns (unit length, float16), as in slice 2.
- **Order and recovery.** A demote writes the record, then the mark, then the index removals, under `mem:remember`. `recoverRun` pages the run's records (the scope is keyed by memory id, so it scans the scope) and settles each under the lock. A record with no mark is a demote that never landed: the record goes and the live row is indexed again. A mark with a record runs the removals again. A record flagged `restoring` finishes the un-demote. `DemoteRecord.restoring` is new, for the same reason as `VaultEntry.restoring`. Un-demote writes `restoring`, clears the mark, re-adds the keyword doc and the stored vector in one tick, then deletes the record. A marked row with no record (an export imported from another stack) is un-demoted with no vector and the re-embed loop fills it.
- **Purge never sees a demote.** A demote makes no vault entry or locator and adds nothing to `RunRow.held`, and `VaultEntry` and `ItemLocator` have no stage C, so purge pages only trash. `Protector.recheck` therefore never needs the memory-type or deliberate-save signals. `Protector.judge` evaluates them before the demote, and `displace` takes only `Cleared`. A pin set after a demote does not un-demote the memory; slice 10's pin handler may call `restoreItems` for it.
- **Contract changes.** `DisplaceResult.skipped` gains `already-demoted`. `reinstateDemote(deps, memoryId)` replaces the sketch's `(deps, record)` and returns `null` when nothing is held. `restoreRun` and `restoreItems` count un-demotes in `restored` and leave `held` alone. `recoverRun` counts a finished un-demote in `finished` and a marked row whose removals ran again in `detachedAgain`. `satellites.ts` exports `removeDocument` and `addDocument`, which the search-index satellite and the demote share. `planAndMove` in the plan tests now demotes stage C.
- **Seams.** `types.ts` 1 line. `search.ts` 2 lines and an import, in `indexRecords` and `rebuildKeywordIndex`. `doc-of-record.ts` 1 line and an import, plus its doc comment. No other upstream file changed.
- **Behaviour to know.** `mem::remember` finds its supersede candidates through the keyword index when the index is ready and not empty, so a duplicate save does not supersede a demoted memory: both exist, and the demoted one stays hidden. With nothing indexed it scans `mem:memories` and does supersede it. `mem::consolidate` and `mem::evolve` read `mem:memories` and do see it. Graph retrieval reads a cited memory from `mem:memories` with only an `isLatest` check, so a graph node that cites a demoted memory id as evidence still resolves it (not gated by this slice).
- **Left for later slices.** Slice 7: purge finalize of a memory entry should delete `mem:retention:demoted` for the id, because a demoted memory that was then soft deleted keeps its record. Slice 10: the pin handler.

**Slice 7 (purge, grace, images, tombstones).**
- Done: `purge.ts` (new: `purgeExpired`, `runPurge`, `dueRuns`), `images.ts` (new: the image satellite and `releaseImages`), the `image` and `metadata` rows of `SATELLITES`, `mem::retention-purge` in `register.ts`, and the forget path's use of `releaseImages`. This closes every "left for slice 7" note above: purge's Protector runs under the sweep lease, a purged memory entry deletes its demote record, `afterForget` and purge share one image release that also drops the hold. No REST route or timer (slice 10). No upstream file changed.
- **Purge order per entry** (stages O, S, X; every step after 2 repeats safely):
  1. `recheck` and settle, under the item lock. An entry mid-restore, or whose live row came back, goes through `reinstateLocked`. A protected entry is reinstated. Nothing before step 2 is irreversible, so a crash here leaves the entry fully restorable.
  2. `vault.update({ purging: true })`, the commit point. From here `reinstateLocked` defers the entry (restore says `deferred`), a re-run skips the recheck and finishes it.
  3. Once per page: `deleteMemoryFacets` for the page's memory ids (it reads the whole facet scope, so it runs per page, not per entry).
  4. Per entry, under its lock: `imageReleased: true` on the entry, then `decrementImageRef` per file, then drop the hold (the three steps of `releaseImages`, run again after a crash only for the hold); then for a memory its access log and retention score; then for an observation the tombstone (written only when absent) or for a memory `mem:retention:demoted`.
  5. `vault.take` (entry, then the locator's claim). Last, as the ordering invariant (R12) requires.
  6. After the last page: one `retention_purge` audit entry per run, then `RunRow.held := entries left` and `purgedAt` when none are left.
  A stage T entry skips 3 and 4: it only drops the vaulted source (`take`), and its live row, index entries and locator claim for another run stay. A crash at any write leaves the entry either restorable with nothing taken from it (before step 2) or committed with only idempotent steps left (after it). The tests crash between every two writes and re-run.
- **Held count.** `held` is assigned at the end of a run's visit, not decremented per page. A decrement could reach 0 before `purgedAt` was written, and `runsHolding` would never visit the run again. A crash after a `take` leaves `held` too high, never too low, so the run is visited again. Restore and forget still decrement (`release`).
- **Image reference is released at most once; a crash can leak one.** `imageReleased` goes first, as `afterForget` does. A crash between the marker and the decrement leaks that reference and the file lives on, because `mem:image-refs` is a bare number and cannot hold the marker in the same write. The crash test asserts this exactly: the final count is the expected one except for a path whose marker was set and whose decrement had not completed, and the decrement never ran twice. `reinstateLocked` also defers any entry with `imageReleased`, so a forget that crashed after releasing the reference cannot be undone by a restore, and purge finishes it at the end of grace (slice 9's "not covered" case).
- **Image hold.** `mem:retention:image-holds` is `{ holders: itemKey[], embedding? }`, not a count: a list of item keys stays correct when a detach, attach or purge is replayed after a crash, which a counter does not. Live referrers of a file are `mem:image-refs` minus `holders.length`. When a move leaves none, the `mem:image-embeddings` row is parked in the hold and `images.remove` runs; a restore of any holder puts it back with no embedding call (R3), and purge or forget of the last holder drops it with the file. `SatelliteSnapshots.imageEmbedding` is removed: the parked row lives in the hold, not in one entry, so two holders of one file restore in either order. A hold lives under a leaf lock `imgHold:<path>`; the item lock is held outside it.
- **Contract changes.**
  - `purgeExpired(deps, protect, now, opts?)` gains `{ beat, dryRun, pauseMs }`. `PurgeResult` moved from restore.ts to purge.ts and gains `dropped` (an entry whose live row had been rewritten: the row stays, the copy goes) and `deferred` (a protected trim entry whose row sits in another run's vault, still restorable from there). `runPurge(deps, settings, { dryRun })` is the entry point: off returns `{ kind: "off" }` with no read or write, no run due takes no lease, a busy lease returns `{ kind: "busy" }`, a lost heartbeat returns `{ kind: "lease-lost" }`.
  - `EntryBase.purging` is new. `RunRow.purgedAt` is new. `reinstateLocked` returns `deferred` for an entry with `purging` or `imageReleased`.
  - `Satellite.finalize` is now used: `image` (release once, drop the hold) and `metadata` (access log, and a memory's retention score).
  - `mem::retention-purge` takes `{ dryRun }`, true unless `false`, as the sweep does. A dry run takes the lease and builds the Protector, so it may write `sweepScratch` and the active-day cache; it writes no audit entry, no run row and nothing in the vault.
- **Which runs are due.** `phase` done, not a dry run, `held > 0`, and `now - closedAt >= graceDays` of the run's own snapshot (24 h counts as elapsed). An unfinished run, a refused run and a purged run are never visited. A restored run's leftover deferred trim entries are purged like any other.
- **Protection at purge.** `runPurge` builds one Protector from the current settings' windows and a clock loaded at `now`, and releases it in a finally unless the lease was lost (the new owner may be using the scratch). Pin, citation by a latest memory or an insight, access inside the cold window and importance of 8 or more restore the entry (`restoredBack`). Importance of a stage O entry is the entry's row, as slice 5 recorded, so only a trimmed row's importance can change during grace.
- **Tombstones.** Written at purge for stage O only, keyed by `itemKey`, never deleted, never rewritten. The capture event marker from soft delete is left alone, which is what keeps a replay a `duplicate`; the test replays the capture log after a purge and after a boot rebuild. A memory gets no tombstone.
- **Metadata.** Purge deletes a memory's access log, retention score and facets. An observation's access log and facets are keyed by the bare id and are kept (see the fix round below).
- **R13.** One `retention_purge` entry per due run and pass, with `runId`, `reason`, `graceDays`, `closedAt`, `heldBefore`, `purged`, `restoredBack`, `dropped`, `deferred` and `remaining`. It is written when the visit changed something or deferred an entry, so a run held only by deferred entries is audited on every pass; the run row is saved only when something changed, and a visit that did neither writes nothing. `safeAudit` swallows a failure, and a crash before the entry loses that pass's counts (the tombstones and `purgedAt` stay).
- **Behaviour to know.**
  - A stale entry that restore or purge drops because its live row was rewritten keeps its image hold and reference. Slice 4 already left that reference; the hold stays consistent with the count.
  - Forgetting a live row that shares an image with a vaulted holder leaves the image searchable until the holder is purged: the embedding is parked only at the move.
  - A stage T entry whose row is in a later run's vault is purged on its own run's grace, so the raw source can go while the row is still restorable from the later run.
  - A stage T entry whose row is neither live nor in another run's vault (the later stage O run's grace ended first and purged it) is purged on its own grace even when protected: nothing can take its source back.
  - `deleteMemoryFacets` scans the whole facet scope once per page of 200 entries that holds a memory.
- **TEE-1196 was on disk** (`CollectionReconciler`, `imageRecords`). `purge-disk.test.ts` runs the images assertions against a live Qdrant (`QDRANT_URL`): after a move a reconcile pass neither repairs the image back nor reports it extra, a restore returns it without embedding, and after purge the next pass finds nothing to repair.
- **Interrogate fix round.**
  - `reinstate` reads the entry again under the item lock and returns `null` when it is gone, so `restoreRun` no longer passes the page's copy. A restore that read its page and then waited while purge finished an entry used to bring the row back with its image, access log and tombstone already settled, and rewrite the vault key purge had taken. A gone entry counts in nothing and lowers no `held`; a `purging` or `imageReleased` one is deferred as before.
  - Purge heartbeats between each entry's recheck and its `purging` mark as well as before every page. A sweep that takes a stale lease clears `sweepScratch`, so a spilled Protector's recheck reads an empty cited set and calls a cited entry clear; the beat after that recheck finds the lease gone and the pass ends `lease-lost` before the commit. A recheck that ran before the takeover read a whole set. The cost is one lease write per committed entry.
  - A dry run returns the counts the enforcing pass would: `reinstatement(entry, live)` (move.ts) is the pure decision `reinstateLocked` acts on (`restore`, `drop` or `deferred`), and the dry run counts the same decision without writing. `runsEmptied` is counted the same way. Before this a dry run called a recaptured row and an entry mid-restore deferred and a rewritten protected trim restored.
  - T then O with O's grace ending first: once O's run purged the row, a recheck that found the trim entry protected sent it to `reinstateLocked`, which defers a trim with no live row, so the entry stayed held for good and the run never reached `held` 0. Purge now checks the locator: with no live row and no other run's vault holding the row (`rowVaulted`), the trim entry has nothing to restore into and is committed and counted in `purged`, protected or not. A trim entry whose row another run's vault still holds keeps the deferral, since a restore of that run first gives the source a row again.
  - A pass that only deferred entries of a run wrote no `retention_purge` entry, so the run's stuck entries left no trace. `closeRun` now audits a visit with any deferral and saves the run row only on a change.
  - **An observation's bare-id metadata is kept at purge.** Purging session A's row deleted the `mem:access` log that session B's vaulted row shared (B came back with no log), and `deleteFacetsForTargets` with the bare id deleted the facet of B's live row. The rule is to delete such a key only when no other live or vaulted row holds the id, and nothing answers that cheaply: the observation-to-session index holds one session per id, the vault and locator are keyed by session, and a scan of every session per entry is out of proportion. So purge keeps both for observations and still deletes them for memories, whose ids are unique (ponytail note in satellites.ts, upgrade path a bare-id holder index kept by `Vault.put` and `take`). Upstream forget already keeps observation access logs. The cost is one small row per purged observation that was ever retrieved or tagged; the diagnostics orphan-facet heal (`findOrphanFacets`) can remove such a facet once no live row holds the id. That heal does not look in the vault, so it can also remove a vaulted row's facet; that gap predates slice 7.
  - **How A's move unindexed the shared id.** Not a slice 4 bug. Upstream writers (`observe`, export import) overwrite the observation-to-session index, so it names the session that wrote last. In the facet case A wrote last, and A's detach removed the entry because it named A, which is slice 4's rule. The index cannot name B afterwards without a scan to find B. In the access-log case both rows had moved, so an empty index was right.
  - **A failed metadata delete stops the pass.** Upstream `deleteAccessLog` and `deleteFacetsForTargets` log and swallow errors, so a failed delete let `vault.take` run and nothing retried it. The metadata satellite now deletes a memory's access log with `kv.delete` under the `mem:access:<id>` lock that `deleteAccessLog` and `recordAccess` hold, and `deleteMemoryFacets` (purge.ts) reads the facet scope and deletes with `kv.delete`. A failure throws out of the pass: the entries stay `purging`, `held` stays high, and the next pass finishes them. No upstream file changed. One entry that fails every time stops every later pass at that entry; the error reaches the caller of `mem::retention-purge`.
- **Left for slice 10:** the daily purge timer (call `runPurge` with `dryRun: false`, no-op when off), `POST /agentmemory/retention/purge` with a `{ dryRun }` whitelist and fail-closed auth, the purge counts in `mem::retention-report`, and the `docs:sync` counts. **Left for slice 12:** the 23 h and 25 h check on a replica with a 1-day grace, the memory peak of a purge over a full vault, the facet scan cost per page, purge against a live image store (the file leaves disk), and a sweep timer that meets a purge's lease.

**Slice 10 (REST, pins, timers, docs).**
- Done: `rest.ts` (the five routes), `admin.ts` (restore under the lease, the report reader), `pin.ts`, `timers.ts`, the three new iii functions in `register.ts`, `retention_pin` in the audit union, the endpoint counts and the operator guide in `docs/fork/README.md`. This closes the "left for slice 10" notes of slices 6, 7 and 8, except the two named at the end.
- **Seam is 9 lines, not 2.** Every counter of REST endpoints (`test/consistency.test.ts`, `test/skills-rest-endpoints.test.ts`, the website metadata and `skills:gen`) reads `registerTrigger` literals in `src/triggers/`, and `docs:sync` reads `api.ts`. Triggers registered from a fork file would leave all of them at 148. So `api.ts` holds the five one-line `registerTrigger` calls, as it does for the graph index routes, and `registerRetentionTriggers` registers only the handlers. `requireConfiguredSecret` gained `export`, and both guards are passed in (`{ checkAuth, requireConfiguredSecret }`, the `registerGraphIndexApi` pattern) so no fork file imports `api.ts` into `tsconfig.fork.json`. `registerRetentionTriggers(sdk, secret, guards)` drops the sketch's `kv` argument: handlers only call `sdk.trigger`.
- **Routes** (`/agentmemory/retention/...`): `POST sweep`, `POST purge` `{dryRun}`; `POST restore` `{runId}` or `{refs}` (1 to 100); `POST pin` `{ref, reason, who?}` or `{ref, unpin: true}`; `GET report?runId`. Each handler answers 503 with no secret (`requireConfiguredSecret`), then 401 for a wrong token (`checkAuth`), then validates: bodies are JSON objects, a ref is a memory or an observation with a session, ids at most 256 characters, a reason at most 500, `who` at most 100 (default `api`, an unverified label: one shared secret), a run id matches `ret_...`. Fields outside the whitelist are dropped, and the iii function gets a fresh object. `dryRun` is true unless exactly `false`. Statuses: 200, 400 (also an `invalid` outcome from a function), 401, 404 (unknown run, item or report), 409 (`busy`, `lease-lost`), 500 (generic message, the error goes to the log), 503 (no secret; `retention is off` with the reason on sweep and purge).
- **Behind a generated secret.** The worker generates a secret when `AGENTMEMORY_SECRET` is unset (`resolveWorkerSecret`, `index.ts`), so `registerApiTriggers` always gets one and the 503 branch is a guard for a caller that passes none. The routes still need the bearer token.
- **Restore takes the sweep lease.** `restoreRun` and `restoreItems` read and rewrite the run row of each run they touch (`held`), and so do the sweep and the purge, so a restore beside either could lose an update. `mem::retention-restore` acquires the lease the sweep and purge use and answers `busy` (409) while another holds it. Per entry it was already safe against a purge: slice 7's `reinstate` rereads the entry under the item lock, and a `purging` entry is deferred. `purge-races.test.ts` pins that at the function level, and `admin.test.ts` pins the endpoint level: a restore in progress makes a purge answer 409 and the reverse, and both fired together end with every item live or purged. `restoreRun` and `restoreItems` take an optional `beat`, called before each page, each run row write and each ref; `restoreLeased` passes one that heartbeats and throws once another process holds the lease, so the restore stops with `lease-lost` (409) before its next write and leaves the new owner's lease alone. A timer also renews the lease every `LEASE_STALE_MS / 3`, for a page slow enough to outlast it, and stops once a renewal finds it gone. The sweep passes its own beat to `restoreRun`. A run that has not finished is one a sweep died in (a live sweep holds the lease, so a restore beside it answers `busy`): restore runs `recoverRun`, clears the sweep scratch, runs `restoreRun`, then closes the run row and its report as `restored` with the phase it stopped in as the reason. This holds with retention on or off: off, no sweep would ever close the run; on, the operator asked for the run undone, not resumed.
- **Pins (D3).** `pinItem` writes `{ref, who, reason, pinnedAt}` to `mem:retention:pins` under the item's lock, the key the Protector's first signal reads, and audits a `retention_pin` entry (new operation, one line in `types.ts`; unpin audits `pinned: false` only when there was a pin). An item that is neither live nor restorable from a vault is not found (404), so the scope cannot fill with pins for ids that never existed and a pin never promises what purge will not keep. Restorable (`Vault.holdsRestorableRow`) means a stage O, S or X claim whose entry purge has not begun on; a trim claim alone holds only `source`, and purge takes it whatever a pin says once its row is gone everywhere (slice 7's rule, which now reads the same check). A pin on a demoted memory un-demotes it inside the same lock with `reinstateDemoteLocked`, the half of `restoreItems` that handles demotes, from the stored vector with no embedding call. `restoreItems` itself was not used: it takes the item lock (not reentrant) and would also restore a vault claim. `displace` re-reads the pin under the item lock for every stage and skips a pinned item (`skipped: "pinned"`); the pin handler writes under the same lock (`MEMORY_LOCK` for a memory), so a pin that lands between the Protector's judge and the move is seen by whichever runs second. A pin on an item in a vault does not restore it, because design 4.6 hands that to purge: the entry stays held, the pin shows as `vaulted: true`, and purge's recheck restores it at the end of grace (`restoredBack`). Restore now to skip the wait.
- **Restore, pin and report work with retention off.** Only the sweep and the purge answer `off`. The kill switch stops deletion, not undoing it, and a stack that switched retention off during a grace period can still restore.
- **The report route** (`mem::retention-report`) returns `{ kind: "found", report, run }`: the stored `RunReport` (null when the run died before the plan) and a run summary with `phase`, `outcome`, `held`, `graceDays`, `graceEndsAt`, `purgedAt` and `restoredBecause`. Those fields change after the run ends, as restores and the purge take entries, which the stored report cannot show. Without a run id it reads the run with the latest `startedAt`.
- **Timers** (`timers.ts`). The sweep every `AM_RETENTION_INTERVAL_MS` when it is above 0 (at most 2147483647, about 24.8 days: Node fires a longer `setInterval` delay every 1 ms, so settings turn retention off for one; chaining timeouts would not help, because the interval counts from boot and a stack that restarts more often than that would never sweep), the purge every 24 hours, each calling the same function the route calls with `dryRun: false`. An off stack schedules nothing (the existing off test checks `setInterval`), and so does an interval of 0 for the sweep. The first tick comes one interval after boot. A tick never throws and skips itself while the last one runs. `busy` and `off` log at info, `lease-lost` and a throw at warn. `Scheduler.every(ms, tick)` is the injected clock: tests hand in a scheduler they fire by hand. The real one is `setInterval(...).unref()`. `registerRetention(sdk, kv, options?)` takes `{ env, deps, scheduler }` for tests and returns `{ stop() }`; `index.ts` calls it unchanged.
- **Contract changes.** `registerRetention` returns `{ stop }` and takes an optional third argument. `mem::retention-restore` and `mem::retention-pin` parse their payload with the route parsers (`requests.ts`, shared with `rest.ts`) and answer `{ kind: "invalid", error }` for one the routes would refuse; the pin function needs `who` (the route still defaults it to `api`), and `who` and `reason` are trimmed before the length check and stored trimmed. `RestoreOutcome` lost `run-open` and gained `lease-lost`. `registerRetentionTriggers` moved from `register.ts` to `rest.ts` with the signature above. `mem::retention-pin` also takes `{ ref, who, unpin: true }`. New audit operation `retention_pin`. `scripts/docs-sync.ts` is unchanged. `AGENTS.md` said "322+ iii functions" where the count was 328, now 336.
- **Tests.** `rest.test.ts` (auth, whitelist, validation, statuses, function payloads, trimming), `pin.test.ts` (pins, un-demote with a spy provider at 0 embeds, survive a sweep and a purge, a pin between judge and move, a pin on a demoted memory that a stage X run vaulted, not-found for what purge will not keep), `admin.test.ts` (lease, heartbeat, lease-lost, race through the endpoints, an unfinished run with retention off, report), `timers.test.ts` (schedule, off, interval 0, busy, lease-lost, overlap, a real sweep and purge tick on an injected clock), `r13-rest.test.ts` (R13 through REST with a secret).
- **Interrogate fix round.**
  - A demoted memory can be soft deleted by stage X or S: the plan's X and S branches do not skip demoted rows, which is right, since expiry and supersession do not depend on coldness. Its row then sits in a vault still marked. `reinstateDemoteLocked` with no live row now keeps the record while a vault holds the row and answers `deferred` (a pin reports `undemoted: false, vaulted: true`; a restore of the demoting run counts it in `deferred`); with the row in no vault the record goes, as before. `reinstateLocked` un-demotes a pinned memory from that record before it takes the entry, so purge's `restoredBack` and a restore by run bring a pinned memory back indexed from its stored vector, with no embedding call. An unpinned restore by run leaves it fully demoted, mark and record. `restoreItems` un-demotes after the claims as it did. A marked row with no record is reached only by an imported mark.
  - A stale pin (its item forgotten upstream) stays until `unpin`, which needs no item. It is harmless: the Protector reads a pin only for an item that exists, and one that reappears under the key is kept, which errs toward keeping. Purge cannot remove a pinned item for good: a pin it would ignore is refused, and pin and commit share the item lock.
  - `restoreUnfinished` writes no R13 sweep audit (seal and per-stage entries); its `retention_restore` entry names the run and why.
- **Left for slice 12.** The sweep timer meeting a purge or restore lease on a replica; a restore of a full run (36,000 rows) under the lease, and whether the renewal interval holds; a staging check of the pin route on a real demoted memory. **Not built:** `diffFromLastReport`, and the per-pass purge counts in the report (they stay in the `retention_purge` audit entries; the report shows `held` and `purgedAt`). `.env.example` does not list the `AM_RETENTION_*` keys (`scripts/check-env-example.mjs` flags them, as it did before this slice).

## Next implementation step

Slices 5 and 11 can run in parallel; slice 5 (protection and plan) mints the `Cleared` values `displace` takes, and slice 6 (the sweep) calls `displace`, `recoverRun` and `restoreRun` with the notes above.
