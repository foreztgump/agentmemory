import type { VectorStorePort } from "../../state/search-ports.js";

/**
 * Reads stored embeddings back, so trash keeps the vector and restore never re-embeds (R3).
 *
 * `VectorStorePort.get` returns an identity token only, and the am-search worker has no op that returns
 * a vector (every Qdrant read uses `with_vector: false`). The vector slice adds:
 *   - `VectorStorePort.readVectors?(ids)` in `src/state/search-ports.ts` (fork seam, about 3 lines);
 *   - memory mode: `VectorIndex.get(id).embedding`;
 *   - disk mode: a `search::read-vectors` worker op (protocol, client, engine; `with_vector: ["dense"]`),
 *     batched like `search::lookup`.
 * A backend that cannot read reports `canRead: false`; the sweep then refuses to trash a row that has a
 * vector rather than trash it un-restorably, and says so in the report.
 */
export interface VectorReader {
  readonly canRead: boolean;
  /** base64 float32 per id; ids with no stored vector are absent from the map. */
  read(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export function vectorReaderFor(port: VectorStorePort | null): VectorReader {
  void port;
  // TODO: null port (no embedding provider) -> { canRead: true, read: () => empty map }: nothing to keep.
  //  port.readVectors present -> wrap it. Otherwise { canRead: false }.
  throw new Error("not implemented");
}

/**
 * Puts a document and its stored vector back in one synchronous tick: keyword first, because
 * `RemoteVectorStore.add` drops a vector whose rev the DocLedger does not know, then the vector.
 * Both ops land in the docs outbox together, so the TEE-1169 re-embed loop never sees the doc without
 * its vector. The R3 test runs with the re-embed loop on and counts zero embedding calls.
 */
export function reattachDocument(
  keyword: { add(obs: import("../../types.js").CompressedObservation, layer?: "observation" | "memory"): void },
  vector: VectorStorePort | null,
  doc: import("../../types.js").CompressedObservation,
  layer: "observation" | "memory",
  storedVector: string | undefined,
): { reembedNeeded: boolean } {
  void keyword;
  void vector;
  void doc;
  void layer;
  void storedVector;
  // TODO: keyword.add(doc, layer); if (vector && storedVector) vector.add(doc.id, doc.sessionId, base64ToFloat32(storedVector)).
  //  Return reembedNeeded = Boolean(vector && !storedVector): the item had no stored vector; the
  //  re-embed loop fills it and the report counts it.
  throw new Error("not implemented");
}
