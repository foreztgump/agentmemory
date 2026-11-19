# Whole-collection read inventory: buddy replica, 2026-11-18

This inventory lists every whole-collection read (`list`, `listKeys`, `iterate`, `listPage`) that buddy's data causes in one day of traffic. Use it to order the work in TEE-1160. It covers the code on `disk` at d148219: the TEE-1156 scope guard, the TEE-1159 capture path (maintained session stats and a paged inbox), and the guard's restart carry-over added on this branch.

## Results

- **About 154 GB of whole-collection reads a day.** Six call sites cause 99% of it.
- **One site dominates.** The health tick's index reconcile (`findUnindexedObservations`, row 1) lists about 1,770 sessions every 2 to 3 minutes, which comes to 1.0 million lists and about 100 GB a day. It lists every session whose stored observation count exceeds what the keyword index holds. On buddy that is permanent: 128,876 observations have no narrative, so the index skips them, and those sessions are listed again on every pass. This site, auto-forget's walk over every session (row 3), context injection (row 5) and the session list behind the reconcile (row 6) make up about 114 GB a day. TEE-1160 must convert these first.
- **The capture sweeps page through the whole inbox.** On buddy the inbox holds 1,006 rows (3.5 MB). Each sweep and each health tick pages through all of it: rows 2 and 4, about 40 GB a day. These are paged reads (`iterate`), so they meet the `paged-only` rule in `SCOPE_CLASS`. They are still full scans that run about 11,500 times a day. TEE-1160 should cap or index them, not just page them.
- **TEE-1159 AC1 holds on the replica: PASS.** Over the whole run, the inventory has no row whose call site is `mem::observe` or `api::observe`, and no `list` of `mem:capture:inbox`. Capture reads the inbox in only two ways: paged `iterate` scans from the sweep timers and the status reporters, and one `listKeys` count from `mem::capture`.
  - One exception showed up only on an earlier, aborted run. During the first boot, `mem::observe` iterated `mem:obs:*` twice, with 0 items each time. That happened while the one-time stats repair was still running. The repair sets a ready marker when it finishes, and after that capture reads only the stats row.
- **Buddy's data does not fit a 2560m container on this code.** Node's heap cap is half the container limit.
  - At 2560m (1,280 MB heap), the worker hit a V8 heap OOM about 150 s after every start under replay load and restarted 26 times in an hour.
  - At 3200m (1,600 MB heap), it ran for 59 minutes, then OOMed twice.
  - At 3584m (1,792 MB heap), the run below completed with no restarts.
  - Production buddy runs at 2g. The production logs restored from its data volume show the same `heap out of memory` crashes at about 1 GB of heap.
- **Export fails on buddy.** `GET /agentmemory/export` returned 413: the 60.6 MiB reply exceeds the engine's 60 MiB message limit. It had already read 1,126 of 3,192 session scopes.

## How the run was made

| Setting | Value |
|---|---|
| Data | buddy's nightly backup of 2026-11-16: 3,094 sessions, 357,592 observations, 2.13 GB in Valkey |
| Image | `am-inventory:guard-carry`, built with `deploy/Dockerfile` from this branch |
| Replica | `bench/fork/replica.sh up` on an internal network, keyword-only (no embedding provider), no LLM provider, `AGENTMEMORY_SCOPE_GUARD=warn` |
| Memory limits | agentmemory `AM_MEM_LIMIT=3584m`; Valkey `VALKEY_MEM_LIMIT=2560m`, `VALKEY_MAXMEMORY=2400mb`; 6 GiB in total |
| Traffic | `scripts/fork/replay-day.ts` at buddy's mean rate over 2026-11-02..15: 12,200 observations, 98 sessions and 600 searches a day, `--factor 24` (one day in 60 minutes) |
| Window | From the boot snapshot (19:56:00 UTC, after the one-time stats repair) to the day snapshot (21:15:00). That is 79.0 minutes, because the driver exits only after its last calls return. |
| One-off calls | After the day snapshot: one call to each viewer list endpoint, export, reflect, crystallize, consolidate, consolidate-pipeline, diagnostics and heal. Then a third snapshot. |

**Scaling.** The driver plays a whole day, so the reads it causes count once (`x1`). The server's own timers ran in real time: the 30 s summary recovery, the capture sweeps and prune, and the health tick with its `event::viewer::health-changed` reads. Their counts are multiplied by 1440 / 79.0 = 18.23 (`timer`). The replica turns off the server's auto-forget, consolidation and session-sweep timers, and the driver fires those itself.

