# Filling the disk search index (TEE-1168)

In disk mode (`AM_SEARCH_BACKEND=disk`) the keyword index and the vectors live in Qdrant, behind the am-search worker. A stack that ran in memory mode has its records in the store and its vectors persisted by the memory-mode index, but nothing in Qdrant. `scripts/fork/search-migrate.ts` fills Qdrant from that data during the cutover window, with no embedding calls.

```
MIGRATE_STORE_URL=redis://:<pw>@kvrocks:6666 AM_QDRANT_URL=http://qdrant:6333 AM_QDRANT_API_KEY=<key> \
  node --import tsx scripts/fork/search-migrate.ts fill|verify|status [--page 200] [--rate 64] [--allow-nonempty]
```

## What it reads

The tool reads the store (Kvrocks, after TEE-1163) over RESP with `scripts/fork/lib/resp.ts`. The iii redis adapter keeps each scope in a hash `state:<scope>`, with one JSON value per key. The tool pages every hash with HSCAN and never reads a whole hash at once. In memory it holds one id and a 16-character digest per stored vector, about 40 MB for buddy.

- **Records.** It reads the memories in `mem:memories`, then each session's observations in `mem:obs:<session>`, for every session in `mem:sessions`. This is the walk the memory-mode rebuild does.
- **Persisted vectors.** These are the layout of `src/state/index-persistence.ts`, which `src/fork/search/persisted-vectors.ts` is the only fork file to know:
  - Bucket hashes `mem:index:bm25:vec:NNNN`, with rows `{ id, s, e }`.
  - The pending log `mem:index:vec-pending`, which holds changes newer than the buckets. A row is a vector, a delete or a clear, and the log is ordered by its sequence `q`.
  - The `vectors:meta` count is not used. On buddy it says 242,653 against 249,289 rows; it counts unique documents, and the extra rows are duplicates (below).
  - Legacy snapshot layouts are refused. One memory-mode start of the current release converts them to buckets.

`test/fork-vector-layout.test.ts` drives upstream's own `IndexPersistence` writer and checks that the tool's plan equals what upstream's boot loads. An upstream change to the layout fails that test.

## What it writes

- **Keyword documents.** It builds one for every indexable record with the app's own builder: `docOfRecord`, then `docOp`, the same `docOp` that `RemoteKeywordIndex.add` uses. An observation needs a title and a narrative, and a memory must be the latest version with a title and content. A record without a narrative is never indexed, as in memory mode.
- **Vectors.** It loads one vector per document, decoded from the persisted float32 and sent as it is. A row that is not exactly 1024 finite float32 values is refused and counted. It is never loaded.
- **Duplicates.** The tool collapses them in the order the memory-mode boot applies them: the buckets, then the pending log by sequence. A pending vector replaces the bucket row, a pending delete removes it, and a pending clear drops everything before it. A pending row that cannot be read loads no vector for its document, rather than the older bucket row.
  - Two bucket rows with the same bytes count once.
  - Two bucket rows that are the same text embedded twice, with cosine at least 0.99, load the row in the higher bucket, which is the later write. Buddy has 6,634 such documents. They are all in the same session, with cosine from 0.9938 to 1 and a median of 0.99998. The older copies fill whole buckets 60–69, which looks like one re-embedding pass that wrote new rows instead of replacing the old ones. Memory mode loads either copy, depending on the order its concurrent bucket reads finish.
  - Rows further apart than that are a conflict that only re-embedding can settle. That document gets no vector and is counted. Buddy has none.
- **The model.** Every stored vector was measured as voyage-code-4 at 1024 dimensions, float32 (TEE-1156, 2026-11-18). The tool records this in its marker and prints it in verify.

**How it writes.** The tool uses an in-process `SearchEngine`, the am-search worker's own engine, with `SearchEngine.load`. `load` writes each document and its stored vector as one point in one conditional upsert per batch, with the payload `apply` writes, including `lexical_order`: the load order, by which the worker breaks keyword ties as SearchIndex breaks them by insertion order.
- **Why not `apply`.** `apply` spends one filtered payload write per document, about 20 documents a second at 1024 dimensions, which is 3 hours for buddy. `load` writes about 2,000 a second.
- **Why one point.** It gives what the rev fence gives on the live path: the vector belongs to the content it is stored with.
- **Why not iii.** The app and the worker are stopped during the window, so the tool is the store's only writer.

