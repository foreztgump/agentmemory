import type { HttpRequest } from "@iii-dev/helpers/http";
import { InvocationError, type IIIClient } from "iii-sdk";
import { logger } from "../../logger.js";
import { generateId } from "../../state/schema.js";
import type { JobId } from "./jobs.js";
import { ok, parseJobId, parsePayload, parsePin, parseRestore, parseRunId, type Parsed } from "./requests.js";

type Response = { status_code: number; headers?: Record<string, string>; body: unknown };

/** The two guards live in `src/triggers/api.ts`; they are passed in so this module never imports the whole upstream file into the fork build. */
export interface AuthGuards {
  checkAuth(req: HttpRequest, secret: string | undefined): Response | null;
  requireConfiguredSecret(secret: string | undefined, feature: string): Response | null;
}

const DEFAULT_WHO = "api";

/**
 * The engine's HTTP worker times a request out at 180 s (`default_timeout` in deploy/runtime/worker-compose.yaml and
 * src/cli/compose-project.ts) and the worker's `invocationTimeoutMs` is 180 s too (src/index.ts); the invoked function keeps
 * running. A long route stops waiting 30 s sooner and answers 202, so the answer is ours and never the engine's 504.
 */
const DETACH_AFTER_MS = 150_000;

export interface RetentionRestOptions {
  readonly detachAfterMs?: number;
}

/** True unless exactly `false`: a mistyped or missing field never turns a preview into a delete. */
const dryRunOf = (body: Record<string, unknown>): boolean => body["dryRun"] !== false;

/** `who` is an unverified label (one shared secret), so a call that names none is labelled as the API's. */
const withDefaultWho = (body: Record<string, unknown>): Record<string, unknown> => (body["who"] === undefined ? { ...body, who: DEFAULT_WHO } : body);

type Outcome = { readonly kind: string } & Record<string, unknown>;

/** One outcome, one status: the iii functions answer with a `kind`, and this is the only place that turns it into HTTP. */
function statusOf(outcome: Outcome): Response {
  switch (outcome.kind) {
    case "busy":
      return { status_code: 409, body: { ...outcome, error: outcome.kind } };
    case "lease-lost":
      return { status_code: 409, body: { error: "lease-lost", why: "another process took the sweep lease; this call stopped part way, and repeating it settles the rest" } };
    case "off":
      return { status_code: 503, body: { error: "retention is off", why: outcome.why } };
    case "not-found":
      return { status_code: 404, body: { error: "not-found" } };
    case "invalid":
      return { status_code: 400, body: { error: outcome["error"] } };
    default:
      return { status_code: 200, body: outcome };
  }
}

/**
 * The six routes. Registered from `registerApiTriggers`, which owns the `registerTrigger` lines (so the endpoint counters see
 * them). Sweep, purge and restore delete data and a pin changes what may be deleted, but `checkAuth` allows a call when
 * no secret is set, so every handler first answers 503 with no secret and only then checks the token. Each handler
 * whitelists and types its fields and passes the iii function a fresh object, never the request body. Sweep, purge and restore
 * also pass a job id and stop waiting after `detachAfterMs`: a call still running then answers 202 with the id, and
 * GET /agentmemory/retention/job reads the outcome the function records (jobs.ts).
 */
export function registerRetentionTriggers(sdk: IIIClient, secret: string | undefined, guards: AuthGuards, options: RetentionRestOptions = {}): void {
  const detachAfterMs = options.detachAfterMs ?? DETACH_AFTER_MS;
  const route = <Payload extends object>(feature: string, parse: (req: HttpRequest) => Parsed<Payload>, functionId: string, long = false) =>
    async (req: HttpRequest): Promise<Response> => {
      const denied = guards.requireConfiguredSecret(secret, "retention") ?? guards.checkAuth(req, secret);
      if (denied) return denied;
      const payload = parse(req);
      if (!payload.ok) return { status_code: 400, body: { error: payload.error } };
      const jobId = long ? (generateId("job") as JobId) : undefined;
      try {
        const sent = jobId === undefined ? payload.value : { ...payload.value, jobId };
        return statusOf(await sdk.trigger<typeof sent, Outcome>({ function_id: functionId, payload: sent, ...(long && { timeoutMs: detachAfterMs }) }));
      } catch (err) {
        if (jobId !== undefined && err instanceof InvocationError && err.code === "TIMEOUT") {
          return { status_code: 202, body: { kind: "running", jobId, poll: `/agentmemory/retention/job?id=${jobId}` } };
        }
        logger.warn(`retention ${feature} failed`, { error: err instanceof Error ? err.message : String(err) });
        return { status_code: 500, body: { error: `retention ${feature} failed` } };
      }
    };
  const withBody = <Payload>(parse: (body: Record<string, unknown>) => Parsed<Payload>) => (req: HttpRequest): Parsed<Payload> => {
    const body = parsePayload(req.body);
    return body.ok ? parse(body.value) : body;
  };

  sdk.registerFunction("api::retention-sweep", route("sweep", withBody((body) => ok({ dryRun: dryRunOf(body) })), "mem::retention-sweep", true));
  sdk.registerFunction("api::retention-purge", route("purge", withBody((body) => ok({ dryRun: dryRunOf(body) })), "mem::retention-purge", true));
  sdk.registerFunction("api::retention-restore", route("restore", withBody(parseRestore), "mem::retention-restore", true));
  sdk.registerFunction("api::retention-pin", route("pin", withBody((body) => parsePin(withDefaultWho(body))), "mem::retention-pin"));
  sdk.registerFunction(
    "api::retention-report",
    route("report", (req) => {
      const raw = req.query_params?.["runId"];
      if (raw === undefined) return ok({});
      const runId = parseRunId(raw, "runId");
      return runId.ok ? ok({ runId: runId.value }) : runId;
    }, "mem::retention-report"),
  );  sdk.registerFunction(
    "api::retention-job",
    route("job", (req) => {
      const id = parseJobId(req.query_params?.["id"], "id");
      return id.ok ? ok({ id: id.value }) : id;
    }, "mem::retention-job"),
  );
}