**Auto-forget rate.** The driver fires auto-forget hourly, as upstream's default does. The buddy deploy notes say that buddy runs it daily (`AUTO_FORGET_INTERVAL_MS=86400000`). At that rate, row 3 drops to about 3,140 lists and 536 MB a day.

**Consolidation.** The replica sets `CONSOLIDATION_ENABLED=false` and has no LLM provider, so `consolidate-pipeline` returned before it read anything. The on-demand table includes `mem::consolidate`'s walk over every session, which runs without a provider.

**Calls that did not complete with no LLM provider.**
- `reflect` returned `success: false` (its one cluster failed), but its reads happened.
- `consolidate-pipeline` was disabled, as described above.
- `crystals/create` needs real action ids. `crystals/auto` found no actions.
- `profile` needs `?project=`; it was called with the replay project.

**Columns.**
- **Scope** is the class in `src/fork/kv/scope-classes.ts`. `mem:obs:<session>` is bounded per session, but the sites marked `yes` on it walk every session, or many sessions, per call.
- **TEE-1160** says whether a row must be converted:
  - `yes`: a recurring unpaged `list` of a growing scope, or a recurring walk over many sessions.
  - `on demand`: the same kind of read, but reached only from an endpoint a person calls.
  - `no`: a paged read, or a bounded one.
- **Max reply MB** is the largest single reply as JSON. **MB/day** is the total for the day.

Collections are normalised: ids are `*`, and `mem:obs:*` covers every session scope. Call sites are resolved to source lines through the image's source map. The raw inventory is kept outside the repo, at `/home/cownose/am-staging/inventory/buddy-2026-11-18*.json`.

## Recurring reads per day

| # | Collection | Op | Call site | Owner | Scope | Calls/day | Max items | Max reply MB | MB/day | Scaled | TEE-1160 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | mem:obs:* | list | `event::viewer::health-changed` src/functions/search.ts:438 | status / health (index reconcile) | bounded | 1,001,385 | 2,000 | 9.18 | 99,681 | timer | yes |
| 2 | mem:capture:inbox | iterate | `-` src/fork/kv/paged-scan.ts:14 | capture (sweep timers) | growing (paged-only) | 8,658 | 1,006 | 3.48 | 30,003 | timer | no |
| 3 | mem:obs:* | list | `mem::auto-forget` src/functions/auto-forget.ts:163 | retention (auto-forget) | bounded | 75,444 | 2,000 | 9.97 | 12,857 | x1 | yes |
| 4 | mem:capture:inbox | iterate | `event::viewer::health-changed` src/fork/kv/paged-scan.ts:14 | status / health | growing (paged-only) | 2,880 | 1,008 | 3.48 | 9,981 | timer | no |
| 5 | mem:obs:* | list | `mem::context` src/functions/context.ts:231 | context injection | bounded | 2,741 | 137 | 0.29 | 754 | x1 | yes |
| 6 | mem:sessions | list | `event::viewer::health-changed` src/functions/search.ts:432 | status / health (index reconcile) | growing (paged-only) | 565 | 3,192 | 1.21 | 675 | timer | yes |
| 7 | mem:capture:events:* | iterate | `-` src/fork/kv/paged-scan.ts:14 | capture (sweep timers) | growing (paged-only) | 4,666 | 80 | 0.02 | 81 | timer | no |
| 8 | mem:obs:* | list | `mem::summarize` src/functions/summarize.ts:282 | summaries | bounded | 197 | 137 | 0.29 | 54 | x1 | no |
| 9 | mem:obs:* | list | `mem::summary-repair` src/functions/summary-recovery.ts:77 | summaries | bounded | 128 | 137 | 0.29 | 35 | x1 | no |
| 10 | mem:memories | iterate | `mem::auto-forget` src/functions/auto-forget.ts:43 | retention (auto-forget) | growing (paged-only) | 24 | 760 | 1.33 | 32 | x1 | no |
| 11 | mem:sessions | list | `mem::auto-forget` src/functions/auto-forget.ts:159 | retention (auto-forget) | growing (paged-only) | 24 | 3,190 | 1.21 | 29 | x1 | yes |
| 12 | mem:lessons | list | `mem::context` src/functions/context.ts:78 | context injection | growing (paged-only) | 294 | 88 | 0.10 | 28 | x1 | yes |
| 13 | mem:obs:* | list | `event::session::stopped` src/triggers/events.ts:73 | summaries | bounded | 100 | 137 | 0.29 | 27 | x1 | no |
| 14 | mem:summary:repairs | list | `mem::summary-recover` src/functions/summary-recovery.ts:105 | summaries | growing (paged-only) | 2,880 | 98 | 0.01 | 26 | timer | yes |
| 15 | mem:capture:prompts | iterate | `-` src/fork/kv/paged-scan.ts:14 | capture (sweep timers) | growing (paged-only) | 18 | 770 | 0.16 | 2.87 | timer | no |
| 16 | mem:lessons | list | `mem::lesson-recall` src/functions/lessons.ts:39 | lessons | growing (paged-only) | 18 | 88 | 0.10 | 1.74 | timer | yes |
| 17 | mem:sessions | list | `api::session::start` src/state/session-index.ts:72 | sessions | growing (paged-only) | 1 | 3,095 | 1.18 | 1.18 | x1 | yes |
| 18 | mem:metrics | list | `event::viewer::health-changed` src/eval/metrics-store.ts:57 | status | bounded | 5,760 | 1 | 0.00 | 0.92 | timer | no |
| 19 | mem:insights | iterate | `mem::insight-decay-sweep` src/functions/reflect.ts:658 | reflect | growing (paged-only) | 1 | 485 | 0.44 | 0.44 | x1 | no |
| 20 | mem:lessons | list | `mem::lesson-decay-sweep` src/functions/lessons.ts:324 | lessons | growing (paged-only) | 1 | 88 | 0.10 | 0.10 | x1 | yes |
| 21 | mem:capture:inbox | listKeys | `mem::capture` src/fork/kv/paged-scan.ts:21 | capture | growing (paged-only) | 1 | 1,000 | 0.05 | 0.05 | x1 | no |
| 22 | mem:recent-searches | list | `mem::diagnostic::recent-searches-sweep` src/functions/recent-searches-sweep.ts:18 | search | growing (paged-only) | 25 | 0 | 0.00 | 0.00 | x1 | yes |
| 23 | mem:facets | list | `mem::lesson-decay-sweep` src/functions/facets.ts:69 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | 0.00 | x1 | yes |