**Version.** Every migrated write carries version 1, the lowest valid version. `load`'s upsert only replaces a point whose stored version is not newer, so:
- a re-run rewrites only its own points;
- any live write, stamped from the clock above every stored version, always outranks a migrated write;
- the migration can never overwrite a newer document or vector, and can never resurrect a deleted one. Such documents are reported as left as a newer live write had them.

**Keyword weights.** Before its first write, the tool computes the mean term count of every document it will write and keeps it in the marker. Every document is weighted with it, and no reweighting pass runs. A pass after the mean drifts rewrites every point, and it ran for over 25 minutes on buddy before this change. The worker later finds the collection's mean equal to the weights' mean, so it has nothing to reweight either. Buddy's mean is 35.8 terms. `AM_SEARCH_AVGDL` defaults to 70, a figure from the synthetic corpus.

**Resume.** The hash `fork:search-migrate` in the store holds the state. It is outside `state:*`, so the app never reads it. It holds the meta (version, start time, mean length, model), the last plan, one field per finished unit (the memories, or one session) and the count of refused calls. A killed run redoes only its unfinished unit. The writes converge because they carry the same version, the same weights and the same point ids (UUIDv5 of the document id).

**Collection.** The tool refuses a collection that already holds documents it did not write. Pass `--allow-nonempty` to override.

## No embedding calls

- The tool imports no embedding provider. `test/fork-search-migrate.test.ts` walks its import graph and fails if one appears.
- Every `fetch` to an origin other than Qdrant's is refused and counted. The count is stored in the marker.
- `verify` fails unless the stored count plus its own is 0.

## Verify

`verify` recomputes the plan and the expected documents from the store. It then compares:

- documents per layer (observations and memories) and per session, against Qdrant;
- dense vectors against the stored vectors that have an indexable record;
- sampled keyword revs: 1 in `--rate` documents, chosen by a hash of the id;
- sampled vectors;
- embedding calls, which must be 0.

**Sampled vectors.** Qdrant stores `dense` as float16 under Cosine distance, so the expected value is the decoded vector normalised and rounded to float16. Qdrant's returned values are snapped to the same grid. Each component must match to within one float16 step.

Qdrant normalises in float32 with its own summation order. A component that lands near a rounding boundary can therefore round to the neighbouring float16 value, and the two sample checksums printed are not bit-equal. On buddy, 126 of 3,167 sampled vectors sit one step off and none further.

**Not loaded.** It also reports the stored vectors with no indexable record, and the documents with no stored vector. TEE-1169's re-embed would later embed the documents with no stored vector.

## Measured on buddy's 2026-11-16 snapshot

The replica ran on Kvrocks with Qdrant 1.20.2 (1.5 GB limit) on the workstation. The migration ran in the replica's client container.

| Step | Result |
|---|---|
| Plan | 249,289 rows in 395 buckets, 0 malformed. 2 identical duplicate rows and 6,634 near-duplicates (min cosine 0.9938), 0 conflicts. 242,653 vectors, one per document. |
| Fill | 244 s end to end, with the mean pass, the plan and the writes. 229,476 documents (228,716 observations, 760 memories), the same count as memory mode's keyword index, and 207,793 vectors. |
| Not loaded | 34,860 stored vectors have no indexable record. 21,683 documents have no stored vector. |
| Verify | 29 s. `VERIFY OK`: 2,822 sessions with equal counts, 3,513 sampled revs, 3,167 sampled vectors, 0 embedding calls. |
| Kill and resume | Killed at 120 s (875 of 3,095 units done) and again at 90 s (2,818 done). The resume took 24 s and wrote 277 units. A second re-run wrote 0. The collection held exactly 229,476 points, and verify was OK with the same index checksum as the uninterrupted run. |
| Vector recall@10 against brute force | 0.952 (oversampling 6) and 0.9555 (oversampling 10). 200 stored vectors were the queries, with the query's own document left out, and exact cosine over all 207,793 decoded vectors was the truth (`bench/fork/qdrant/recall-migrated.ts`). |
| Keyword-only eval (private tier, 100 cases) | Disk 0.83 / MRR 0.6553 against memory 0.86 / 0.7347 on the same replica. See below. |
| Synthetic 250k, graph cases | Disk 1.00 / MRR 0.90, 10 of 10 graph cases, the same as memory mode. The fill took 79 s for 159,565 documents. |

