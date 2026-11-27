// Writes that land while the prefix vocabulary's first scroll runs are counted exactly once, whether the
// scroll reads the point before or after the write, so the corpus statistics equal the live corpus.
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-fill-window.test.ts
import { describe, expect, it } from "vitest";
import { contentRev, type Op } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
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

async function run(when: "before" | "after", seed: Op[], during: Op[]) {
  const qdrant = qdrantFor(`fill_window_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  await qdrant.drop();
  await qdrant.ensure();
  if (seed.length > 0) expect((await engine.apply(seed)).failed).toEqual([]);
  engine.prefixes!.clear();
  const { held, release } = holdScroll(qdrant, when);
  engine.prefixes!.fillInBackground();
  await held;
  expect((await engine.apply(during)).failed).toEqual([]);
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
});