## Boot reads (once per start)

The boot index rebuild lists every session (3,094 lists, 522 MB). Then the first health tick runs the reconcile scan (1,772 lists, 177 MB). Every restart repeats both. The stats repair (`observation-stats.ts:90`) runs once per store, on the first boot after TEE-1159, and it read 2,979 sessions (522 MB) in about 48 s on buddy (74 s on an earlier run).

| Collection | Op | Call site | Owner | Scope | Calls | Max items | Max reply MB |
|---|---|---|---|---|---|---|---|
| mem:obs:* | list | `-` src/functions/search.ts:641 | search (boot index rebuild) | bounded | 3,094 | 2,000 | 9.97 |
| mem:obs:* | iterate | `-` src/fork/kv/observation-stats.ts:90 | capture (one-time stats repair) | bounded | 2,979 | 2,000 | 9.97 |
| mem:obs:* | list | `event::viewer::health-changed` src/functions/search.ts:438 | status / health (index reconcile) | bounded | 1,772 | 2,000 | 9.18 |
| mem:capture:inbox | iterate | `-` src/fork/kv/paged-scan.ts:14 | capture (sweep timers) | growing (paged-only) | 7 | 1,006 | 3.48 |
| mem:capture:inbox | iterate | `api::status` src/fork/kv/paged-scan.ts:14 | status / health | growing (paged-only) | 7 | 1,000 | 3.47 |
| mem:semantic | list | `event::viewer::health-changed` src/state/viewer-counts.ts:59 | viewer | growing (paged-only) | 1 | 14,336 | 17 |
| mem:capture:inbox | iterate | `event::viewer::health-changed` src/fork/kv/paged-scan.ts:14 | status / health | growing (paged-only) | 3 | 1,008 | 3.48 |
| mem:capture:events:* | iterate | `-` src/fork/kv/paged-scan.ts:14 | capture (sweep timers) | growing (paged-only) | 256 | 80 | 0.02 |
| mem:memories | list | `event::viewer::health-changed` src/state/viewer-counts.ts:59 | viewer | growing (paged-only) | 1 | 760 | 1.33 |
| mem:memories | iterate | `-` src/functions/search.ts:541 | search (boot index rebuild) | growing (paged-only) | 1 | 760 | 1.33 |
| mem:sessions | list | `event::viewer::health-changed` src/functions/search.ts:432 | status / health (index reconcile) | growing (paged-only) | 1 | 3,192 | 1.21 |
| mem:sessions | list | `event::viewer::health-changed` src/state/viewer-counts.ts:59 | viewer | growing (paged-only) | 1 | 3,094 | 1.18 |
| mem:sessions | iterate | `-` src/functions/search.ts:541 | search (boot index rebuild) | growing (paged-only) | 1 | 3,094 | 1.18 |
| mem:capture:prompts | iterate | `-` src/fork/kv/paged-scan.ts:14 | capture (sweep timers) | growing (paged-only) | 1 | 770 | 0.16 |
| mem:procedural | list | `event::viewer::health-changed` src/state/viewer-counts.ts:59 | viewer | growing (paged-only) | 1 | 43 | 0.14 |
| mem:lessons | list | `event::viewer::health-changed` src/state/viewer-counts.ts:59 | viewer | growing (paged-only) | 1 | 88 | 0.10 |
| mem:summary:repairs | list | `mem::summary-recover` src/functions/summary-recovery.ts:105 | summaries | growing (paged-only) | 3 | 98 | 0.01 |
| mem:crystals | list | `event::viewer::health-changed` src/state/viewer-counts.ts:59 | viewer | growing (paged-only) | 1 | 2 | 0.01 |
| mem:metrics | list | `api::status` src/eval/metrics-store.ts:57 | status | bounded | 7 | 1 | 0.00 |
| mem:metrics | list | `event::viewer::health-changed` src/eval/metrics-store.ts:57 | status | bounded | 6 | 1 | 0.00 |
| mem:actions | list | `event::viewer::health-changed` src/state/viewer-counts.ts:59 | viewer | growing (paged-only) | 1 | 0 | 0.00 |


