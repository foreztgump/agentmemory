import { describe, expect, it } from "vitest";
import { getSearchIndex } from "../src/functions/search.js";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import {
  configuredSearchBackend,
  createSearchRuntime,
  getSearchRuntime,
} from "../src/state/search-ports.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { EmbeddingProvider } from "../src/types.js";
import type { StateKV } from "../src/state/kv.js";

const kv = {} as StateKV;
const provider = { name: "test", dimensions: 2 } as EmbeddingProvider;

describe("search runtime", () => {
  it("defaults to the memory backend and rejects unknown ones at boot", () => {
    expect(configuredSearchBackend({})).toBe("memory");
    expect(configuredSearchBackend({ AM_SEARCH_BACKEND: " memory " })).toBe("memory");
    expect(configuredSearchBackend({ AM_SEARCH_BACKEND: "disk" })).toBe("disk");
    expect(() => configuredSearchBackend({ AM_SEARCH_BACKEND: "qdrant" })).toThrow(/AM_SEARCH_BACKEND=qdrant/);
  });

  it("keeps the keyword index callers already reached before boot", () => {
    const early = getSearchIndex();
    const runtime = createSearchRuntime({ kv, embeddingProvider: null });
    expect(runtime.keyword).toBe(early);
    expect(getSearchIndex()).toBe(early);
    expect(getSearchRuntime()).toBe(runtime);
    expect(runtime.keyword).toBeInstanceOf(SearchIndex);
  });

  it("creates a vector index only when an embedding provider exists", () => {
    expect(createSearchRuntime({ kv, embeddingProvider: null }).vector).toBeNull();
    const runtime = createSearchRuntime({ kv, embeddingProvider: provider });
    expect(runtime.vector).toBeInstanceOf(VectorIndex);
    const persistence = runtime.openPersistence();
    expect(persistence).toBeInstanceOf(IndexPersistence);
    expect(runtime.openPersistence()).toBe(persistence);
  });
});
