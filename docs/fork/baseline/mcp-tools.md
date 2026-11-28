# MCP tool latency on buddy's replica (TEE-1451)

Production `/agentmemory/mcp/call` ran at p50 981 ms and p95 8.7 s on main on 2026-11-27, with no tool name in the log. Each call now logs one `MCP tool call` line (`tool`, `status`, `ms`; a name that is not a tool logs as `unknown`), so the production mix can be read from the agentmemory worker log. On the replica, eight tools were over 1 s at p95. Export dropped 26×, keyword timeline 2.7× and project-scoped smart search about 1.5×, with results unchanged.

## Results

`bench/fork/mcp-tools.ts`, one call at a time, tools interleaved round-robin. Reads ran 15 rounds and writes 10. Before is `origin/disk` (`0118f33`), after is this branch. Sorted by before p95.

| Tool (variant) | n | Before p50 / p99 ms | After p50 / p99 ms |
|---|---|---|---|
| `memory_timeline.keyword` | 15 | 43,131 / 50,498 | 16,035 / 18,240 |
| `memory_timeline.date` | 15 | 2,091 / 12,078 | 1,329 / 8,635 |
| `memory_export` | 15 | 4,195 / 4,789 | 160 / 263 |
| `memory_diagnose` | 15 | 2,571 / 3,100 | 2,262 / 2,945 |
| `memory_reflect` | 10 | 2,149 / 2,319 | 2,028 / 2,786 |
| `memory_patterns` | 15 | 396 / 1,159 | 405 / 980 |
| `memory_graph_query` | 15 | 626 / 756 | 579 / 962 |
| `memory_file_history` | 15 | 652 / 748 | 533 / 652 |
| `memory_sessions` | 15 | 344 / 426 | 361 / 514 |
| `memory_audit` | 15 | 291 / 368 | 301 / 474 |
| `memory_smart_search.project-all` | 15 | 68.7 / 361 | 56.7 / 355 |
| `memory_smart_search.project-memory` | 15 | 24.7 / 154 | 15.6 / 101 |
| `memory_recall` | 15 | 13.2 / 130 | 12.4 / 122 |
| `memory_smart_search.all` | 15 | 12.6 / 124 | 12.1 / 128 |
| `memory_insight_list` | 15 | 56.9 / 87.4 | 55.3 / 95.8 |
| `memory_save` | 10 | 48.5 / 55.0 | 47.6 / 163 |
| `memory_smart_search.memory` | 15 | 11.8 / 42.7 | 11.7 / 50.4 |
| `memory_smart_search.expand` | 15 | 4.1 / 12.1 | 4.0 / 7.7 |
| `memory_lesson_save` | 10 | 8.3 / 12.1 | 4.8 / 10.8 |
| `memory_lesson_recall` | 15 | 7.8 / 11.5 | 6.8 / 12.6 |
| `memory_frontier` | 15 | 3.6 / 6.6 | 3.3 / 4.9 |
| `memory_smart_search.expand-project` | 15 | 3.5 / 6.4 | 3.3 / 5.7 |
| `memory_relations` | 15 | 3.5 / 6.0 | 3.2 / 12.7 |
| `memory_next` | 15 | 3.3 / 6.0 | 2.8 / 8.4 |
| `memory_facet_query` | 15 | 2.3 / 3.6 | 1.8 / 2.9 |
| `memory_verify` | 15 | 2.0 / 3.0 | 1.8 / 3.7 |
| `memory_consolidate` | 10 | 2.3 / 2.8 | 2.0 / 2.8 |
| `memory_commits` | 15 | 2.1 / 2.7 | 1.9 / 12.8 |
| `memory_team_feed` | 15 | 2.2 / 2.7 | 2.1 / 5.3 |
| `memory_vision_search` | 15 | 1.9 / 2.3 | 1.8 / 2.8 |

The replica runs on an idle 16-core workstation. Production NR1 is CPU-bound (4 cores, load about 4), and its MCP calls are 10 to 30 times slower than these, so read the deltas, not the absolute numbers. `memory_commit_lookup` is not timed, because buddy's store has no commits. `memory_save` p99 163 ms is one outlier in 10 samples; its p50 is unchanged, and the save path is untouched.

## Causes and fixes

Each state read is a round trip to the iii engine and then Kvrocks. Every fix below cuts reads or waits that depend on each other, and keeps the output byte-identical. Each tool's output is pinned by a snapshot taken on the old code, and its read count by a ceiling in `test/*-read-cost.test.ts`.

