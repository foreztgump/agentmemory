import { readFile } from "node:fs/promises";
import type { RetentionDeps } from "./satellites.js";

/**
 * The recall check before and after an enforcing run (design 7.4, D5).
 *
 * Cases: the stack's golden recall cases from AM_RETENTION_RECALL_CASES (spec AC4; private, mounted on the
 * stack, never committed). With no golden case configured the run is report-only (`refused`): an unmeasured
 * sweep does not delete. A file that is missing or malformed refuses the run too, so a broken mount never
 * reads as a passing check. Rare-fact cases drawn from protected memories (design 7.4) are not built yet.
 *
 * Case file format: JSON, either `{ "cases": [...] }` or the bare array.
 *   { "id": "billing-region",            unique, non-empty
 *     "query": "which region runs billing",   non-empty; sent to `mem::smart-search`
 *     "evidence": ["mem_ab12", "obs_9f"],     non-empty; observation or memory ids
 *     "golden": true }                        optional, default true
 * A case is recalled when any evidence id is in the top 10; its recall is the share of evidence ids there.
 * A golden case is one the run must not lose.
 *
 * Queries go through `mem::smart-search` with sdk.trigger, so they test what agents get, in either mode.
 * Before the after-check, the docs outbox is drained (`settle`) so disk-mode removals have landed.
 */
export interface RecallCase {
  readonly id: string;
  readonly query: string;
  /** Observation or memory ids whose presence in the top 10 counts as recalled. */
  readonly evidence: readonly string[];
  readonly golden: boolean;
}

export interface RecallScore {
  /** Percentage points, 0 to 100: the mean over cases of the share of a case's evidence found in the top 10. */
  readonly recallAt10: number;
  /** Golden cases with at least one evidence id in the top 10. */
  readonly goldenHit: ReadonlySet<string>;
}

export type RecallJudgement =
  | { readonly kind: "keep" }
  | { readonly kind: "restore"; readonly why: string };

const rounded = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Pure: restore when recall@10 drops by more than `stopPoints` points or any golden case loses its evidence. */
export function judgeRecall(before: RecallScore, after: RecallScore, stopPoints: number): RecallJudgement {
  const lost = [...before.goldenHit].filter((id) => !after.goldenHit.has(id)).sort();
  if (lost.length > 0) return { kind: "restore", why: `golden recall case lost its evidence: ${lost.join(", ")}` };
  const drop = rounded(before.recallAt10 - after.recallAt10);
  if (drop > stopPoints) {
    return { kind: "restore", why: `recall@10 fell ${drop} points (${rounded(before.recallAt10)} to ${rounded(after.recallAt10)}), more than the ${stopPoints} allowed` };
  }
  return { kind: "keep" };
}

export interface RecallHarness {
  /** The configured cases. Rejects when the source is unreadable or malformed. */
  cases(): Promise<readonly RecallCase[]>;
  /** Drains the search outboxes so the index reflects every move (disk mode) and flushes the memory index; once per call. */
  settle(): Promise<void>;
  score(cases: readonly RecallCase[]): Promise<RecallScore>;
}

const invalid = (path: string, why: string): Error => new Error(`recall cases ${path}: ${why}`);

function parseCase(raw: unknown, index: number, path: string, seen: Set<string>): RecallCase {
  const at = `case ${index}`;
  if (typeof raw !== "object" || raw === null) throw invalid(path, `${at} is not an object`);
  const { id, query, evidence, golden } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id.trim() === "") throw invalid(path, `${at} has no id`);
  if (seen.has(id)) throw invalid(path, `id "${id}" is repeated`);
  seen.add(id);
  if (typeof query !== "string" || query.trim() === "") throw invalid(path, `case "${id}" has no query`);
  if (!Array.isArray(evidence) || evidence.length === 0 || !evidence.every((e) => typeof e === "string" && e !== "")) {
    throw invalid(path, `case "${id}" needs a non-empty list of evidence ids`);
  }
  if (golden !== undefined && typeof golden !== "boolean") throw invalid(path, `case "${id}" has a golden that is not true or false`);
  return { id, query, evidence: evidence as string[], golden: golden ?? true };
}

export async function loadRecallCases(path: string | null): Promise<readonly RecallCase[]> {
  if (path === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw invalid(path, err instanceof Error ? err.message : String(err));
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(list)) throw invalid(path, "expected a list of cases or an object with a cases list");
  const seen = new Set<string>();
  return list.map((raw, index) => parseCase(raw, index, path, seen));
}

export async function scoreCases(sdk: RetentionDeps["sdk"], cases: readonly RecallCase[]): Promise<RecallScore> {
  const goldenHit = new Set<string>();
  let share = 0;
  for (const c of cases) {
    const answer = (await sdk.trigger({ function_id: "mem::smart-search", payload: { query: c.query, limit: 10, includeLessons: false } })) as {
      results?: ReadonlyArray<{ obsId: string }>;
    } | null;
    const top = new Set((answer?.results ?? []).slice(0, 10).map((hit) => hit.obsId));
    const found = c.evidence.filter((id) => top.has(id)).length;
    share += found / c.evidence.length;
    if (c.golden && found > 0) goldenHit.add(c.id);
  }
  return { recallAt10: cases.length === 0 ? 100 : (share / cases.length) * 100, goldenHit };
}

export function createRecallHarness(deps: Pick<RetentionDeps, "sdk" | "search">, casesPath: string | null): RecallHarness {
  return {
    cases: () => loadRecallCases(casesPath),
    settle: () => deps.search().openPersistence().save(),
    score: (cases) => scoreCases(deps.sdk, cases),
  };
}
