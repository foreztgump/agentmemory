# Qdrant spikes S1–S3 (TEE-1161)

**Decision: Qdrant passes, with conditions.** At 1M documents Qdrant serves a steady dense, keyword and hybrid load inside a 1 GB memory limit, with no OOM and p95 under 12 ms. Filtered recall@10 is at least 0.95 on every layer of real voyage-code-4 vectors. That recall needs 1-bit codes with 8-bit query encoding and oversampling 3 on buddy's 249k vectors, and oversampling 6 on both stacks' 464k. Recall falls as the corpus grows, so oversampling is a setting to re-check against the release gate, not a constant. The Postgres fallback is not needed.

Measured on 2026-11-18 on the workstation (16 cores, NVMe, rootless Docker, cgroup v2).

## Setup

| Item | Value |
|---|---|
| Qdrant | `qdrant/qdrant:v1.20.2` (latest stable, released 2026-11-16) |
| Memory limit | `docker run -m <limit> --memory-swap <limit>` (swap off), cgroup v2 |
| Disk limit | `--device-read-iops /dev/nvme0n1:66591` (cgroup `io.max riops=66591`, NR1's QD32 rate) |
| Proof of the IOPS limit | `bench/fork/qdrant/spike.sh fio` inside the Qdrant container, 4 KB random reads with direct I/O: QD32 66,565 IOPS (p99 378 µs), QD1 19,678 IOPS (p99 59 µs) |
| Collection | the planned shape (below), 2 segments requested |
| Point ids | UUIDs |
| Text side | sparse `bm25` built with `src/state/term-extraction.ts` from TEE-1155's profile-driven generator. avgdl 43 terms; non-zero terms per doc: p50 35, p95 76 |

The IOPS cap matches NR1's throughput, but it cannot add NR1's per-read latency. Local QD1 p99 is 59 µs against NR1's 561 µs. "Latency on NR1" below adds an estimate for that gap.

Collection as created (`bench/fork/qdrant/lib.ts` `createCollection`), confirmed from `GET /collections/<c>` and `/telemetry`:

```
vectors.dense:      size 1024, Cosine, datatype float16, memory cold      -> segment storage_type "Mmap"
quantization:       binary { encoding one_bit, query_encoding scalar8bits, memory pinned }
sparse_vectors.bm25 { modifier idf, index.memory cold }                   -> index_type "Mmap", storage "mmap"
hnsw_config:        m 16, ef_construct 100, memory cached
payload:            on_disk_payload true (payload_storage_type mmap); indexes layer/session_id keyword, ts integer, dense bool
optimizers:         default_segment_number 2
```

The 1.19+ `memory` tiers (`pinned`/`cached`/`cold`) replace `on_disk`/`always_ram`. Qdrant 1.20.2 accepts `float16` together with `memory: cold` and pinned binary codes.

### Data

- **Real vectors (S2).** Buddy's restore has 249,289 stored vectors: 248,498 observations and 791 memories. Main's restore has 215,829: 210,578 observations and 5,251 memories. None of these vectors left the workstation.
- **No lesson or image vectors exist.** Buddy has 88 lessons, main 249, neither stack has images. To measure a very selective filter, I relabelled that many observation vectors as `lesson`.
- **Queries (S2).** 1,000 held-out stored vectors (seed 1161). Ground truth is exact brute force in float32 over the rest.
- **Ties in the ground truth.** Buddy holds many identical and near-identical vectors: 267 of the 1,000 queries tie at the 10th place. I count a hit when the returned point's exact cosine is within 1e-3 of the 10th exact cosine. That is ann-benchmarks' k-nn recall. I also report strict recall (tolerance 1e-6). Exact search over Qdrant's float16 originals scores 1.000 on the first measure and 0.981 on the strict one, so float16 rounding among duplicates alone costs 0.02 of strict recall.
- **Synthetic 1M and 3M (S1, S2 latency).** Buddy's 249,289 real vectors first, then copies of random real vectors with isotropic Gaussian noise. σ = 0.0151 per dimension, renormalized, so the copies have measured cosine 0.90 to their source.
  - Layers come from the source, plus `lesson` on buddy's lesson share.
  - Queries are fresh noisy copies.
  - The sparse queries are 2 to 4 words drawn from the generator's Zipf vocabulary.

## S1: memory at 1M

| Phase | Limit | Result |
|---|---|---|
| Import of 1M (upload 315 s, indexed and green at 506 s) | 4 GB | no OOM. `memory.peak` reached the 4 GB limit (page cache included). Anon after import 1.03 GB. 3.2 GB on disk |
| Boot, idle | 1 GB | `memory.current` 686 MiB: anon 483 MiB, file 195 MiB. Qdrant RSS 652 MiB. 489 MB read at boot |
| Steady load, cold start (page cache evicted first), 30 s | 1 GB | 938 qps, 0 errors, 0 OOM kills. p50/p95/p99 2.7/9.1/20.8 ms. First 100 queries p95 28 ms |
| Steady load, warm, 120 s | 1 GB | 938 qps, 0 errors, 0 OOM kills. p95 9.0 ms, p99 18.2 ms. Anon 467 MiB, file 540 MiB (at the limit). 25 block reads per query |
| Same load, cold, 60 s | 768 MB | 936 qps, p95 8.3 ms, 0 OOM kills. Anon peak 498 MiB |
| Boot | 512 MB | OOM-killed while loading the collection |

The load runs 4 concurrent clients for the whole run, one sixth each of dense, keyword and hybrid (RRF over a dense and a keyword prefetch of 40). Half of the queries filter by layer. Dense queries rescore at oversampling 3.

Per kind at 1 GB, warm, oversampling 3 (p50/p95/p99 ms):

| dense | dense+filter | sparse | sparse+filter | hybrid | hybrid+filter |
|---|---|---|---|---|---|
| 1.9/5.4/14.5 | 1.7/4.3/9.4 | 4.3/6.2/9.2 | 1.9/5.7/7.3 | 6.4/15.4/42.4 | 3.3/11.9/22.7 |

At oversampling 6, 1 GB, warm:

| Load | Throughput | Latency (ms) | Block reads per query |
|---|---|---|---|
| Mixed, 4 clients | 653 qps | p95 12.3, p99 40.9. Dense p95 10.0, hybrid p95 30.7 | 50 |
| Dense only, 1 client | — | p50 2.7, p95 10.3, p99 19.5 | 30 |

**Working set.** About 470 MB of anonymous memory, the pinned codes plus the id tracker, payload indexes and process. The page cache takes whatever the limit leaves. The 1 GB limit holds with no OOM, and the 768 MB limit also serves the load. The floor is between 512 MB and 768 MB, set by the boot peak. **S1 passes:** the 1M working set is under 1 GB.

## S2: recall on real vectors

recall@10 against brute force, 1,000 queries, hnsw `ef` default. The first value in each cell is k-nn recall with ε 1e-3; the value in brackets is strict recall.

**Buddy, 248,289 vectors, 1-bit codes with 8-bit query encoding (`query_encoding: scalar8bits`):**

| oversampling | all | observation | memory (791) | lesson (88) |
|---|---|---|---|---|
| none (codes only) | 0.821 (0.703) | 0.821 | 0.833 | 0.894 |
| 1.5 | 0.915 (0.789) | 0.915 | 0.957 | 0.979 |
| 2 | 0.947 (0.830) | 0.947 | 0.988 | 0.995 |
| **3** | **0.969** (0.877) | **0.969** | **0.996** | **0.999** |
| 4 | 0.978 (0.900) | 0.978 | 0.999 | 1.000 |
| 6 | 0.983 (0.927) | 0.983 | 1.000 | 1.000 |

**Buddy, plain 1-bit codes (query also 1-bit, Qdrant's default):** needs oversampling 5 for every layer.

| oversampling | all | memory | lesson |
|---|---|---|---|
| 3 | 0.932 | 0.969 | 0.996 |
| 4 | 0.952 | 0.984 | 0.998 |
| 5 | 0.962 | 0.996 | 0.999 |
| 8 | 0.972 | 0.999 | 1.000 |
| 10 | 0.975 | 0.999 | 1.000 |

`hnsw_ef` 128 and 256 change recall by under 0.006 at any oversampling. HNSW search on the originals, without the codes, reaches 0.997 on the 1M synthetic set. **The codes, not the graph, limit recall.**

**Two-bit codes (`encoding: two_bits`, 256 B per point):**

| oversampling | all | memory |
|---|---|---|
| 3 | 0.987 | 0.770 |
| 6 | 0.992 | 0.884 |

Unfiltered recall is better, but the 791-point memory filter collapses. This looks like a Qdrant defect in the small-filter path with 2-bit codes. Do not use 2-bit codes until it is understood.

**Both stacks, 464,118 real vectors (buddy + main, 337 relabelled lessons), 1-bit codes with 8-bit queries:**

| oversampling | all | observation | memory (6,027) | lesson (337) |
|---|---|---|---|---|
| 2 | 0.910 | 0.906 | 0.917 | 0.968 |
| 3 | 0.941 | 0.937 | 0.961 | 0.993 |
| 4 | 0.953 | 0.949 | 0.976 | 0.998 |
| **6** | **0.964** (0.927) | **0.960** | **0.987** | **1.000** |
| 8 | 0.967 | 0.963 | 0.989 | 1.000 |

**S2 recall passes at oversampling 6 with 8-bit query encoding,** on every layer of 464k real vectors. Oversampling 3 is enough at buddy's size today.

**Recall falls with corpus size.** On the synthetic 1M set, measured against Qdrant's exact search (200 queries):

| oversampling | all | memory | lesson |
|---|---|---|---|
| 2 | 0.719 | 0.948 | 0.979 |
| 3 | 0.765 | 0.983 | 0.996 |
| 4 | 0.801 | 0.996 | 1.000 |
| 8 | 0.878 | — | — |
| 16 | 0.931 | — | — |

The isotropic-noise copies are harder for 1-bit codes than real data: every query sits among many neighbours at nearly equal cosine (about 0.81–0.9). So this is a pessimistic bound, not a forecast. Still, real recall at the same oversampling dropped from 0.969 to 0.941 between 249k and 464k.

**Plan to re-measure recall on the real corpus at each doubling,** with the release gate (recall@10 ≥ 0.95 on real queries). Raise oversampling when it misses.

## S2: latency at 1M and 3M

IOPS cap 66,591. "Cold" means the page cache was evicted and Qdrant restarted. Oversampling 6 unless stated.

| Corpus | Limit | Load | p50 / p95 / p99 ms | qps | Reads per query |
|---|---|---|---|---|---|
| 1M | 1 GB | dense, 1 client, cold | 2.2 / 8.4 / 21.1 (dense+filter p95 7.1) | 265 | 19 |
| 1M | 1 GB | dense, 1 client, warm | 2.7 / 10.3 / 19.5 | 210 | 30 |
| 1M | 1 GB | mixed, 4 clients, warm | 3.8 / 12.3 / 40.9 | 653 | 50 |
| 3M | 1 GB | — | OOM-killed at boot | — | — |
| 3M | 1.5 GB | mixed, 4 clients, cold | 14.9 / 126.8 / 201.6 | 103 | 634 |
| 3M | 1.5 GB | mixed, 4 clients, warm | 14.7 / 140.5 / 265.5 | 90 | 656 |
| 3M | 2.5 GB | mixed, 4 clients, cold | 6.0 / 106.1 / 299.2 | 156 | 218 |
| 3M | 2.5 GB | mixed, 4 clients, warm | 6.9 / 99.2 / 157.2 (dense p95 99.9, hybrid p95 141.6) | 211 | 239 |
| 3M | 2.5 GB | dense, 1 client, warm | 3.2 / 11.0 / 23.4 | 197 | 141 |

**3M details.**

- **Import:** upload took 1,155 s, and the collection was green at 1,483 s. Qdrant's optimizer chose 5 segments. 9.6 GB on disk.
- **Steady-state anon memory:** 1.19 GB, against the design's 0.88 GB estimate.
- **Floor:** 3M does not boot in 1 GB, but it runs in 1.5 GB. Under concurrent load at 1.5 GB, almost every rescore misses the page cache.

**Latencies above are upper bounds.** During these runs the memory sampler in `load-test.ts` called `docker exec` synchronously once a second, and each call took about 45 ms. While it ran, about 4.5% of wall time, it delayed the queries in flight. That raises p99 and, to a lesser degree, p95; the true values are lower. The sampler is now asynchronous. Re-measure before using these numbers as ceilings.

**Latency on NR1 (estimate, not measured).** NR1's QD1 mean read latency is about 104 µs (1/9,627 s); locally it is about 50 µs. Adding about 55 µs per read:

- 1M single-client dense: +1.6 ms on average, at 30 reads per query. Even at NR1's p99 read latency, under +17 ms.
- 3M at 2.5 GB, single client: +8 ms on average, at 141 reads per query.

Confirm these on NR1's volume before cut-over.

## S3: point lifecycle

The test is `test/fork-qdrant-lifecycle.test.ts`. It is skipped unless `QDRANT_URL` is set. It passed 5/5 against 1.20.2:

```
bench/fork/qdrant/spike.sh up 1g && QDRANT_URL=http://127.0.0.1:16333 npx vitest run test/fork-qdrant-lifecycle.test.ts
```

| Need | Call | Proven |
|---|---|---|
| Update only the sparse vector | `PUT /collections/c/points/vectors` `{points:[{id, vector:{bm25:{indices,values}}}]}` | dense vector and payload unchanged |
| Update only the dense vector | same call with `vector:{dense:[…]}` | sparse vector and payload unchanged |
| Update when absent | `PUT …/points/vectors` returns 404 for an absent id | the point is not created |
| Create when absent, else update one vector | one ordered `POST /collections/c/points/batch` with `[{upsert:{points:[{id, vector, payload}], update_mode:"insert_only"}}, {update_vectors:{points:[{id, vector}]}}]` | creates the point with only that vector and the payload. On an existing point, keeps the other vector and the old payload. Idempotent |
| Delete only the dense vector | `POST /collections/c/points/vectors/delete` `{points:[id], vector:["dense"]}` | the point and its payload stay. Keyword search finds it, and exact vector search no longer returns it |

A plain upsert replaces the whole point and drops the vector it does not name. The `insert_only` guard is what makes the batch safe. Without it, the test's "keeps the other vector" check fails; I verified this by mutation.

## Settings for the am-search worker (TEE-1164/1167)

| Setting | Value | Why |
|---|---|---|
| Dense originals | `datatype: float16`, `memory: cold` | on disk (mmap). Exact search over float16 loses nothing at ε 1e-3 |
| Codes | `binary { encoding: one_bit, query_encoding: scalar8bits, memory: pinned }` | 128 B/point in RAM. The 8-bit query halves the oversampling needed. Not `two_bits` (memory-filter defect above) |
| Search | `params.quantization { rescore: true, oversampling: 6 }` | ≥ 0.95 on every layer at 464k real. Re-check at each corpus doubling, and raise it when the release gate misses |
| HNSW | `m: 16`, `ef_construct: 100`, `memory: cached`; query `hnsw_ef` default | `ef` 128/256 did not change recall |
| Sparse | `bm25 { modifier: idf, index: { memory: cold } }` | on disk (mmap). Keyword p95 under 8 ms at 1M |
| Payload | `on_disk_payload: true`; indexes `layer`, `session_id` (keyword), `ts` (integer), `dense`, `deleted` (bool) | filtered searches are faster than unfiltered ones. Every field a filter names needs an index: with payloads on disk, the tombstone filter (`deleted`) without one read every payload, and one count over 254k points took 37–42 s against 0.09 s with it (TEE-1222) |
| Segments | `default_segment_number: 2` at 1M | Qdrant kept 1 indexed segment and 1 appendable segment. At 3M it chose 5; every segment rescores its own candidates, so fewer segments mean fewer reads |
| Container limit | 1 GB at 1M (floor ~768 MB). 2.5 GB at 3M (1.5 GB works but rescoring then reads from disk) | measured above |
| Write path | the `insert_only` + `update_vectors` batch from S3 | one request, idempotent |
| HTTP client | retry an idempotent call once on a reset socket | Qdrant closes idle keep-alive connections after 5 s |

**Changes to the RAM budget** (synthesis, design §8):

| Corpus | Qdrant RSS (budget) | Qdrant RSS (measured) | Measured limit |
|---|---|---|---|
| 1M | 0.43 GB | 0.47 GB | 0.75–1 GB |
| 3M | 0.88 GB | 1.2 GB | 1.5–2.5 GB, against the budget's 1.75 GB |

The 3M per-stack total rises from about 3.3 GB to between 3.1 and 4.1 GB, depending on the latency wanted.

## Reproduce

Scripts are in `bench/fork/qdrant/`. Private vectors go only under `/home/cownose/am-staging/qdrant-spike/`.

```
bench/fork/qdrant/spike.sh up 4g                    # Qdrant 1.20.2, swap off, IOPS cap
bench/fork/qdrant/spike.sh fio                      # proves the cap
node --import tsx bench/fork/qdrant/extract-vectors.ts --container <valkey restore> --out <private dir>
QDRANT_URL=http://127.0.0.1:16333 node --import tsx bench/fork/qdrant/recall.ts --vectors <dir> --query-encoding scalar8bits
QDRANT_URL=… node --import tsx bench/fork/qdrant/load.ts --vectors <dir> --count 1000000 --collection s1_1m
bench/fork/qdrant/spike.sh down && bench/fork/qdrant/spike.sh evict && bench/fork/qdrant/spike.sh up 1g
QDRANT_URL=… node --import tsx bench/fork/qdrant/load-test.ts --vectors <dir> --collection s1_1m --oversampling 6
QDRANT_URL=… node --import tsx bench/fork/qdrant/recall-exact.ts --vectors <dir> --collection s1_1m --oversampling 2,3,4,float
bench/fork/qdrant/spike.sh mem                      # cgroup memory, Qdrant RSS, io.stat
bench/fork/qdrant/spike.sh purge
```
