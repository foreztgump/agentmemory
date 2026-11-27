/**
 * Runs accepted captures in the background: one at a time per session, in submission order,
 * with at most `workers` sessions running at once, taken round robin. Submitting a key that is
 * already waiting or running returns the same promise, so the request path and the sweep can
 * both submit a row without running it twice.
 */
export class SessionLanes<T> {
  private readonly lanes = new Map<string, string[]>();
  private readonly ready: string[] = [];
  private readonly running = new Set<string>();
  private readonly results = new Map<string, { promise: Promise<T>; settle: (run: Promise<T>) => void }>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly run: (key: string) => Promise<T>,
    private readonly workers: number,
  ) {}

  submit(sessionId: string, key: string): Promise<T> {
    const known = this.results.get(key);
    if (known) return known.promise;
    let settle!: (run: Promise<T>) => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = (run) => run.then(resolve, reject);
    });
    this.results.set(key, { promise, settle });
    const lane = this.lanes.get(sessionId);
    if (lane) lane.push(key);
    else {
      this.lanes.set(sessionId, [key]);
      this.ready.push(sessionId);
    }
    this.pump();
    return promise;
  }

  /** Captures waiting or running. */
  depth(): number {
    return this.results.size;
  }

  /** Resolves once nothing is waiting or running. */
  idle(): Promise<void> {
    if (this.results.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.running.size < this.workers && this.ready.length > 0) {
      const sessionId = this.ready.shift()!;
      const key = this.lanes.get(sessionId)!.shift()!;
      this.running.add(sessionId);
      const entry = this.results.get(key)!;
      const run = Promise.resolve().then(() => this.run(key));
      entry.settle(run);
      void run.catch(() => undefined).finally(() => this.finish(sessionId, key));
    }
  }

  private finish(sessionId: string, key: string): void {
    this.results.delete(key);
    this.running.delete(sessionId);
    const lane = this.lanes.get(sessionId)!;
    if (lane.length > 0) this.ready.push(sessionId);
    else this.lanes.delete(sessionId);
    this.pump();
    if (this.results.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
