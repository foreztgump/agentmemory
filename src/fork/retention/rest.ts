import type { HttpRequest } from "@iii-dev/helpers/http";
import type { IIIClient } from "iii-sdk";
import { logger } from "../../logger.js";
import type { ItemRef } from "./types.js";

type Response = { status_code: number; headers?: Record<string, string>; body: unknown };

/** The two guards live in `src/triggers/api.ts`; they are passed in so this module never imports the whole upstream file into the fork build. */
export interface AuthGuards {
  checkAuth(req: HttpRequest, secret: string | undefined): Response | null;
  requireConfiguredSecret(secret: string | undefined, feature: string): Response | null;
}

export const MAX_REFS = 100;
const MAX_ID_LENGTH = 256;
const MAX_RUN_ID_LENGTH = 100;
const MAX_REASON_LENGTH = 500;
const MAX_WHO_LENGTH = 100;
const DEFAULT_WHO = "api";
const RUN_ID = /^ret_[A-Za-z0-9_-]+$/;

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (error: string): Parsed<never> => ({ ok: false, error });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, name: string, max: number): Parsed<string> {
  if (typeof value !== "string" || value.trim() === "") return bad(`${name} must be a non-empty string`);
  return value.length > max ? bad(`${name} must be at most ${max} characters`) : ok(value);
}

function parseRef(raw: unknown): Parsed<ItemRef> {
  if (!isRecord(raw)) return bad("ref must be an object");
  const id = text(raw["id"], "ref.id", MAX_ID_LENGTH);
  if (!id.ok) return id;
  if (raw["kind"] === "memory") return ok({ kind: "memory", id: id.value });
  if (raw["kind"] !== "observation") return bad('ref.kind must be "memory" or "observation"');
  const sessionId = text(raw["sessionId"], "ref.sessionId", MAX_ID_LENGTH);
  return sessionId.ok ? ok({ kind: "observation", sessionId: sessionId.value, id: id.value }) : sessionId;
}

function parseRunId(raw: unknown, name: string): Parsed<string> {
  const id = text(raw, name, MAX_RUN_ID_LENGTH);
  return id.ok && !RUN_ID.test(id.value) ? bad(`${name} is not a run id`) : id;
}

/** A body is an object or absent; everything else is refused. */
function bodyOf(req: HttpRequest): Parsed<Record<string, unknown>> {
  const body = req.body ?? {};
  return isRecord(body) ? ok(body) : bad("the body must be a JSON object");
}

/** True unless exactly `false`: a mistyped or missing field never turns a preview into a delete. */
const dryRunOf = (body: Record<string, unknown>): boolean => body["dryRun"] !== false;

function parseRestore(body: Record<string, unknown>): Parsed<{ runId: string } | { refs: ItemRef[] }> {
  const { runId, refs } = body;
  if ((runId === undefined) === (refs === undefined)) return bad("give either runId or refs");
  if (runId !== undefined) {
    const id = parseRunId(runId, "runId");
    return id.ok ? ok({ runId: id.value }) : id;
  }
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_REFS) return bad(`refs must be a list of 1 to ${MAX_REFS} refs`);
  const parsed: ItemRef[] = [];
  for (const raw of refs) {
    const ref = parseRef(raw);
    if (!ref.ok) return ref;
    parsed.push(ref.value);
  }
  return ok({ refs: parsed });
}

function parsePin(body: Record<string, unknown>): Parsed<{ ref: ItemRef; who: string; reason: string } | { ref: ItemRef; who: string; unpin: true }> {
  const ref = parseRef(body["ref"]);
  if (!ref.ok) return ref;
  const who = body["who"] === undefined ? ok(DEFAULT_WHO) : text(body["who"], "who", MAX_WHO_LENGTH);
  if (!who.ok) return who;
  if (body["unpin"] !== undefined && typeof body["unpin"] !== "boolean") return bad("unpin must be a boolean");
  if (body["unpin"] === true) return ok({ ref: ref.value, who: who.value, unpin: true });
  const reason = text(body["reason"], "reason", MAX_REASON_LENGTH);
  return reason.ok ? ok({ ref: ref.value, who: who.value, reason: reason.value }) : reason;
}

type Outcome = { readonly kind: string } & Record<string, unknown>;

/** One outcome, one status: the iii functions answer with a `kind`, and this is the only place that turns it into HTTP. */
function statusOf(outcome: Outcome): Response {
  switch (outcome.kind) {
    case "busy":
    case "run-open":
      return { status_code: 409, body: { ...outcome, error: outcome.kind } };
    case "lease-lost":
      return { status_code: 409, body: { error: "lease-lost", why: "another process took the sweep lease; the run stays open and the next sweep resumes it" } };
    case "off":
      return { status_code: 503, body: { error: "retention is off", why: outcome.why } };
    case "not-found":
      return { status_code: 404, body: { error: "not-found" } };
    default:
      return { status_code: 200, body: outcome };
  }
}

/**
 * The five routes. Registered from `registerApiTriggers`, which owns the `registerTrigger` lines (so the endpoint counters see
 * them). Sweep, purge and restore delete data and a pin changes what may be deleted, but `checkAuth` allows a call when
 * no secret is set, so every handler first answers 503 with no secret and only then checks the token. Each handler
 * whitelists and types its fields and passes the iii function a fresh object, never the request body.
 */
export function registerRetentionTriggers(sdk: IIIClient, secret: string | undefined, guards: AuthGuards): void {
  const route = <Payload>(feature: string, parse: (req: HttpRequest) => Parsed<Payload>, functionId: string) =>
    async (req: HttpRequest): Promise<Response> => {
      const denied = guards.requireConfiguredSecret(secret, "retention") ?? guards.checkAuth(req, secret);
      if (denied) return denied;
      const payload = parse(req);
      if (!payload.ok) return { status_code: 400, body: { error: payload.error } };
      try {
        return statusOf(await sdk.trigger<Payload, Outcome>({ function_id: functionId, payload: payload.value }));
      } catch (err) {
        logger.warn(`retention ${feature} failed`, { error: err instanceof Error ? err.message : String(err) });
        return { status_code: 500, body: { error: `retention ${feature} failed` } };
      }
    };
  const withBody = <Payload>(parse: (body: Record<string, unknown>) => Parsed<Payload>) => (req: HttpRequest): Parsed<Payload> => {
    const body = bodyOf(req);
    return body.ok ? parse(body.value) : body;
  };

  sdk.registerFunction("api::retention-sweep", route("sweep", withBody((body) => ok({ dryRun: dryRunOf(body) })), "mem::retention-sweep"));
  sdk.registerFunction("api::retention-purge", route("purge", withBody((body) => ok({ dryRun: dryRunOf(body) })), "mem::retention-purge"));
  sdk.registerFunction("api::retention-restore", route("restore", withBody(parseRestore), "mem::retention-restore"));
  sdk.registerFunction("api::retention-pin", route("pin", withBody(parsePin), "mem::retention-pin"));
  sdk.registerFunction(
    "api::retention-report",
    route("report", (req) => {
      const raw = req.query_params?.["runId"];
      if (raw === undefined) return ok({});
      const runId = parseRunId(raw, "runId");
      return runId.ok ? ok({ runId: runId.value }) : runId;
    }, "mem::retention-report"),
  );
}
