# Retention design: digest before delete

Issue: TEE-1154. Status: design note, no code. Date: 2026-11-17.
Code references are to this fork's `disk` branch at upstream v0.9.33 (commit `28ffc53`). Research inputs: `research/06-agentmemory-lifecycle.md` (written against a newer upstream main; every claim used here was re-checked against v0.9.33) and `research/07-retention-best-practice.md`.

## 1. The three goals and the short answer

| Goal | Mechanism | Main safeguard |
|---|---|---|
| G1. Do not keep stale memory forever. | Raw observations age out once their session is digested. Old memories that nobody uses drop out of recall (demoted). Expired TTL memories and old superseded versions are deleted after a grace period. | Age is measured on the project's active clock, so an idle project does not age. |
| G2. Do not keep memory that was updated, contradicted or superseded. | Supersede means invalidate, not delete: the old version leaves recall at once (as `mem::remember` already does), stays as history for a window, then goes through soft delete and hard delete. | Supersession is decided by keys and by the existing Jaccard rule, never by embeddings alone. A cycle check and a strictly-newer rule stop flip-flops. |
| G3. Never delete valuable memory. | Nothing is deleted until a digest of it exists and is verified (the session seal). Protection rules veto deletes. Every delete is first a soft delete into a restorable trash. | Dry run report, recall check before and after every enforcing sweep with an automatic restore when it drops, 30-day restore window, audit per run. |