## On-demand reads (one call to each feature)

These rows were made by the one-off calls after the day ended. Each comes from an endpoint a person or an agent calls, not from capture or a timer.

| Collection | Op | Call site | Owner | Scope | Calls | Max items | Max reply MB | TEE-1160 |
|---|---|---|---|---|---|---|---|---|
| mem:semantic | iterate | `mem::reflect` src/functions/reflect.ts:364 | reflect | growing (paged-only) | 2 | 14,336 | 17 | no |
| mem:semantic | iterate | `api::consolidation-status` src/triggers/api.ts:484 | viewer / REST lists | growing (paged-only) | 1 | 14,336 | 17 | no |
| mem:semantic | iterate | `mem::diagnose` src/functions/diagnostics.ts:473 | diagnostics | growing (paged-only) | 1 | 14,336 | 17 | no |
| mem:obs:* | list | `mem::consolidate` src/functions/consolidate.ts:102 | consolidation | bounded | 3,192 | 2,000 | 9.97 | on demand |
| mem:obs:* | iterate | `mem::export` src/state/graph-generation.ts:102 | export | bounded | 1,126 | 500 | 4.85 | on demand |
| mem:summaries | list | `api::consolidation-status` src/triggers/api.ts:482 | viewer / REST lists | growing (paged-only) | 1 | 1,810 | 3.77 | on demand |
| mem:summaries | list | `mem::export` src/state/graph-generation.ts:108 | export | growing (paged-only) | 1 | 1,810 | 3.77 | on demand |
| mem:summaries | list | `mem::diagnose` src/functions/diagnostics.ts:444 | diagnostics | growing (paged-only) | 1 | 1,810 | 3.77 | on demand |
| mem:audit:* | iterate | `mem::audit-query` src/functions/audit.ts:271 | audit | growing (paged-only) | 1 | 2,423 | 3.55 | no |
| mem:capture:inbox | iterate | `api::status` src/fork/kv/paged-scan.ts:14 | status / health | growing (paged-only) | 1 | 1,000 | 3.47 | no |
| mem:memories | iterate | `api::memories` src/triggers/api.ts:2742 | viewer / REST lists | growing (paged-only) | 2 | 760 | 1.33 | no |
| mem:memories | iterate | `api::consolidation-status` src/triggers/api.ts:483 | viewer / REST lists | growing (paged-only) | 1 | 760 | 1.33 | no |
| mem:memories | iterate | `mem::export` src/state/graph-generation.ts:102 | export | growing (paged-only) | 1 | 760 | 1.33 | on demand |
| mem:memories | iterate | `mem::diagnose` src/functions/diagnostics.ts:325 | diagnostics | growing (paged-only) | 1 | 760 | 1.33 | no |
| mem:memories | iterate | `mem::heal` src/functions/diagnostics.ts:1036 | diagnostics | growing (paged-only) | 1 | 760 | 1.33 | no |
| mem:memories | iterate | `mem::profile` src/functions/profile.ts:95 | profile | growing (paged-only) | 1 | 760 | 1.33 | no |
| mem:sessions | list | `api::sessions` src/triggers/api.ts:1440 | viewer / REST lists | growing (paged-only) | 2 | 3,192 | 1.21 | on demand |
| mem:sessions | list | `api::replay::sessions` src/triggers/api.ts:1055 | viewer / REST lists | growing (paged-only) | 1 | 3,192 | 1.21 | on demand |
| mem:sessions | list | `mem::export` src/state/graph-generation.ts:108 | export | growing (paged-only) | 1 | 3,192 | 1.21 | on demand |
| mem:sessions | list | `mem::consolidate` src/functions/consolidate.ts:93 | consolidation | growing (paged-only) | 1 | 3,192 | 1.21 | on demand |
| mem:sessions | list | `mem::diagnose` src/functions/diagnostics.ts:294 | diagnostics | growing (paged-only) | 1 | 3,192 | 1.21 | on demand |
| mem:sessions | list | `mem::profile` src/functions/profile.ts:40 | profile | growing (paged-only) | 1 | 3,192 | 1.21 | on demand |
| mem:semantic | listPage | `api::semantic-list` src/triggers/api.ts:543 | viewer / REST lists | growing (paged-only) | 1 | 14,336 | 0.58 | no |
| mem:insights | iterate | `mem::insight-list` src/functions/reflect.ts:573 | reflect | growing (paged-only) | 1 | 485 | 0.44 | no |
| mem:insights | iterate | `mem::diagnose` src/functions/diagnostics.ts:555 | diagnostics | growing (paged-only) | 1 | 485 | 0.44 | no |
| mem:obs:* | list | `mem::profile` src/functions/profile.ts:60 | profile | bounded | 20 | 137 | 0.28 | on demand |
| mem:obs:* | list | `api::observations` src/triggers/api.ts:1534 | viewer / REST lists | bounded | 2 | 500 | 0.22 | no |
| mem:procedural | listPage | `api::procedural-list` src/triggers/api.ts:543 | viewer / REST lists | growing (paged-only) | 1 | 43 | 0.14 | no |
| mem:procedural | iterate | `api::consolidation-status` src/triggers/api.ts:485 | viewer / REST lists | growing (paged-only) | 1 | 43 | 0.14 | no |
| mem:procedural | iterate | `mem::diagnose` src/functions/diagnostics.ts:503 | diagnostics | growing (paged-only) | 1 | 43 | 0.14 | no |
| mem:lessons | iterate | `mem::reflect` src/functions/reflect.ts:365 | reflect | growing (paged-only) | 2 | 88 | 0.10 | no |
| mem:lessons | list | `mem::lesson-list` src/functions/lessons.ts:246 | lessons | growing (paged-only) | 1 | 88 | 0.10 | on demand |
| mem:lessons | list | `mem::diagnose` src/functions/diagnostics.ts:408 | diagnostics | growing (paged-only) | 1 | 88 | 0.10 | on demand |
| mem:crystals | iterate | `mem::reflect` src/functions/reflect.ts:366 | reflect | growing (paged-only) | 2 | 2 | 0.01 | no |
| mem:crystals | list | `mem::crystal-list` src/functions/crystallize.ts:116 | crystallize | growing (paged-only) | 1 | 2 | 0.01 | on demand |
| mem:crystals | list | `mem::diagnose` src/functions/diagnostics.ts:529 | diagnostics | growing (paged-only) | 1 | 2 | 0.01 | on demand |
| mem:metrics | list | `api::status` src/eval/metrics-store.ts:57 | status | bounded | 1 | 1 | 0.00 | no |
| mem:metrics | list | `api::health` src/eval/metrics-store.ts:57 | status | bounded | 1 | 1 | 0.00 | no |
| mem:actions | list | `mem::action-list` src/functions/actions.ts:214 | actions | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:relations | iterate | `api::consolidation-status` src/triggers/api.ts:486 | viewer / REST lists | growing (paged-only) | 1 | 0 | 0.00 | no |
| mem:actions | list | `mem::auto-crystallize` src/functions/crystallize.ts:159 | crystallize | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:actions | list | `mem::diagnose` src/functions/diagnostics.ts:60 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:action-edges | list | `mem::diagnose` src/functions/diagnostics.ts:61 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:leases | list | `mem::diagnose` src/functions/diagnostics.ts:62 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:leases | list | `mem::diagnose` src/functions/diagnostics.ts:141 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:actions | list | `mem::diagnose` src/functions/diagnostics.ts:142 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:sentinels | list | `mem::diagnose` src/functions/diagnostics.ts:185 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:actions | list | `mem::diagnose` src/functions/diagnostics.ts:186 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:sketches | list | `mem::diagnose` src/functions/diagnostics.ts:232 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:signals | list | `mem::diagnose` src/functions/diagnostics.ts:263 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:mesh | list | `mem::diagnose` src/functions/diagnostics.ts:585 | diagnostics | bounded | 1 | 0 | 0.00 | no |
| mem:facets | list | `mem::diagnose` src/functions/facets.ts:85 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:actions | list | `mem::heal` src/functions/diagnostics.ts:671 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:action-edges | list | `mem::heal` src/functions/diagnostics.ts:672 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:leases | list | `mem::heal` src/functions/diagnostics.ts:797 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:actions | list | `mem::heal` src/functions/diagnostics.ts:798 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:sentinels | list | `mem::heal` src/functions/diagnostics.ts:883 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:sketches | list | `mem::heal` src/functions/diagnostics.ts:935 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:signals | list | `mem::heal` src/functions/diagnostics.ts:1009 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |
| mem:facets | list | `mem::heal` src/functions/facets.ts:85 | diagnostics | growing (paged-only) | 1 | 0 | 0.00 | on demand |

