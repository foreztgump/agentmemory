/**
 * The summarize veto (design 5.2, R7, D10). `mem::summarize` calls `summaryRebuildVetoed(sessionId)` at
 * its top (seam in src/functions/summarize.ts, about 4 lines) and, when it is true, returns the stored
 * summary unchanged with `{ success: true, unchanged: true }`, which summary recovery already treats as
 * settled. Registered by the fork at boot; with nothing registered, nothing is vetoed, so upstream
 * behaviour and the memory-only build are unchanged.
 */
export type SummarizeVeto = (sessionId: string) => Promise<boolean>;

let veto: SummarizeVeto | null = null;

export function setSummarizeVeto(next: SummarizeVeto | null): void {
  veto = next;
}

export async function summaryRebuildVetoed(sessionId: string): Promise<boolean> {
  return veto ? veto(sessionId) : false;
}
