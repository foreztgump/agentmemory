import type { Lesson } from "../../../src/types.js";

export interface LessonCase {
  id: string;
  /** rare: the lesson's three rarest terms; topic: one or two terms several lessons share, where ranking decides. */
  kind: "rare" | "topic";
  query: string;
}

const TOKEN = /[\p{L}\p{N}]{3,}/gu;
const terms = (l: Lesson) => [...new Set(`${l.content}\n${l.context ?? ""}`.toLowerCase().match(TOKEN) ?? [])].filter((t) => !/^\d+$/.test(t));
const compare = (a: string, b: string) => Number(a > b) - Number(a < b);

/** A fixed, seeded set of lesson queries; half rare-term lookups, half shared-topic queries. */
export function buildLessonCases(lessons: Lesson[], count: number, rand: () => number): LessonCase[] {
  const docs = [...lessons].sort((a, b) => compare(a.id, b.id)).map(terms);
  const df = new Map<string, number>();
  for (const ts of docs) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const cases: LessonCase[] = [];
  const seen = new Set<string>();
  for (let tries = 0; cases.length < count && tries < count * 50; tries++) {
    const ts = pick(docs);
    const rarePool = ts.filter((t) => df.get(t)! <= 20).sort((a, b) => df.get(a)! - df.get(b)! || compare(a, b)).slice(0, 3);
    const topicPool = ts.filter((t) => df.get(t)! >= 3 && df.get(t)! <= Math.max(30, docs.length / 20));
    const rares = cases.filter((c) => c.kind === "rare").length;
    const wantRare = rares * 2 <= cases.length;
    const rare = wantRare ? rarePool.length >= 2 || topicPool.length === 0 : topicPool.length === 0;
    const pool = rare ? rarePool : topicPool;
    if (pool.length < (rare ? 2 : 1)) continue;
    const query = rare ? pool.join(" ") : [...new Set([pick(pool), ...(rand() < 0.5 ? [pick(pool)] : [])])].join(" ");
    if (seen.has(query)) continue;
    seen.add(query);
    cases.push({ id: `${rare ? "rare" : "topic"}-${String(cases.length + 1).padStart(3, "0")}`, kind: rare ? "rare" : "topic", query });
  }
  return cases;
}

/** mem::lesson-recall's reranking with its defaults (no project, minConfidence 0.1): confidence x relevance x recency. */
export function rankLessons(hits: Array<{ obsId: string; score: number }>, byId: Map<string, Lesson>, now: number): string[] {
  const maxHit = hits[0]?.score ?? 0;
  const scored: Array<{ id: string; score: number }> = [];
  for (const h of hits) {
    const l = byId.get(h.obsId);
    if (!l || l.deleted || l.confidence < 0.1) continue;
    const days = (now - new Date(l.lastReinforcedAt ?? l.createdAt).getTime()) / 86_400_000;
    scored.push({ id: l.id, score: l.confidence * (maxHit > 0 ? h.score / maxHit : 0) * (1 / (1 + days * 0.01)) });
  }
  return scored.sort((a, b) => b.score - a.score || compare(a.id, b.id)).map((s) => s.id);
}