## Memory during the run

| Container | Limit | cgroup `memory.peak` | Highest sample (`docker stats`, every 5 s) | Note |
|---|---|---|---|---|
| agentmemory | 3584 MiB | 2,674 MiB | 2.47 GiB | `anon` 1,981 MiB at the end; no restarts |
| valkey | 2560 MiB | 2,560 MiB | 2.24 GiB | `used_memory_peak` 2.18 GB, RSS 2.21 GB. The cgroup peak reached the limit because the AOF file's page cache counts against it; nothing was killed. |
| client (`replica.sh` probe) | 1 GiB | 34 MiB | | |
| host proxy (Node TCP forwarder to the internal network) | 128 MiB | 42 MiB | | |

## After TEE-1160, 2026-11-19

The same day was replayed on the TEE-1160 branch (image built at 86e42d1) with `AGENTMEMORY_SCOPE_GUARD=throw`. The guard refused every unpaged `list` of a `paged-only` scope and every whole read of a `point-read-only` scope, so any unconverted read would have failed its call.

- **Every call succeeded.** The replay made 14,348 calls with no failures. Every one-off call also succeeded: the viewer lists, diagnostics, heal, reflect, crystallize, consolidate and auto-forget. Export still returns 413 on buddy's size, as before (TEE-1183).
- **No whole-collection read of a growing scope is left.** The three tables (recurring, boot and on-demand) have no `list` row on a `paged-only` scope and no row on a `point-read-only` scope. Every remaining read of a growing scope is a paged `iterate` or `listPage`.
- **Recurring reads fell from about 154 GB a day to 1.24 GB a day.** The window was 60.5 minutes, so timer rows are scaled by 23.80.

