import { pXX } from "../../../benchmark/lib/percentiles.js";

export interface EvalCase {
  id: string;
  kind: string;
  query: string;
  expected: string[];
}

export interface CaseResult {
  id: string;
  kind: string;
  rank: number | null;
  recall: number;
  pass: boolean;
}

export interface EvalScores {
  cases: number;
  recallAt10: number;
  mrr: number;
  graphPassed: number;
  graphCases: number;
  byKind: Record<string, { cases: number; recallAt10: number; mrr: number }>;
}

export const K = 10;

// Expected ids are alternatives (copies of the same fact count once): a case is
// recalled when any expected id is in the top K, and its rank is the first such id.
export function scoreCase(c: EvalCase, returned: string[]): CaseResult {
  const top = returned.slice(0, K);
  const firstRank = top.findIndex((id) => c.expected.includes(id));
  const pass = firstRank >= 0;
  return { id: c.id, kind: c.kind, rank: pass ? firstRank + 1 : null, recall: pass ? 1 : 0, pass };
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

function summarize(results: CaseResult[]) {
  const n = results.length;
  return {
    cases: n,
    recallAt10: n ? round(results.reduce((a, r) => a + r.recall, 0) / n) : 0,
    mrr: n ? round(results.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / n) : 0,
  };
}

export function aggregate(results: CaseResult[]): EvalScores {
  const kinds = [...new Set(results.map((r) => r.kind))].sort();
  const graph = results.filter((r) => r.kind === "graph");
  return {
    ...summarize(results),
    graphPassed: graph.filter((r) => r.pass).length,
    graphCases: graph.length,
    byKind: Object.fromEntries(kinds.map((k) => [k, summarize(results.filter((r) => r.kind === k))])),
  };
}

export function latencySummary(ms: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...ms].sort((a, b) => a - b);
  return { p50: round(pXX(sorted, 50)), p95: round(pXX(sorted, 95)), max: round(sorted[sorted.length - 1] ?? NaN) };
}

export interface Limit {
  metric: string;
  max?: number;
  min?: number;
}

export interface Violation {
  metric: string;
  measured: number | undefined;
  limit: string;
}

// Every metric named in the limits must be measured; a missing one is a violation,
// so a broken measurement cannot pass silently.
export function checkLimits(measured: Record<string, number>, limits: Limit[]): Violation[] {
  const out: Violation[] = [];
  for (const l of limits) {
    const v = measured[l.metric];
    if (v === undefined || !Number.isFinite(v)) {
      out.push({ metric: l.metric, measured: v, limit: "must be measured" });
      continue;
    }
    if (l.max !== undefined && v > l.max) out.push({ metric: l.metric, measured: v, limit: `<= ${l.max}` });
    if (l.min !== undefined && v < l.min) out.push({ metric: l.metric, measured: v, limit: `>= ${l.min}` });
  }
  return out;
}
