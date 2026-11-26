import type { KeywordIndexPort, SearchRuntime, VectorStorePort } from "../../state/search-ports.js";
import type { CompressedObservation } from "../../types.js";
import { float32ToBase64 } from "../../state/vector-index.js";

/**
 * Reads stored embeddings back, so trash keeps the vector and restore never re-embeds (R3).
 *
 * `VectorStorePort.get` returns an identity token only, so the port has an optional
 * `readVectors(ids)`: memory mode answers from `VectorIndex`, disk mode from the am-search worker's
 * `search::read-vectors` op (`with_vector: ["dense"]`, batched). A disk read returns the vector as
 * Qdrant holds it: normalized to unit length (a cosine collection) and at float16 precision, widened
 * to float32. It ranks the same as the provider's embedding but is not bit-identical to it. Writing
 * it back stores the same bytes, so a restore is a fixed point after the first trash. Memory mode
 * returns the exact float32 embedding. A backend that cannot read reports
 * `canRead: false`; the sweep then refuses to trash a row that has a vector rather than trash it
 * un-restorably, and says so in the report.
 */
export interface VectorReader {
  readonly canRead: boolean;
  /** base64 float32 per id; ids with no stored vector are absent from the map. Rejects when the backend cannot answer. */
  read(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

const NO_VECTORS: ReadonlyMap<string, string> = new Map();

export function vectorReaderFor(port: VectorStorePort | null): VectorReader {
  if (port === null) return { canRead: true, read: async () => NO_VECTORS };
  const readVectors = port.readVectors?.bind(port);
  if (!readVectors) {
    return { canRead: false, read: () => Promise.reject(new Error("this vector store cannot read stored vectors")) };
  }
  return {
    canRead: true,
    read: async (ids) => {
      const read = await readVectors(ids);
      return new Map([...read].map(([id, vector]) => [id, float32ToBase64(vector)]));
    },
  };
}

/** Resolves the vector store at each use: a reader built before the search runtime exists would see no store and claim there is nothing to keep. */
export function activeVectorReader(runtime: () => Pick<SearchRuntime, "vector">): VectorReader {
  return {
    get canRead() {
      return vectorReaderFor(runtime().vector).canRead;
    },
    read: (ids) => vectorReaderFor(runtime().vector).read(ids),
  };
}

/**
 * Puts a document and its stored vector back in one synchronous tick: keyword first, because
 * `RemoteVectorStore.add` drops a vector whose rev the DocLedger does not know, then the vector.
 * Both ops land in the docs outbox together, so the TEE-1169 re-embed loop never sees the doc without
 * its vector. The R3 test runs with the re-embed loop on and counts zero embedding calls.
 */
export function reattachDocument(
  keyword: Pick<KeywordIndexPort, "add">,
  vector: VectorStorePort | null,
  doc: CompressedObservation,
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