| Call site | Before, MB/day | After, MB/day | What changed |
|---|---|---|---|
| Health-tick index reconcile, `mem:obs:*` and `mem:sessions` (rows 1 and 6) | 100,356 | 5 | Only sessions written since the last pass, or still holding unindexed rows, are listed again. One full pass happens per boot. |
| Capture inbox scans from the sweep and health tick (rows 2 and 4) | 39,984 | 82 | The sweep, status and retry read an in-process index. The hourly prune rescans and rebuilds it. |
| Auto-forget, every session's observations plus `mem:sessions` (rows 3 and 11) | 12,886 | 29 | A session is read only when its stats allow a low-importance row older than 180 days. `mem:sessions` is paged. |
| Context injection, per-session observations (row 5) | 754 | 823 | Paged, and only matching rows are kept. The bytes are the same per call, and this replay made 9% more of these reads (2,994 against 2,741). |
| Context and lesson reads of `mem:lessons` (rows 12, 16 and 20) | 30 | 32 | Paged. |
| Summary recovery, `mem:summary:repairs` (row 14) | 26 | 20 | Paged. |
| Everything else | 234 | 250 | Unchanged reads of bounded scopes (summaries of one session, metrics), plus paged reads. |

Reads that remain by design:
- Context injection still reads up to 10 recent sessions without a summary in pages. Its bytes did not fall. Cutting them would need a per-session index of important observations.
- Export, consolidation, timeline and profile still walk every session's `mem:obs:<session>` scope. That scope is `bounded`, and these run only on demand. The boot index rebuild also walks every session once per start.

