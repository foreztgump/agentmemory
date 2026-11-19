// TEE-1164 AC6 on a stack with AM_SEARCH_BACKEND=disk (stack-compose.yml):
// save a memory, time until it is findable by keyword and by vector, link it
// into the graph, delete it, and check it left keyword, vector and graph results.
//
//   node --import tsx bench/fork/qdrant/ac6.ts [--url http://127.0.0.1:13111] [--qdrant http://127.0.0.1:16335]
import { parseArgs } from "node:util";
import { querySparse } from "../../../src/fork/worker/bm25-sparse.js";
import { pointId } from "../../../src/fork/worker/qdrant.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:13111" },
    secret: { type: "string", default: "stack-dummy-secret" },
    qdrant: { type: "string", default: "http://127.0.0.1:16335" },
    "qdrant-key": { type: "string", default: "stack-dummy-qdrant-key" },
    collection: { type: "string", default: "agentmemory" },
    // For a comparison run on AM_SEARCH_BACKEND=memory, where there is no collection.
    "no-qdrant": { type: "boolean", default: false },
  },
});

async function am<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${args.url}/agentmemory${path}`, {
    method,
    headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function qd<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (args["no-qdrant"]) return (path === "/points" ? [] : { points: [] }) as T;
  const res = await fetch(`${args.qdrant}/collections/${args.collection}${path}`, {
    method,
    headers: { "api-key": args["qdrant-key"], "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`qdrant ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { result: T }).result;
}

const tag = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const token = `qzv${tag}x`;
const entity = `Qorbex${tag}`;
const file = `src/qlune${tag}/qmarrowx.ts`;
const step = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ step: name, ...data }));

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<{ value: T; ms: number } | null> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = await probe();
    if (value !== undefined) return { value, ms: Math.round(performance.now() - started) };
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const smartIds = async (query: string) =>
  (await am<{ results: Array<{ obsId: string }> }>("POST", "/smart-search", { query, limit: 20 })).results.map((r) => r.obsId);
const keywordIds = async (query: string) =>
  (await qd<{ points: Array<{ payload: { doc_id: string } }> }>("POST", "/points/query", {
    query: querySparse(query), using: "bm25", limit: 20, with_payload: ["doc_id"],
  })).points.map((p) => p.payload.doc_id);
const vectorOf = async (id: string) => {
  const [point] = await qd<Array<{ vector?: { dense?: number[] }; payload: { dense: boolean; deleted?: boolean } }>>("POST", "/points", { ids: [pointId(id)], with_vector: ["dense"], with_payload: ["dense", "deleted"] });
  return point?.payload.deleted ? undefined : point;
};
const vectorIds = async (vector: number[]) =>
  (await qd<{ points: Array<{ payload: { doc_id: string } }> }>("POST", "/points/query", {
    query: vector, using: "dense", limit: 20, params: { quantization: { rescore: true, oversampling: 6 } }, with_payload: ["doc_id"],
  })).points.map((p) => p.payload.doc_id);

const saveStarted = performance.now();
const { memory } = await am<{ memory: { id: string } }>("POST", "/remember", {
  title: `Release checklist ${token}`,
  content: `Before tagging a release run the migration dry run, token ${token}.`,
  files: [file],
});
const savedMs = Math.round(performance.now() - saveStarted);
step("saved", { id: memory.id, requestMs: savedMs });

const keyword = await until(async () => ((await keywordIds(token)).includes(memory.id) ? true : undefined));
const smart = await until(async () => ((await smartIds(token)).includes(memory.id) ? true : undefined));
const vector = await until(async () => {
  const point = await vectorOf(memory.id);
  return point?.vector?.dense && point.payload.dense ? point.vector.dense : undefined;
});
const vectorHit = vector ? (await vectorIds(vector.value)).includes(memory.id) : false;
step("findable", {
  keywordInQdrantMs: keyword && keyword.ms + savedMs,
  smartSearchMs: smart && smart.ms + savedMs,
  vectorStoredMs: vector && vector.ms + savedMs,
  vectorSearchFindsIt: vectorHit,
  within5s: Boolean(keyword && smart && vector && vectorHit && Math.max(keyword.ms, smart.ms, vector.ms) + savedMs <= 5000),
});

// The graph links the entity to the memory only through a shared file, the
// same shape as the synthetic tier's graph cases. Graph retrieval skips a node
// whose source record does not exist, so the anchor is a real memory too.
const { memory: anchorMemory } = await am<{ memory: { id: string } }>("POST", "/remember", {
  title: `${entity} owns the release scripts`, content: `${entity} maintains ${file}`, concepts: [entity], files: [file],
});
const anchor = {
  id: anchorMemory.id, sessionId: "memory", timestamp: new Date().toISOString(), type: "discovery",
  title: `${entity} owns the release scripts`, narrative: `${entity} maintains ${file}`, facts: [], concepts: [entity], files: [file], importance: 5,
};
const asObservation = {
  id: memory.id, sessionId: "memory", timestamp: new Date().toISOString(), type: "decision",
  title: `Release checklist ${token}`, narrative: "release notes", facts: [], concepts: [], files: [file], importance: 5,
};
await am("POST", "/graph/extract", { observations: [anchor, asObservation] });
await am("POST", "/graph/index/migrate", { allowLegacyScan: true });
await until(async () => ((await am<{ ready?: boolean }>("GET", "/graph/index")).ready ? true : undefined), 60_000);
// The entity is in neither the memory's text nor any indexed record, so with no
// embedding provider (--graph-only stack) only the graph stream can return it.
const graphHit = await until(async () => ((await smartIds(`"${entity}"`)).includes(memory.id) ? true : undefined));
step("graph", { smartSearchByEntityFindsItMs: graphHit && graphHit.ms });

const deleteStarted = performance.now();
await am("POST", "/forget", { memoryId: memory.id });
const forgetRequestMs = Math.round(performance.now() - deleteStarted);
const gone = await until(async () => {
  const [kw, sm, smGraph] = await Promise.all([keywordIds(token), smartIds(token), smartIds(`"${entity}"`)]);
  const point = await vectorOf(memory.id);
  const vec = vector ? await vectorIds(vector.value) : [];
  return !kw.includes(memory.id) && !sm.includes(memory.id) && !smGraph.includes(memory.id) && !point && !vec.includes(memory.id) ? true : undefined;
});
step("deleted", {
  forgetRequestMs,
  goneEverywhereAfterForgetMs: gone && gone.ms,
  keywordStillFinds: (await keywordIds(token)).includes(memory.id),
  smartSearchStillFinds: (await smartIds(token)).includes(memory.id),
  pointInQdrant: Boolean(await vectorOf(memory.id)),
  vectorSearchStillFinds: vector ? (await vectorIds(vector.value)).includes(memory.id) : null,
  smartSearchByEntityStillFinds: (await smartIds(`"${entity}"`)).includes(memory.id),
});
