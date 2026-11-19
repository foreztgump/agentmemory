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

**How it writes.** The tool uses an in-process `SearchEngine`, the am-search worker's own engine, with `SearchEngine.load`. `load` writes each document and its stored vector as one point in one conditional upsert per batch, with the payload `apply` writes.
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

**Keyword ranking gap.** On the private tier, disk mode loses 3 points of recall and 8 of MRR on keyword queries. 15 cases rank lower, 2 rank higher, and 3 drop out of the top 10. The expected documents of those 3 are live in the index with the right rev, so the migration is not the cause. Their query terms match the document only through prefixes: for example, 0 of 4 terms match exactly and 2 match as prefixes. SearchIndex expands a query term to every index term it prefixes, at half weight. The disk engine adds only bare forms of words ending in punctuation (TEE-1164). The synthetic tier uses exact terms, so it did not show this.

## Lessons and images (after TEE-1167)

TEE-1167 adds two collections to the am-search worker, `<collection>_lessons` and `<collection>_images`, and a `collection` field on every request. Once it merges into `disk`, the migration adds two units:

- **`lessons`.** HSCAN `mem:lessons`. It skips deleted lessons and builds each document with `lessonToObservation` and `docOp(…, "lesson")`, as `convergeLessons` does. It writes through the lessons engine's `apply` at version 1, because that engine stores `lexical_order` for ties. Lessons are few: 88 on buddy.
- **`images`.** HSCAN `mem:image-embeddings` and write each row as an `img` op through the image engine's `apply` at version 1. That engine already writes in one upsert. A vector whose length is not `AM_SEARCH_IMAGE_DIMENSIONS` (512) is refused and counted. Buddy has none.

Verify adds the lesson and image counts, and sampled checks of lesson revs and image vectors.

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