**Same output.** `scripts/fork/feature-diff.mjs` ran 35 feature calls and the export pages on a fresh restore with the old image (rebuilt from 817c594) and with the new one (120603f). Times, ids and latencies made during the run were normalized.
- 33 of 35 calls were byte-identical: context, profile, auto-forget (dry run and real), every viewer list, search, smart search, lesson search, timeline, diagnostics, heal, reflect, crystallize, consolidate and export (413 on both).
- `health` differed only in worker ids and connect times.
- `status` differed because the old image's index check timed out and reported `index-check-unavailable`. The new image's check finished and reported 0 missing observations in 3,094 sessions.
- 13 export pages finished on both images. They were identical except `accessLogs` and `profiles`, which the probe's own reads write. Two runs of the old image differ in the same way.

**Memory.** Limits were the same as above.

| Container | Limit | cgroup `memory.peak` | Highest 2 s sample | Note |
|---|---|---|---|---|
| agentmemory | 3584 MiB | 2,629 MiB (before: 2,674) | 2,571 MiB | `anon` peak 2,450 MiB. Worker RSS peak 2.04 GiB. No restarts. The peak is set by the boot rebuild, not by the day's traffic. |
| valkey | 2560 MiB | 2,560 MiB | 2.23 GiB | `used_memory_peak` 2.18 GB, the same as before. |

Paging all export pages back to back OOMs the worker on both images at this limit. The old image failed after 13 pages and the new one after 19 to 29. That limit is outside TEE-1160 (TEE-1182, TEE-1183).

## Reproduce

```sh
docker build -f deploy/Dockerfile -t am-inventory:<sha> .
export AM_IMAGE=am-inventory:<sha> REPLICA_PROJECT=inv AGENTMEMORY_SCOPE_GUARD=warn \
  AM_MEM_LIMIT=3584m VALKEY_MEM_LIMIT=2560m VALKEY_MAXMEMORY=2400mb
bench/fork/replica.sh up /home/cownose/am-staging/buddy-2026-11-16
# The replica network is internal. To reach REST from the host, attach a
# TCP forwarder (any container with Node) to both inv_replica and a published
# 127.0.0.1 port, forwarding to agentmemory:3111.
# Take the boot snapshot once "observation stats repaired" is logged and the next 30 s dump lands:
docker exec inv-agentmemory-1 cat /data/scope-guard-inventory.json > s0.json
AGENTMEMORY_SECRET=replica-dummy-secret npx tsx scripts/fork/replay-day.ts --replica \
  --url http://127.0.0.1:<port> --container inv-agentmemory-1 \
  --obs-per-day 12200 --factor 24 --sessions-per-day 98 --searches-per-day 600
docker exec inv-agentmemory-1 cat /data/scope-guard-inventory.json > s1.json
# one call to each feature endpoint, wait 30 s, then:
docker exec inv-agentmemory-1 cat /data/scope-guard-inventory.json > s2.json
docker cp inv-agentmemory-1:/opt/agentmemory/dist/index.mjs.map .
npx tsx scripts/fork/read-inventory.ts --map index.mjs.map --boot s0.json --day s1.json --extra s2.json
bench/fork/replica.sh down
```

`restarts` in the inventory file must be 0 for the day window to be one process's day. With the carry-over a restart no longer loses counts, but it adds a second set of boot reads to the window.
