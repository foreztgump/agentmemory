// Writes that land while the prefix vocabulary's first scroll runs are counted exactly once, whether the
// scroll reads the point before or after the write, so the corpus statistics equal the live corpus.
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-fill-window.test.ts
import { describe, expect, it } from "vitest";
import { contentRev, type Op } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { PrefixVocabulary } from "../src/fork/worker/prefix-vocabulary.js";
import type { Qdrant } from "../src/fork/worker/qdrant.js";
import { QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const doc = (id: string, title: string): Op => {
  const fields = { title, narrative: "", facts: [], concepts: [], files: [] };
  return { k: "doc", id, sessionId: "ses_fill", layer: "observation", ts: 1, fields, rev: contentRev(fields) };
};

/** Holds the vocabulary scroll before its first request (`before`) or after its first page (`after`). */
function holdScroll(qdrant: Qdrant, when: "before" | "after") {
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { reached = resolve; });
  const call = qdrant.call.bind(qdrant);
  let holding = true;
  qdrant.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const scroll = holding && path.endsWith("/points/scroll") && (body as { with_payload?: unknown }).with_payload?.toString() === "terms,dl,ad";
    if (scroll && when === "before") {
      holding = false;
      reached();
      await open;
    }
    const result = await call<T>(method, path, body);
    if (scroll && when === "after") {
      holding = false;
      reached();
      await open;
    }
    return result;
  };
  return { held, release };
}

/** `fail` makes the write's batch throw before the scroll reads its point, or once the scroll has skipped it. */
async function run(when: "before" | "after", seed: Op[], during: Op[], fail?: "before-scroll" | "after-scroll") {
  const qdrant = qdrantFor(`fill_window_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  await qdrant.drop();
  await qdrant.ensure();
  if (seed.length > 0) expect((await engine.apply(seed)).failed).toEqual([]);
  engine.prefixes!.clear();
  const { held, release } = holdScroll(qdrant, when);
  engine.prefixes!.fillInBackground();
  await held;
  if (fail) {
    let scrolled!: () => void;
    const pageRead = new Promise<void>((resolve) => { scrolled = resolve; });
    const call = qdrant.call.bind(qdrant);
    qdrant.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (path.includes("/points/batch")) {
        if (fail === "after-scroll") await pageRead.then(() => new Promise((resolve) => setTimeout(resolve, 100)));
        throw new Error("batch refused");
      }
      const result = await call<T>(method, path, body);
      if (path.endsWith("/points/scroll")) scrolled();
      return result;
    };
    const applying = expect(engine.apply(during)).rejects.toThrow("batch refused");
    if (fail === "after-scroll") release();
    await applying;
    qdrant.call = call;
  } else expect((await engine.apply(during)).failed).toEqual([]);
  release();
  await engine.settled();
  const frequencies = Object.fromEntries([...engine.prefixes!.frequencies].filter(([, df]) => df > 0));
  const stats = { documents: engine.prefixes!.documentCount, averageLength: engine.prefixes!.averageLength, frequencies };
  await qdrant.drop();
  return stats;
}

describe.skipIf(!QDRANT_URL)("writes during the vocabulary fill", () => {
  it("counts a new document once when the scroll reads it after the write", async () => {
    expect(await run("before", [], [doc("obs_new", "fillnew")])).toEqual({ documents: 1, averageLength: 1, frequencies: { fillnew: 1 } });
  }, 60_000);

  it("replaces a document the scroll already counted", async () => {
    expect(await run("after", [doc("obs_a", "alphaold")], [doc("obs_a", "betanew betanew")]))
      .toEqual({ documents: 1, averageLength: 2, frequencies: { betanew: 1 } });
  }, 60_000);

  it("drops a document deleted before the scroll reads it", async () => {
    expect(await run("before", [doc("obs_a", "alphaold"), doc("obs_b", "keepzz")], [{ k: "del", id: "obs_a" }]))
      .toEqual({ documents: 1, averageLength: 1, frequencies: { keepzz: 1 } });
  }, 60_000);

  it("counts a document whose write failed after it registered, before or after the scroll skipped it", async () => {
    for (const fail of ["before-scroll", "after-scroll"] as const) {
      expect(await run("before", [doc("obs_a", "alphaold")], [doc("obs_a", "betanew")], fail), fail)
        .toEqual({ documents: 1, averageLength: 1, frequencies: { alphaold: 1 } });
    }
  }, 60_000);
});

describe("a failed write retried while its point is read back", () => {
  it("is counted once, by the retry", async () => {
    let openScroll!: () => void;
    const scrollGate = new Promise<void>((resolve) => { openScroll = resolve; });
    let openRead!: () => void;
    const readGate = new Promise<void>((resolve) => { openRead = resolve; });
    const qdrant = {
      path: "/collections/retry",
      call: async (_method: string, path: string) => {
        if (path.endsWith("/points/scroll")) {
          await scrollGate;
          return { points: [{ id: "p1", payload: { terms: ["oldterm"], dl: 1 } }], next_page_offset: null };
        }
        await readGate;
        return [{ id: "p1", payload: { terms: ["newterm"], dl: 1 } }];
      },
    } as unknown as Qdrant;
    const vocab = new PrefixVocabulary(qdrant, async () => {});
    vocab.fillInBackground();
    vocab.touch(["p1"]);
    openScroll();
    await vocab.settled();
    vocab.abandon(["p1"]);
    vocab.touch(["p1"]);
    vocab.changed("p1", { terms: ["oldterm"], dl: 1 }, { terms: ["newterm"], dl: 1 }, true);
    openRead();
    await vocab.settled();
    expect({ documents: vocab.documentCount, frequencies: Object.fromEntries([...vocab.frequencies].filter(([, df]) => df > 0)) })
      .toEqual({ documents: 1, frequencies: { newterm: 1 } });
  });
});

describe("a failed write whose read-back fails too", () => {
  it("is not ready until the next search reads it back and counts it", async () => {
    let reads = 0;
    const qdrant = {
      path: "/collections/recount",
      call: async (_method: string, path: string) => {
        if (path.endsWith("/points/scroll")) {
          return { points: [{ id: "p1", payload: { terms: ["oldterm"], dl: 1 } }, { id: "p2", payload: { terms: ["other"], dl: 1 } }], next_page_offset: null };
        }
        if (reads++ === 0) throw new Error("read refused");
        return [{ id: "p1", payload: { terms: ["oldterm"], dl: 1 } }];
      },
    } as unknown as Qdrant;
    const vocab = new PrefixVocabulary(qdrant, async () => {});
    const counts = () => ({ ready: vocab.isReady, documents: vocab.documentCount, frequencies: Object.fromEntries([...vocab.frequencies].filter(([, df]) => df > 0)) });
    vocab.fillInBackground();
    vocab.touch(["p1"]);
    await vocab.settled();
    vocab.abandon(["p1"]);
    await vocab.settled();
    expect(counts()).toEqual({ ready: false, documents: 1, frequencies: { other: 1 } });
    vocab.fillInBackground();
    await vocab.settled();
    expect(counts()).toEqual({ ready: true, documents: 2, frequencies: { oldterm: 1, other: 1 } });
  });
});