**Plan the cutover window at about 5 minutes for buddy:** fill plus verify. Main's store is about 15% smaller in vectors.

**Keyword ranking.** Disk mode expands query prefixes and re-scores candidates with SearchIndex's exact BM25 (TEE-1195). On the private tier its keyword recall and MRR are 0.86 and 0.7387, against 0.86 and 0.7347 in memory mode. Before TEE-1195, disk mode lost 3 points of recall and 8 of MRR on keyword queries, because it matched only exact terms and bare forms.

## Lessons and images

The am-search worker keeps lessons and images in their own collections, `<collection>_lessons` and `<collection>_images` (TEE-1167). The migration fills both after the documents, as two more units with their own resume markers, `unit:lessons` and `unit:images`:

- **`lessons`.** HSCAN `mem:lessons`. It skips deleted lessons and builds each document with `lessonToObservation` and `docOp(…, "lesson")`, as `convergeLessons` does. It writes through the lessons engine's `apply` at version 1, which stores `lexical_order` for ties. A record that is not JSON or lacks `id` and `content` is counted as unreadable. Lessons are few: 88 on buddy.
- **`images`.** HSCAN `mem:image-embeddings` and write each row as an `img` op through the image engine's `apply` at version 1. A vector that is not `AM_SEARCH_IMAGE_DIMENSIONS` (512) finite numbers is refused and counted. Buddy has none, so the tests cover this unit with a synthetic fixture.

A killed run re-does the unfinished unit whole; its writes carry version 1, so the re-run converges, and a live write or delete made since is kept.

Verify checks every lesson and every image, not a sample, because both are small:

- `lessons`: the live count in the store against the live points.
- `lesson revs`: each lesson's rev, with a checksum of each side.
- `images`: the count of valid rows against the live points, with the refused and unreadable counts.
- `image vectors`: each image's unit vector, within 1e-6 per component, and its session, observation and time. The index checksum counts a component within that tolerance as the store's value, because Qdrant's float32 normalisation cannot be reproduced bit for bit. The two checksums are equal exactly when every component and field matches.

## Qdrant memory during a fill (TEE-1201)

A fill from empty, by `search-migrate fill` or by reconcile on an empty index, used to take Qdrant past the stack's 1 GB limit. Steady state is far lower (417 MiB during a backup, TEE-1170).

**Cause.** Qdrant's optimizer. While points arrive it keeps merging segments and building their indexes, and each build holds anonymous memory in proportion to the segment it builds: a build of a 100k-document segment adds about 500–600 MiB. With the earlier settings, one build per core ran at once and the merges grew toward 2 segments of half the collection each. Points written while the optimizer is busy also stay in RAM until that optimization ends, about 7 KB each with their vector. Payload indexes on disk changed nothing (767 against 783 MiB), and neither did gating on the count of unindexed vectors, which stayed under 10k while anon grew.

**Settings** (`Qdrant.create`, both text collections):

| Setting | Value | What it bounds |
|---|---|---|
| `max_optimization_threads` | 1 | Builds at once |
| `max_segment_size` | 300,000 KB | A build of documents with vectors: about 100k documents |
| `default_segment_number` | 4 (was 2) | Merges of documents with no vector (reconcile), which the size cap barely counts: about 0.3 KB each against 2.3 KB with a vector |

A collection keeps the settings it was created with: one created before TEE-1201 must be dropped and filled again to get them. Production had no Qdrant then; the cutover creates its collections.

`search-migrate fill` also waits for the optimizer to be idle (not yellow on two polls in a row) every 10,000 documents and once more before it returns (`OPTIMIZER_CHECK_DOCS`). Buddy's fill waits 19 times and takes 258 s instead of 185 s. Reconcile needs no gate: its outbox paces it.