The design follows the pattern research 07 found best supported: invalidate rather than delete (Graphiti, Cognee, RD-Forget), delete raw only after the digest is verified (Elasticsearch ILM `wait_for_snapshot`), soft delete with a grace period (Google Cloud Storage soft delete, ChatGPT's 30-day logs), and treat "never retrieved" as weak evidence (Causal Memory Policy, 2610.02070: 54% of needed memories had zero retrieval probability).

## 2. What v0.9.33 does today

### 2.1 Mechanisms

| Mechanism | When it runs | What it does | Problem for retention |
|---|---|---|---|
| Per-session cap `MAX_OBS_PER_SESSION`, default 500 (`config.ts:316`) | Every capture | Refuses a new observation once the session holds 500 rows (`functions/observe.ts:201-207`). Status reports it as a capture-inbox error (`functions/status.ts:566-573`). | Loses the newest captures of every long session. They are never stored, so they are never digested. Research 06 described the newer upstream behaviour (delete the lowest-importance rows, also undigested); v0.9.33 refuses instead. Both lose undigested data. |
| `mem::auto-forget` (`functions/auto-forget.ts`), hourly unless `AUTO_FORGET_ENABLED=false` (`index.ts:691-697`) | Timer | (a) hard-deletes memories past `forgetAfter` (`:47-70`); (b) marks the older of two memories with token Jaccard > 0.9 as not latest (`:112-160`); (c) hard-deletes observations older than 180 days with importance ≤ 2 (`:159-212`). | (c) almost never fires: synthetic compression always writes importance 5 (`functions/compress-synthetic.ts:116`), and only LLM compression (`AGENTMEMORY_AUTO_COMPRESS=true`, `config.ts:595-596`) produces other values. (b) leaves the demoted memory in both search indexes (no `remove` in that branch), unlike `mem::remember`. All three are hard deletes with no grace. It reads every memory and every session's observations into RAM (`:43`, `:159-170`). |
| `mem::evict` (`functions/evict.ts:115`), manual via REST (`triggers/api.ts:1855`) | Manual | Stale sessions > 30 days without a summary; observations > 90 days with importance < 3; per-project cap of 10,000 observations; expired TTL memories; non-latest memories > 90 days. | The stale-session path deletes the session row (`:201-202`) and the observation-to-session index entries (`:216-218`) but not the observation rows or their keyword and vector entries: they are orphaned. The per-project cap deletes undigested rows ordered by importance only. |
| `mem::retention-score` and `mem::retention-evict` (`functions/retention.ts:129,294`) | Manual | Scores latest memories and semantic memories: `salience × e^(−0.01·days) + 0.3 × Σ 1/daysSinceAccess` (`:23-28,84-96`); evicts below cold 0.15. | Observations are never scored. Reads whole collections (`:137-140`). |
| `mem::governance-delete` / `-bulk` (`functions/governance.ts:34,105`) | Manual | Hard-delete memories by id or filter. | No graph cleanup. |
| `mem::forget` (`functions/remember.ts:267`) | Manual | Most complete delete: rows, summary, capture tombstone, indexes, facets, access logs, images. | No graph cleanup. No session counter update. |
| `mem::remember` supersede (`functions/remember.ts:120-196,234-240`) | On save | Jaccard > 0.7 against BM25 candidates: old row `isLatest=false`, removed from both indexes, kept in KV; fires `mem::cascade-update`. | This is the model to copy for G2. |
| `mem::cascade-update` (`functions/cascade.ts:11-80`) | After a supersede | Marks graph nodes and edges derived from the superseded memory's observations `stale:true`, using the graph retrieval index's per-observation postings, in resumable batches of 64. | The only path that touches the graph. Delete paths do not use it. |
| Lesson and insight decay (`functions/lessons.ts:322-372`), daily (`index.ts:721-733`) | Timer | Confidence decays 0.05 per week; soft delete (`deleted=true`, row kept) when confidence ≤ 0.1 and reinforcements = 0. | Recall does not count as use: `mem::lesson-recall` records an audit entry but no reinforcement (`lessons.ts:176-236`). |
| Audit retention (`retention.ts:423`) | Daily when `AGENTMEMORY_AUDIT_RETENTION_MONTHS > 0` | Drops old monthly audit scopes. | Off by default. |

### 2.2 Data loss and drift found in v0.9.33

These are defects whether or not the fork adds retention. The last column says where the fix belongs.

| # | Defect | Evidence | Upstream bug? |
|---|---|---|---|
| L1 | Long sessions silently stop capturing at 500 observations. | `observe.ts:201-207`, default `config.ts:316` | Yes (default too low; refusal not visible to the agent). The fork can fix it by configuration alone: see decision D9. |
| L2 | Evict's stale-session path orphans observation rows and their index entries. | `evict.ts:196-218` deletes only the session and summary-repair rows | Yes |
| L3 | No delete path cleans the graph. Graph nodes and edges keep citing deleted observations and memories, and the graph retrieval index keeps their postings. | No graph call in `remember.ts` (forget), `governance.ts`, `evict.ts`, `retention.ts`, `auto-forget.ts`; only `cascade.ts` touches it | Yes (upstream #1725 family) |
| L4 | `Session.observationCount` drifts: only capture increments it (`observe.ts:306-311`); `mem::forget`, auto-forget and evict never decrement it. Viewer counts (`state/viewer-counts.ts:103`), CLI totals (`cli.ts:1906`) and session sweep (`session-sweep.ts:69`) read it. | grep of `observationCount` writers | Yes (upstream #1157) |
| L5 | Auto-forget's near-duplicate pass demotes a memory but leaves it in both search indexes, so recall still returns it. | `auto-forget.ts:144-158` has no `remove` | Yes |
| L6 | Deleting any observation from a summarized session breaks the summary's prefix fingerprint, so the next summarize rebuilds the summary from scratch from the rows that remain (`functions/summarize.ts:293-303`; repair is scheduled by `summary-recovery.ts:79`). The new summary has less detail than the old one. | read of `summarize.ts`, `summary-state.ts:27-37` | Latent upstream bug (any `forget` of one observation triggers it). Retention would trigger it at scale, so the fork must guard it (section 5.2). |
| L7 | Auto-forget hard-deletes with no grace and no restore. | `auto-forget.ts:57,187` | Design choice upstream; the fork replaces it (section 8). |

## 3. Data classes

"Digested" means the knowledge in the row exists in a durable, verified form elsewhere, so the row can go without losing what it taught. "Supersession" means a newer row replaces it for the same subject.

| Class | Storage (v0.9.33) | Digested means | How we know (marker) | Supersession | Retention rule |
|---|---|---|---|---|---|
| Raw observation payload (`source`: verbatim tool input and output, prompt, response) | inside each row of `mem:obs:<session>` (`types.ts:54`, `:94`) | The compressed fields of the same row and the session summary exist. | Session seal (below). | None. | Trim: after the trim window, move `source` to trash and keep the row with `source: {hookType, originalBytes, truncated: true}`, the shape the source budget already writes (`observation-source-budget.ts:44`). This frees most bytes and deletes nothing searchable. |
| Compressed observation (title, facts, narrative, importance) | `mem:obs:<session>` | Covered by the session summary, and by any memory or graph item that cites it. | Session seal, plus cited-by checks. | None. | Soft delete after the observation window when the session is sealed and no protection applies. Cited observations stay while what cites them is live. |
| Session row | `mem:sessions` | Not applicable. | — | — | Kept. Small, and summaries need it for context. Never deleted by retention. |
| Session summary | `mem:summaries` | It is the digest. | — | Incremental re-summarize replaces it. | Kept. Deleted only by explicit `mem::forget` of the session. |
| Memory (latest) | `mem:memories` | It is a digest. | — | `mem::remember` (Jaccard > 0.7), `mem::consolidate` (same title or consolidation key). | Never deleted on age alone. Demoted (removed from both indexes, kept in KV) when cold and unprotected. Expired `forgetAfter` goes to soft delete instead of hard delete. |
| Memory (superseded, `isLatest=false`) | `mem:memories` | Its successor exists and is latest. | `isLatest=false` and a resolved chain (successor found, latest, no cycle). | Already superseded. | Out of recall already. Kept as history for the superseded window, then soft delete. |
| Semantic and procedural memories | `mem:semantic`, `mem:procedural` | They are digests. | — | Strength decay (`consolidation-pipeline.ts` `applyDecay`). | Demote only. No deletes in phase 1. |
| Lessons and insights | `mem:lessons`, `mem:insights` | They are digests. | — | Reinforcement on re-save. | Keep the existing decay and soft delete. Never hard-deleted by retention. Fix: recall counts as use (section 6). |
| Graph nodes and edges | `mem:graph:*` plus `mem:graph:retrieval-data` | They are digests of observations. | — | Temporal edges (`isLatest`, `supersededBy`, `tvalidEnd`, `types.ts:515-520`); `stale` from cascade (`types.ts:484,520`). | Kept when their source observations are deleted by retention: the graph is the digest. Their dangling source ids resolve to observation tombstones (section 4.4). Removed or marked stale only by explicit erasure, through the same cascade path as supersede. |
| Keyword and vector index entries, image vectors | Today in process; in the fork, Qdrant behind `am-search` | Derived. | — | — | Follow their record. Removed at soft delete, through the search ports. Reconcile removes leaks. |
| Images on disk | files, ref-counted (`functions/image-refs.ts:7-20`) | Derived from the observation. | — | — | Ref decremented at hard delete, not at soft delete, so a restore finds the file. |
| Capture events | `mem:capture:events:<shard>` | Not a digest; a replay source. | — | — | Tombstoned with `markCaptureEventDeleted` (`capture/event-record.ts:32-52`) at soft delete, so replay cannot re-ingest a deleted observation. |
| Access logs, retention scores, facets | `mem:access`, `mem:retention`, facets | Metadata. | — | — | Deleted with their record at hard delete. |
| Audit | `mem:audit:<month>` | — | — | — | Kept at least as long as the grace period plus one month (decision D8). |
| Slots and core memory | `mem:slots*`, core memory | Agent-curated. | — | — | Out of scope. Retention never touches them. |

### 3.1 The smallest digested marker: the session seal

Today nothing records that an observation was digested (research 06 §6 gap 1). A per-observation marker would mean writing every observation row again. A per-session marker is enough, because the session summary already proves coverage of every row: `summaryCovers()` (`summary-state.ts:35-37`) is true only when the summary's `coveredFingerprint` matches a hash of every compressed row of the session.

New fork scope `mem:retention:seals`, key = session id:

```ts
interface SessionSeal {
  sessionId: string;
  sealedAt: string;            // ISO
  summaryFingerprint: string;  // coveredFingerprint at seal time
  observationCount: number;    // rows covered at seal time
  graphExtracted: boolean;     // graph-extract ran after the last row (false when no LLM provider)
}
```

A session is sealed when all of these hold:
1. The session is not active (`status` completed or abandoned) and its last observation is older than one day, so a late capture cannot reopen it mid-sweep.
2. `summaryCovers(session, rows, summary)` is true.
3. Every row has `compression.status` complete, or the stack does not use LLM compression.

The seal is written by the retention sweep itself, not by upstream code, so no upstream file changes. A session without a summary is never sealed. A stack with no LLM provider never summarizes (`summarize.ts:306-315` returns `no_provider`), so it never seals and retention never deletes its observations. That is the intended safe behaviour; the dry run reports it as "undigested backlog".

## 4. Pipeline

Each sweep is one run with a run id. It is resumable: a progress row records the last session processed, so a crash continues where it stopped (pattern from `cascade.ts` progress keys).

```
digest (existing)  ->  seal  ->  plan  ->  [dry run report]  ->  recall check (before)
   -> soft delete (trash)  ->  recall check (after)  ->  keep or restore run
   -> ... grace period ...  ->  hard delete (purge trash)
```

### 4.1 Digest

Unchanged upstream digestion: summarize on session stop, graph extract, consolidate pipeline, crystallize. Retention adds no LLM calls. It only waits for digestion to finish.

### 4.2 Seal

Page through sessions (`StateKV.iterate`, `state/kv.ts:259`), one page at a time without collecting them. For each unsealed, ended session, load its rows, test section 3.1's conditions, write the seal. A sealed session whose summary later changes (a late capture, a repair) is re-checked: if the fingerprint no longer matches, the seal is removed and the session waits for its new summary.

### 4.3 Plan

For each sealed session, and for memories, compute candidates by stage:

| Stage | Candidates | Default window (decision D1) |
|---|---|---|
| T. Trim source | rows in sealed sessions older than the trim window whose `source` is not already truncated | 30 days |
| O. Observation | compressed rows in sealed sessions older than the observation window, not protected | 180 days |
| S. Superseded memory | `isLatest=false`, chain resolved, older than the superseded window, not protected | 180 days |
| X. Expired memory | `forgetAfter` in the past | immediate (soft delete, then grace) |
| C. Cold memory | latest, retention score below cold, no access in the cold window, not protected | demote at 365 days; delete off by default (D6) |

Each candidate carries the reason and the protection checks it passed. The plan is written to `mem:retention:runs:<runId>` in pages, not held in RAM.

### 4.4 Soft delete

Soft delete moves the row out of its live scope into a trash scope `mem:retention:trash:<runId>`, value `{ scope, key, row, stage, reason, vector }`, where `vector` is the stored embedding read before removal (through the vector port), so a restore never re-embeds. To every upstream reader the row is gone, exactly as after a delete, so no upstream reader needs a "skip deleted" check. That is the main reason to prefer a trash scope over an in-place `deletedAt` flag, which every reader of observations and memories would have to learn.

In the same step, per item:
- Remove the keyword entry and the vector through the existing calls `getSearchIndex().remove(id)` and `vectorIndexRemove(id)` (`functions/search.ts`). In the fork these are the `KeywordIndexPort` and `VectorStorePort` from `design/sonnet/design.md` §5.1, which enqueue `del` and `vec-del` ops in the `SearchOutbox`; the reconcile pass deletes any index entry whose record is missing (design §6.6), so a lost op is repaired. Retention never talks to Qdrant directly.
- Tombstone the capture event (`markCaptureEventDeleted`).
- Remove the observation-to-session index entry (`unindexObservationSession`, `state/obs-index.ts:22`).
- Decrement `Session.observationCount` (fixes L4 for this path).
- Write an observation tombstone to `mem:retention:tombstones` (key = observation id; value = session id, run id, deletedAt, summary id). Graph items and memories that cite the id can then say "digested into session S, removed by run R" instead of pointing at nothing. Tombstones are about 150 bytes each; at 1M observations that is about 150 MB on disk in Kvrocks, nothing in RAM.
- Mark the session `retentionTrimmed` in its seal, so the summary guard (section 5.2) applies.

Trim (stage T) is the same move for the `source` field only: the field goes to trash, the row stays live with the truncated shape. The summary fingerprint hashes id, type, title, narrative, facts, files and concepts but not `source` (`summary-state.ts:27-31`), so a trim does not start a re-summarize and does not set `retentionTrimmed`; only stage O does.

Demote (stage C) does not move the row. It removes it from both indexes and records it in `mem:retention:demoted` so restore can re-index it.

### 4.5 Restore

`restore(runId)` moves every trash entry back to its scope, re-adds index entries (the existing `restoreIndexEntries`, `observe.ts:51-64`, already re-adds keyword and vector for an observation), clears tombstones, re-increments counters. The vector comes back from the trash entry, so a restore makes no embedding call (a vector is about 4 KB at 1024 float dims; it stays on disk in Kvrocks for the grace period only). Restore by item id is also supported.

### 4.6 Hard delete

After the grace period (decision D2), a daily job purges trash scopes older than the grace period: decrement image refs, delete access logs, retention scores and facets for the ids, delete the trash scope. Tombstones stay (they are the provenance for the graph).

Before purging a run, re-check protection for each item: a memory may have started citing an observation during the grace period, or the owner may have pinned it. Such items are restored instead.

### 4.7 Explicit erasure

`mem::forget` stays an immediate hard delete with no grace, because an explicit user request must remove the data now (GDPR Art. 17 framing in research 07). The fork adds graph propagation to it (L3): for each deleted observation, find graph nodes and edges through the retrieval index's `observation` and `edgeObservation` postings (`state/graph-retrieval-index.ts:155,161`) and mark them stale with `mutateIndexedGraphRecord` (`:308`), the same code path `mem::cascade-update` uses. Graph items whose only sources were erased are marked stale, not deleted, in phase 1, so the graph code does not change.

## 5. Re-extraction and rewrite loops

Research 07 names two failure modes: a deleted digest re-derived from raw that still exists (ChatGPT's chat-history re-derivation), and recalled memory captured back as new observations (Mem0 issue #4573: 668 copies of one hallucination). This codebase has three concrete loops.

### 5.1 Replay re-ingesting deleted observations
Guard: capture events are tombstoned at soft delete (section 4.4), as auto-forget already does (`auto-forget.ts:186`).

### 5.2 Summary rewritten after observations are deleted (L6)
Deleting rows from a sealed session makes `summarize` rebuild the summary from what is left. Guard: a fork-only check before summarize runs. When the session's seal has `retentionTrimmed`, skip the rebuild and keep the stored summary. This needs one seam: a check at the top of `mem::summarize` that calls a predicate the fork registers (default: allow), 3 to 5 lines in `summarize.ts`. The predicate also returns "unchanged" to summary recovery, so no repair loop starts.

A late capture into a trimmed session is rare, because stage O only touches sessions whose last observation is older than the observation window. If one arrives, the veto still holds: the stored summary is kept, the new rows stay live and searchable as observations, and the dry-run report lists the session. Incremental summarizing cannot resume, because the old prefix no longer matches. Decision D10 lets the owner choose a rebuild instead.

### 5.3 Injected context captured as observations
The capture filter (`hooks/_capture-filter.ts`) strips secrets and private tags but not `<agentmemory-context>` blocks (`functions/context.ts:269-270`). If tool output or prompts carry those blocks, recalled memories become new observations and feed consolidation. Guard: measure first (count observations containing the tag in the dry run report). If the count is non-zero, strip the blocks at capture, which is an upstream-able change in the capture filter.

### 5.4 Supersession flip-flops
Supersede only by a strictly newer row; refuse to supersede when the target is in the new row's own `supersedes` chain (cycle check over `parentId`). Do not decide contradiction by embedding similarity (AUROC 0.59 in 2606.26511). Auto-forget's Jaccard > 0.9 pass is a near-duplicate detector, not a contradiction detector; it stays as is, with L5 fixed.

## 6. Protection signals

A protected item is never soft-deleted. Each signal must be cheap on disk-backed state: point reads per candidate, or one paged pass over a small collection, never a whole-collection read into RAM.

| Signal | Protects | How it is computed | Cost |
|---|---|---|---|
| Pin | any memory or observation | New fork scope `mem:retention:pins` (id → who, when, reason), set via a REST endpoint and an MCP tool (decision D3: whether to add the MCP tool). The precedent is core memory's `pinned` (`functions/working-memory.ts:15`). | One point read per candidate. |
| Importance floor | observations with importance ≥ 8 (LLM compression only) | Field on the row. | Free. |
| Deliberate save | latest memories | Rule: a latest memory is never deleted on age alone. Covers everything saved through `mem::remember`. | Free. |
| Cited by a live memory | observations | One paged pass over `mem:memories` per sweep (memories are about 1% of observations), collecting `sourceObservationIds` of rows that are latest or still inside their superseded window into a set. Above 500k ids the set spills to a sweep-scratch KV scope. | One pass over memories per sweep. |
| Cited by the graph | observations, for stage O only | Point lookup of the `observation` and `edgeObservation` postings in the graph retrieval index for each candidate. Not a veto: the graph is a digest. It lowers priority so cited rows go last, and the count appears in the report. | Two posting reads per candidate. |
| Cited by an insight | memories (`Insight.sourceMemoryIds`) | Paged pass over `mem:insights` (small). | Small. |
| Retrieval | memories, and observations returned by smart search (`smart-search.ts:174` logs observation ids) | `mem:access` point read (`functions/access-tracker.ts:39`): access within the cold window protects. Absence of access never counts as evidence to delete (2610.02070). | One point read. |
| Lessons | lessons | Excluded from retention deletes. Fix: `mem::lesson-recall` records access so decay can reset on use (research 06 §6 gap 6). | — |
| Recency on the project-active clock | everything | Age counts only days on which the item's project had a session. A project idle for months does not age. Computed from the project's session index (start dates), one read per project per sweep. | One read per project. |
| Type | memories | `architecture` and `preference` memories are never demoted automatically (they match the slowest salience classes in `retention.ts`). | Free. |

## 7. Safeguards

1. **Dry run first.** Every sweep can run in dry-run mode. The report gives counts per stage and per project, bytes freed per stage, a sample of 20 items per stage with reasons, protection hits per signal, the undigested backlog (sessions without a seal and why), the injected-context count (section 5.3), and the diff from the last report. New stacks start in report-only mode for the first runs (decision D4).
2. **Restore window.** Soft delete into trash, grace period per stack (D2), restore by run or by id.
3. **Protection rules.** Section 6, re-checked again at purge time.
4. **Recall check before and after.** A fixed query set per stack: the stack's recall eval golden cases (spec AC4) plus rare-fact and knowledge-update cases drawn from protected memories. Run before soft delete and after. If recall@10 drops by more than the stop threshold (D5) or any golden case loses its evidence, the run restores itself and the report says why. Recall and deletion correctness are reported separately (2606.15903: they are independent axes).
5. **Conservative first threshold.** The first enforcing run on each stack soft-deletes at most 10% of observations (Selective Forgetting, 2608.28978: about 10% pruned with no significant recall change). Later runs may raise the cap only after a clean recall check.
6. **Audit.** One audit entry per run and per stage with counts, run id and reason (batched, as `retention-evict` does at `retention.ts:403`). New audit operations: `retention_seal`, `retention_soft_delete`, `retention_restore`, `retention_purge`, `retention_demote`.
7. **Bounded work.** Paged reads, a per-run item cap, a pause between pages, and a lock so two sweeps never overlap.
8. **Kill switch.** One setting turns retention off; the default is off until the owner enables it per stack.

## 8. Changes to existing behaviour

| Change | Why | Where |
|---|---|---|
| Raise `MAX_OBS_PER_SESSION` to 5000 on both stacks (the import ceiling, `config.ts:16`) | Fixes L1 with configuration only. With disk-backed storage, the 500 cap no longer protects RAM. | Stack configuration (decision D9). |
| Disable auto-forget's observation and TTL clauses on the fork (`AUTO_FORGET_ENABLED=false`), and run its near-duplicate pass from the retention sweep instead | Its deletes have no grace, no restore, no digest check (L7), and it reads every observation into RAM. The retention sweep covers TTL (stage X) and age (stage O). | Configuration plus the sweep. No upstream edit. |
| Evict stays manual and is documented as unsafe on the fork | L2 orphans data. | Docs; fix L2 upstream-ready in a separate PR. |
| `mem::forget` cleans the graph (L3) and decrements the counter (L4) | Erasure must reach every derived copy. | Small upstream-able change in `remember.ts` calling a shared helper. |
| Auto-forget's near-duplicate pass removes the demoted memory from both indexes (L5) | Same rule as `mem::remember`. | Two lines in `auto-forget.ts`, upstream-able. |
| Lesson recall records access (gap 6) | Recall is use. | Upstream-able. |

## 9. Owner decisions

Buddy's owner decides buddy's rows. All windows count project-active days.

| # | Decision | Options | Recommended default | Effect |
|---|---|---|---|---|
| D1 | Windows per stack: trim, observation, superseded, cold | any number of days; "never" | main: trim 30, observation 180, superseded 180, cold demote 365. buddy: its owner decides; suggest the same with report-only first. | Shorter frees disk sooner and raises the chance of losing detail that the summary did not keep. |
| D2 | Grace period per stack | 7 to 90 days | 30 days | Longer keeps deleted bytes on disk longer; shorter narrows the restore window. |
| D3 | Which signals protect | each row of section 6 | all of them; add the pin endpoint; MCP pin tool only if wanted (it changes the tool count, AC5) | Fewer signals delete more. |
| D4 | Start mode | enforce at once; report-only for N runs | report-only for 2 weekly runs per stack, owner reads the report, then enforce | Delays freeing disk by two weeks. |
| D5 | Recall stop threshold | points of recall@10 drop | 2 points (matches spec AC4) or any golden case lost | Lower stops more runs. |
| D6 | Cold memories | demote only; demote then delete after N days | demote only | Delete would free little (memories are small) and is the riskiest stage. |
| D7 | Erasure | immediate hard delete; soft delete with grace | immediate, with graph propagation | Matches user intent and erasure rules. |
| D8 | Audit retention | months | 13 months | Must exceed the grace period so purges stay explained. |
| D9 | Per-session cap | 500; 5000; 0 (uncapped) | 5000 | Long sessions stop losing captures; exports stay importable. |
| D10 | Trimmed session that receives new captures | keep the stored summary and leave new rows unsummarized; rebuild the summary from the remaining rows | keep | A rebuild loses the detail the deleted rows gave the old summary; keeping leaves a few late rows outside the summary. |
| D11 | Sweep schedule | daily; weekly; manual | weekly, off-peak | Weekly bounds the cost of the recall check. |

## 10. Where the code lives (rebase-friendliness)

Fork-only files, no upstream conflict risk:
- `src/fork/retention/sweep.ts`: seal, plan, soft delete, purge, run progress.
- `src/fork/retention/protect.ts`: section 6 signals.
- `src/fork/retention/restore.ts`.
- `src/fork/retention/report.ts`: dry run report.
- `src/fork/retention/recall-check.ts`: wraps the recall eval harness.
- `src/fork/retention/register.ts`: registers `mem::retention-*` functions, REST endpoints and the timer.
- tests under `test/fork/retention/`.

Upstream seams, each small and upstream-able on its own:
- `src/index.ts`: one call to the fork's register function (the same seam the search runtime uses).
- `src/functions/summarize.ts`: the veto predicate (section 5.2), 3 to 5 lines.
- `src/state/schema.ts` and `src/types.ts`: new scopes (`mem:retention:seals`, `:trash:<run>`, `:tombstones`, `:pins`, `:runs:<run>`, `:demoted`) and audit operations, as AGENTS.md requires.
- `src/triggers/api.ts`: REST endpoints (report, run, restore, pin), with the endpoint count synced by `npm run docs:sync`.
- Upstream-able fixes L2 to L5 and the lesson-recall access log, each its own commit.

No change to graph code (`cascade.ts`, `graph-retrieval-index.ts` are called, not edited), search engine code, or the search worker: retention uses the ports.

Dependency: the sweep needs the paged-read work from the disk design (it must not call `collectAll` on observations or memories), and its index deletes go through the search ports. It can run before the Qdrant cutover, because in memory mode the same calls hit the in-process indexes.

## 11. Draft acceptance criteria for TEE-1158 (retention implementation)

Each criterion states behaviour and the check that proves it. No file paths; those are in the agent notes.

- [ ] R1. A dry run changes nothing and reports the plan. Check: run a dry-run sweep on a staging copy; record counts of every collection and the keyword and vector index sizes before and after; they are equal. The report lists counts and bytes per stage and project, 20 sample items per stage with reasons, protection hits per signal, the undigested backlog, and the injected-context count.
- [ ] R2. Raw data is removed only from digested sessions. Check: on a fixture with one summarized ended session, one session without a summary, one active session, and one session whose summary is out of date, an enforcing sweep with zero windows trims and soft-deletes only the first session's rows.
- [ ] R3. A soft-deleted item disappears from keyword, vector and graph-backed recall at once and comes back after restore. Check: soft-delete a known observation and a known expired memory; search for each by keyword and by vector (none returned); restore the run; both are returned again with the same content, and the session's observation count is back to its earlier value.
- [ ] R4. Hard delete happens only after the grace period. Check: with a 1-day grace on staging, a soft-deleted item is still restorable after 23 hours and is gone from storage, trash and both indexes after 25 hours; its image file is removed only if no other row references it.
- [ ] R5. Protected items are never deleted. Check: on a fixture, a pinned observation, an observation cited by a latest memory, an observation with importance 9, a latest memory with no access for two years, an architecture memory, and a lesson all survive an enforcing sweep with zero windows. The report lists each under its protecting signal.
- [ ] R6. Superseded memories leave recall at once and are removed only after their window. Check: save a memory, then save a revision that supersedes it; recall returns only the revision; with a zero superseded window and zero grace, a sweep plus purge removes the old version; the revision and its version number are unchanged.
- [ ] R7. A summary is not rewritten because retention removed its observations. Check: summarize a session, trim and soft-delete its observations, trigger summarize again; the stored summary is byte-identical.
- [ ] R8. Retention cannot re-create what it deleted. Check: after a sweep, replay the capture log for the swept sessions; no soft-deleted observation reappears; a second dry run reports zero new candidates for those sessions.
- [ ] R9. A sweep that hurts recall undoes itself. Check: on staging, force a run that deletes the evidence of a golden recall case; the after-check fails, the run restores every item, and the audit log and report record the restore and its reason.
- [ ] R10. Explicit forget removes the data now and marks dependent graph items stale. Check: forget an observation cited by graph nodes and edges; it is gone from storage and both indexes with no grace; the dependent graph items are marked stale and no longer returned by graph queries.
- [ ] R11. Session observation counts stay correct. Check: after forget, a sweep and a restore on a fixture, each session's stored observation count equals the number of its stored observation rows.
- [ ] R12. A sweep keeps memory bounded and resumes after a crash. Check: run a sweep on a staging copy at full size while sampling container memory peak; the peak stays within the stack's limit and does not scale with observation count. Kill the process mid-sweep; the next run resumes from its progress record, and no item is both live and in trash.
- [ ] R13. Every run is audited. Check: after a dry run, an enforcing run, a restore and a purge, the audit log holds one entry per run and stage with counts, run id and reason.
- [ ] R14. Long sessions no longer lose captures. Check: with the per-session cap at its new value, a session of 1,000 observations stores all 1,000, and none is refused.
- [ ] R15. The first enforcing run on a production stack is preceded by the owner's reading of two dry-run reports, uses that stack's decided windows and grace period, and soft-deletes at most 10% of its observations. Check: the reports and the run's audit entry, linked in the issue.

+++ Agent notes

- Design note: `docs/fork/retention-design.md` (this file).
- Fork code: `src/fork/retention/*`, tests in `test/fork/retention/`.
- Seams: `src/index.ts` (register), `src/functions/summarize.ts` (veto predicate for R7), `src/state/schema.ts` + `src/types.ts` (scopes, audit ops), `src/triggers/api.ts` (endpoints). Follow AGENTS.md consistency lists; run `npm run docs:sync`.
- Reuse: `summaryCovers` (`src/functions/summary-state.ts`), `restoreIndexEntries` (`src/functions/observe.ts`), `markCaptureEventDeleted` (`src/capture/event-record.ts`), `unindexObservationSession` (`src/state/obs-index.ts`), `decrementImageRef` (`src/functions/image-refs.ts`), `mutateIndexedGraphRecord` and graph postings (`src/state/graph-retrieval-index.ts`), `getAccessLog` (`src/functions/access-tracker.ts`), `StateKV.iterate` (`src/state/kv.ts`).
- Upstream-able fixes, separate commits: evict stale-session orphan (L2), forget graph cleanup (L3), counter decrement on every delete path (L4), auto-forget index removal on demote (L5), lesson-recall access.
- R12 depends on the paged-read series from the disk design.

+++

## 12. Open questions and conflicts

1. **NR1 settings not verified.** I could not read NR1's environment (production read was not permitted in this session). Whether auto-compress is on decides whether auto-forget's importance clause can fire and whether the importance floor signal exists. Check `AGENTMEMORY_AUTO_COMPRESS`, `AUTO_FORGET_ENABLED` and `MAX_OBS_PER_SESSION` on both stacks.
2. **Research 06 versus v0.9.33.** The per-session cap refuses captures in v0.9.33; research 06 describes newer upstream code that deletes the oldest. The next rebase will change L1's shape; the fix (raise the cap) works for both.
3. **No study measures digest-then-delete-raw against keep-raw** (research 07, gaps). That is why the recall check, the 10% first-run cap and the trim-before-delete order exist. Trim alone may free enough disk that stage O can stay off; the dry-run report's bytes per stage answers this.
4. **Spec AC6** says a deleted memory disappears from graph results. Today graph items cite observations, not memories, so a deleted memory has no graph items of its own. Retention's stale marking keys on observations. The owner may want to confirm AC6 means "graph items from the deleted memory's source observations".
5. **Vectors in trash.** Trash entries keep the vector so restore never re-embeds (orchestrator review, 2026-11-17). This needs the vector port to expose a read of one stored vector; the in-memory `VectorIndex` and the Qdrant worker both can.
