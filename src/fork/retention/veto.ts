import type { StateKV } from "../../state/kv.js";
import { RETENTION_KV } from "./scopes.js";
import type { SessionSeal } from "./types.js";

/**
 * The summarize veto (design 5.2, R7, D10). `mem::summarize` calls `summaryRebuildVetoed(sessionId)` at
 * its top (seam in src/functions/summarize.ts, about 4 lines) and, when it is true, returns the stored
 * summary unchanged with `{ success: true, unchanged: true }`, which summary recovery already treats as
 * settled. Registered by the fork at boot; with nothing registered, nothing is vetoed, so upstream
 * behaviour and the memory-only build are unchanged.
 *
 * One veto at a time: a second registration throws rather than silently replacing the first, because two
 * owners of the same decision is a wiring bug. Tests call `resetSummarizeVeto` so one test's veto cannot
 * leak into the next.
 */
export type SummarizeVeto = (sessionId: string) => Promise<boolean>;

let veto: SummarizeVeto | null = null;

export function setSummarizeVeto(next: SummarizeVeto): void {
  if (veto) throw new Error("a summarize veto is already registered; resetSummarizeVeto() clears it (tests only)");
  veto = next;
}

export function resetSummarizeVeto(): void {
  veto = null;
}

export async function summaryRebuildVetoed(sessionId: string): Promise<boolean> {
  return veto ? veto(sessionId) : false;
}

/** The fork's veto: one point read of the session's seal, true once stage O has moved a row (`trimmed`). */
export function trimmedSealVeto(kv: StateKV): SummarizeVeto {
  return async (sessionId) => (await kv.get<SessionSeal>(RETENTION_KV.seals, sessionId))?.trimmed === true;
}