**Measured** (Qdrant 1.20.2, swap off, `bench/fork/qdrant/fill-memory.ts`; anon is the cgroup's anonymous memory, since `memory.peak` also counts page cache, which fills to the limit on every run):

| Fill | Settings | Limit | Anon peak | Result |
|---|---|---|---|---|
| Load, 200k synthetic | before | 4 GB | 1,744 MiB | |
| Load, 200k synthetic | before | 1 GB | | OOM-killed at 130,800 |
| Load, 200k synthetic | 1 thread | 1 GB | 667 MiB | |
| Load, 200k synthetic | deferred indexing (`indexing_threshold` 0, then back) | 1 GB | 799 MiB | |
| Load, 1M synthetic | before | 4 GB | 2,653 MiB | |
| Load, 1M synthetic | 1 thread | 1 GB | | OOM-killed at 369,200 |
| Load, 1M synthetic | 1 thread, size cap | 1 GB | | OOM-killed at 874,600 |
| Load, 200k synthetic | final settings, no gate, quiet host | 1 GB | | OOM-killed at 143,800 |
| Load, 200k synthetic | final, idle gate | 1 GB | 486 and 785 MiB (two runs) | |
| Load, 500k synthetic | final, an earlier status gate | 1 GB | 750 MiB | |
| Load, 1M synthetic | final, an earlier status gate | 1 GB | | OOM-killed at 917,800 |
| Apply (reconcile's shape), 200k synthetic | 1 thread, size cap, 2 segments | 4 GB | 783 MiB | |
| Apply, 350k synthetic | 1 thread, size cap, 2 segments | 1 GB | | OOM-killed at 276,480 |
| Apply, 200k synthetic | final | 1 GB | 537 MiB (two runs) | |
| Apply, 600k synthetic | final | 1 GB | | OOM-killed at 578,816 |
| Load, 1M synthetic | final, an earlier status gate | 1.25 GB | 1,024 MiB | |
| Apply, 800k synthetic | final | 1.25 GB | | OOM-killed at 724,480 |
| Buddy, `search-migrate fill` | before | 1.5 / 2 GB | 1.98 GiB | OOM-killed at 1.5 GB (TEE-1170) |
| Buddy, `search-migrate fill` | final settings, no gate, quiet host | 1 GB | 921 MiB | 185 s, `VERIFY OK`, recall@10 0.998 |
| Buddy, `search-migrate fill` | final, idle gate | 1 GB | 623 MiB | 258 s, `VERIFY OK`, recall@10 1.000 |
| Buddy, reconcile from empty | final | 1 GB | 637 MiB | 229,476 documents in 21 minutes |

At steady state 1M documents hold 606 MiB anon after a restart. **Sizing:** reconcile is the tighter path. 1 GB holds a fill up to about 500k documents and 1.25 GB up to about 650k, with a margin under the OOM points above. Raise `QDRANT_MEM_LIMIT` before a stack passes that; a 1.25 GB Qdrant keeps buddy's stack near 3.1 GB, under the 3.5 GB budget.

**Buddy at the stack's limits** (Kvrocks 1280m, agentmemory 2560m, Qdrant 1g), summed cgroup peaks: the migration 2,799 MiB (client, Kvrocks, Qdrant; agentmemory is stopped), reconcile 2,816 MiB (agentmemory, Kvrocks, Qdrant). Both are under the 3.5 GB stack budget. The segment count at buddy's size is 4, where it was 2 to 3.

**Guards.** On a fresh 1 GB Qdrant each (`docker run -d --name fill-qdrant -m 1g --memory-swap 1g -p 127.0.0.1:16401:6333 qdrant/qdrant:v1.20.2`):

```
node --import tsx bench/fork/qdrant/fill-memory.ts --count 200000 --container fill-qdrant --ceiling-mib 900
node --import tsx bench/fork/qdrant/fill-memory.ts --path apply --count 200000 --container fill-qdrant --ceiling-mib 620
```

Each exits 1 when Qdrant is OOM-killed or its anon peak passes the ceiling. The load ceiling sits above its spread between runs (a cap-size build lands in some runs and not others); the settings before TEE-1201 are OOM-killed on both. `test/fork-qdrant-fill-config.test.ts` checks that the worker creates its collections with these settings.

## Cutover order (for TEE-1172)

The order makes the first disk-mode start find every stored vector already in Qdrant, so re-embedding (TEE-1169) only spends Voyage quota on documents that really have no vector:

1. Stop the agentmemory container: the app and, in disk mode, the am-search worker inside it.
2. Copy the records to Kvrocks and verify them (TEE-1163, `scripts/fork/kvrocks-migrate.ts`).
3. Start Qdrant.
4. Run `search-migrate.ts fill`, then `search-migrate.ts verify`. `verify` must print `VERIFY OK`. As with the Kvrocks copy, run them from a checkout of this branch (with `npm install` done) on a container attached to the stack network, with no embedding key in its environment. The image is used only for its Node:

   ```
   docker run --rm --network <stack network> -v <checkout>:/work:ro -w /work \
     -e MIGRATE_STORE_URL=redis://:<pw>@kvrocks:6666 -e AM_QDRANT_URL=http://qdrant:6333 -e AM_QDRANT_API_KEY=<key> \
     --entrypoint node <agentmemory image> --import tsx scripts/fork/search-migrate.ts fill
   ```

5. Start agentmemory with `AM_SEARCH_BACKEND=disk` and `AM_SEARCH_REEMBED_PER_MINUTE=0`. Reconcile can stay on, because it never embeds.
6. Check that `/agentmemory/status` `searchBackend.missingVectors` equals the "documents have no stored vector" count from `verify`. Then raise `AM_SEARCH_REEMBED_PER_MINUTE` to the rate the provider quota allows. On buddy, that is 21,683 documents, about 3 hours at 120 a minute.

Starting the app in disk mode before step 4 would make TEE-1169's re-embed spend quota on vectors that exist, and after step 4 the collection would hold documents the tool did not write. The tool refuses such a collection unless it is given `--allow-nonempty`.

If the app does run during a fill, for example after a kill and before the resume, nothing is lost. Reconcile writes the missing documents without vectors at a live version, which outranks the migration's version 1. The fill then copies each stored vector onto any such document that still has the same rev and no vector, at that document's own version, so a later live write still wins. `test/fork-search-migrate.test.ts` pins this.

## Replica

```
mkdir /tmp/am-replica.lock && echo "<issue> $(date -Is)" > /tmp/am-replica.lock/owner
export REPLICA_PROJECT=<issue> REPLICA_STORE=kvrocks REPLICA_COMPOSE_EXTRA=bench/fork/qdrant/replica-disk.yml AM_IMAGE=<image>
bench/fork/replica.sh valkey /home/cownose/am-staging/buddy-2026-11-16    # loads Valkey, copies to Kvrocks, verifies
docker compose -f bench/fork/replica-compose.yml -f bench/fork/qdrant/replica-disk.yml -p $REPLICA_PROJECT up -d --wait qdrant
bench/fork/replica.sh client env MIGRATE_STORE_URL=redis://:<replica pw>@kvrocks:6666 AM_QDRANT_URL=http://qdrant:6333 \
  AM_QDRANT_API_KEY=replica-dummy-qdrant-key node --import tsx scripts/fork/search-migrate.ts fill
# the same with verify, then bench/fork/qdrant/recall-migrated.ts for recall@10 against brute force
```

The end-to-end eval with query embeddings (AC4) runs the memory-mode baseline, the migration and the disk-mode eval on one replica, and tears it down: `VOYAGE_API_KEY=… AM_IMAGE=<image> bench/fork/qdrant/eval-voyage.sh <backup-dir> <cases.json> <out-dir>`, holding the replica lock. Only agentmemory gets a network with internet access (`bench/fork/replica-voyage.yml`). Voyage receives one query embedding per case per run and at most one boot backfill embedding; the migration makes none. With 100 private cases that is 200 query embeddings of 8,236 characters in total. `EVAL_KEYWORD_ONLY=1` runs the same steps with no provider and no key.