| Tool | Cause | Fix | Fixture reads / chain depth, before → after |
|---|---|---|---|
| `memory_smart_search` with `project` | Agents send `{query, project, targetLayer: "memory"}`. The project filter left fewer than `limit` hits in 23 of 26 calls, so a second 1,000-candidate pass ran. Each memory was read up to four times: by enrich (observation scope first), by the second enrich, by the project matcher (10 at a time) and by the compact step. | One read cache per call, shared by both passes, the matcher and the compact step. Memory-layer hits read `KV.memories` first. | 2,500 / 80 waves → 770 / 3 (rare project) |
| `memory_timeline` | A keyword anchor scanned every session's observations one session at a time, then scanned them all again for the window. | One scan, 16 sessions at a time, serves both. | 722 / 498 → 361 / 25 |
| `memory_export` | Collections that were not asked for were still read in full, only to report their totals. | Their totals come from a key count (`countRows`). | 721 / 75 → 321 / 41 |
| `memory_diagnose` | 15 categories ran one after another, and actions were read 3 times, leases and edges twice. | Categories run together over one per-call scope reader. | 1,372 / 129 → 1,037 / 25 |
| `memory_file_history` | The 15 newest sessions were listed one after another. | Listed together. | 91 / 35 → 91 / 7 |

## Bounds left in place

| Tool | After p95 | Why it stays over 1 s |
|---|---|---|
| `memory_timeline` | 18.2 s keyword, 8.6 s date | The window is global and ordered by time, so it must read every observation of every session in scope (357,592 on buddy). The keyword match is a substring scan of the same rows. A time-ordered observation index would bound it; that is a schema change. |
| `memory_diagnose` | 2.9 s | The facets category still scans every session's observations when an observation-targeted facet is not live through the session index, and the sessions category lists all 3,094 sessions. Both are the check itself. |
| `memory_reflect` | 2.8 s | Clustering, then one LLM `summarize` call per cluster, run in sequence by design. Agents did not call it in a week of transcripts. |
| `memory_patterns`, `memory_graph_query` | about 1 s | Patterns lists every session to pick a project's newest ones. The project session index caps at 50 per project, so swapping it in would change results for larger projects. Graph query walks a first-character posting list one get at a time, capped at 2,048 reads; a word posting needs an index rebuild. |

`memory_smart_search` with `project` and every layer (p95 355 ms) is spent in the keyword leg (up to 955 ms in the profile). That is the keyword candidate code TEE-1213 owns, and this branch does not change it. The graph leg cost about 0 ms on this store, and the vector leg was not measured (keyword-only).

## Verification

- **Golden:** fixed inputs, 3 per read tool, 72 bodies. 66 are identical before and after. The 6 that differ (`memory_audit`, `memory_export`) differ the same way on two runs of unchanged code: the bench's own searches add audit rows and access-log rows between runs. In export only `collectionPagination.totals.accessLogs` moved (10,516 to 10,711). Frontier and next are timed, not compared, because they score actions by age.
- **Recall:** buddy's 100 private cases, keyword-only, give recall@10 0.86 and MRR 0.7387 on both images (floor 0.86 / 0.7347).
- **Ceilings:** `bench/fork/ceilings.json` entry `mcp-buddy-keyword`. The after run passes. The before run fails on keyword timeline (43 s against a 24 s p50 ceiling) and export (4.2 s against 400 ms).

## Reproduce

Hold a replica lock first (`/tmp/am-replica2.lock` or `3`).

```
export REPLICA_PROJECT=tee1451 S12_DIR=<private dir holding cases.json> S12_BACKUP=/home/cownose/am-staging/buddy-2026-11-16 AM_IMAGE=<image>
bench/fork/retention/stage.sh load && bench/fork/retention/stage.sh fill && bench/fork/retention/stage.sh app
bench/fork/retention/stage.sh client node --import tsx bench/fork/mcp-tools.ts --cases /private/cases.json \
  --project plus-one-engine --project cath-alert --project weaving-master --project three-brothers-erp \
  --project lost-in-space --project catan --rounds 15 --golden-out /tmp/golden.json --out /tmp/result.json \
  --ceilings bench/fork/ceilings.json --name mcp-buddy-keyword
bench/fork/retention/stage.sh down
```

Swap the image with `stage.sh app` and the next `AM_IMAGE`, then pass `--golden-compare /tmp/golden.json`. Golden mode skips the write pass, so run `--rounds 1 --write-rounds 10` separately to time the writes.
