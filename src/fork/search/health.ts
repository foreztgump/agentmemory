import { logger } from "../../logger.js";
import type { SearchWorkerClient } from "./client.js";

/** While degraded, one request per RETRY_MS reaches the worker; the rest fail fast. */
const RETRY_MS = 5000;

export type Health = { ok: true; since: string } | { ok: false; since: string; reason: string };

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The one owner of "can the search backend answer". Every worker call
 * reports here (see trackHealth), so the first failing call marks the
 * backend degraded and the first succeeding one marks it healthy again.
 */
export class BackendHealth {
  private state: Health = { ok: true, since: new Date().toISOString() };
  private lastAttempt = 0;
  private recoverListeners = new Set<() => void>();
  private probing: Promise<Health> | null = null;

  get current(): Health {
    return this.state;
  }

  get ok(): boolean {
    return this.state.ok;
  }

  reportOk(): void {
    if (this.state.ok) return;
    this.state = { ok: true, since: new Date().toISOString() };
    logger.info("search backend reachable again");
    for (const listener of this.recoverListeners) listener();
  }

  reportFailure(err: unknown): void {
    const reason = reasonOf(err);
    if (this.state.ok) {
      logger.warn("search backend unavailable; keyword and vector search return no hits until it recovers", { error: reason });
      this.state = { ok: false, since: new Date().toISOString(), reason };
    } else {
      this.state = { ...this.state, reason };
    }
  }

  /** Healthy: always. Degraded: once per RETRY_MS, so a dead backend costs one timeout per window, not one per search. */
  allowRequest(now = Date.now()): boolean {
    if (this.state.ok) return true;
    if (now - this.lastAttempt < RETRY_MS) return false;
    this.lastAttempt = now;
    return true;
  }

  onRecover(listener: () => void): () => void {
    this.recoverListeners.add(listener);
    return () => this.recoverListeners.delete(listener);
  }

  /** One search::health call shared by concurrent callers; no answer within deadlineMs counts as a failure. */
  probe(client: Pick<SearchWorkerClient, "health">, deadlineMs: number): Promise<Health> {
    this.probing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`search worker did not answer within ${deadlineMs} ms`)), deadlineMs);
        timer.unref?.();
      });
      try {
        await Promise.race([client.health(), timeout]);
      } catch (err) {
        this.reportFailure(err);
      } finally {
        clearTimeout(timer);
        this.probing = null;
      }
      return this.state;
    })();
    return this.probing;
  }
}

/**
 * Wraps the worker client so every call reports to health. A health answer
 * of ok: false (worker up, Qdrant down or the collection red) is a failure too.
 */
export function trackHealth(client: SearchWorkerClient, health: BackendHealth): SearchWorkerClient {
  const tracked = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(client) as Array<[string, unknown]>) {
    if (typeof fn !== "function") continue;
    tracked[name] = async (...args: unknown[]) => {
      try {
        // Looked up per call: a caller may replace a method on the client after the runtime is built.
        const method = (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
        const result = await method.apply(client, args);
        if (name === "health" && !(result as { ok?: boolean }).ok) {
          const r = result as { status?: string; error?: string };
          health.reportFailure(new Error(`Qdrant ${r.status ?? "unhealthy"}${r.error ? `: ${r.error}` : ""}`));
        } else {
          health.reportOk();
        }
        return result;
      } catch (err) {
        health.reportFailure(err);
        throw err;
      }
    };
  }
  return tracked as unknown as SearchWorkerClient;
}
