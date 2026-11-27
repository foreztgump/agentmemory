import type { RestoreRequest } from "./admin.js";
import type { ItemRef, RunId } from "./types.js";

/**
 * The payload parsers of `mem::retention-restore` and `mem::retention-pin`. Both boundaries use them: the REST routes
 * (rest.ts) before they trigger a function, and the functions themselves (register.ts), which other workers can
 * trigger directly. A refused payload is `{ kind: "invalid", error }`, which REST answers with 400.
 */

export const MAX_REFS = 100;
const MAX_ID_LENGTH = 256;
const MAX_RUN_ID_LENGTH = 100;
const MAX_REASON_LENGTH = 500;
const MAX_WHO_LENGTH = 100;
const RUN_ID = /^ret_[A-Za-z0-9_-]+$/;

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (error: string): Parsed<never> => ({ ok: false, error });

export interface Invalid {
  readonly kind: "invalid";
  readonly error: string;
}
export const invalid = (parsed: { readonly error: string }): Invalid => ({ kind: "invalid", error: parsed.error });

export type PinRequest =
  | { readonly ref: ItemRef; readonly who: string; readonly reason: string }
  | { readonly ref: ItemRef; readonly who: string; readonly unpin: true };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A payload is an object; absent is an empty one, and anything else is refused. */
export function parsePayload(raw: unknown): Parsed<Record<string, unknown>> {
  const body = raw ?? {};
  return isRecord(body) ? ok(body) : bad("the body must be a JSON object");
}

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

export function parseRunId(raw: unknown, name: string): Parsed<RunId> {
  const id = text(raw, name, MAX_RUN_ID_LENGTH);
  if (!id.ok) return id;
  return RUN_ID.test(id.value) ? ok(id.value as RunId) : bad(`${name} is not a run id`);
}

export function parseRestore(body: Record<string, unknown>): Parsed<RestoreRequest> {
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

/** `who` is required here; the REST route fills in its default label before calling this. */
export function parsePin(body: Record<string, unknown>): Parsed<PinRequest> {
  const ref = parseRef(body["ref"]);
  if (!ref.ok) return ref;
  const who = text(body["who"], "who", MAX_WHO_LENGTH);
  if (!who.ok) return who;
  if (body["unpin"] !== undefined && typeof body["unpin"] !== "boolean") return bad("unpin must be a boolean");
  if (body["unpin"] === true) return ok({ ref: ref.value, who: who.value, unpin: true });
  const reason = text(body["reason"], "reason", MAX_REASON_LENGTH);
  return reason.ok ? ok({ ref: ref.value, who: who.value, reason: reason.value }) : reason;
}
