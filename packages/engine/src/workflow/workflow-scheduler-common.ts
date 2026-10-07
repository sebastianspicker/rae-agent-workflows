/** Shares envelope persistence, draining, stop-driven abort, edge conditions, loop restarts and run budgets across schedulers. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { writeExclusiveFileAtomic } from "../primitives/atomic-file.js";
import { canonicalJson } from "./workflow-contract.js";
import { validateNodeEnvelope } from "./workflow-envelope.js";
import type { JsonValue } from "@rae/contracts";
import type { WorkflowNodeEnvelope } from "./workflow-envelope.js";

/** Node envelope schemas cap `attempt` at this value. */
export const MAX_ENVELOPE_ATTEMPT = 3;
/** Node envelope schemas cap `loop_iteration` at this value. */
export const MAX_LOOP_ITERATION = 5;
/** Finding id a verification gate adds when only a writer's fresh output forces re-verification. */
export const WRITER_REVERIFICATION_FINDING = "writer-reverification";
const STOP_POLL_MS = 500;

/** Terminal reasons a bounded loop reports when it stops repeating. */
export type LoopState = "none" | "repeat" | "no-progress" | "budget-exhausted" | "rounds-exhausted";
/** Terminal reasons reported when a run-level budget is spent. */
export type RunBudgetStop = "wall-clock-exhausted" | "provider-attempts-exhausted";

interface ConditionEdge {
  condition?: string;
}
interface ConditionEnvelope {
  status: string;
  payload: JsonValue;
  findings?: Array<Record<string, unknown>>;
}

/** `<loop>.<attempt>.json` for v2.0 and `<instance>.<attempt>.json` for v2.1 and v2.2. */
function envelopeFileName(envelope: WorkflowNodeEnvelope): string {
  if (envelope.schema_version === "2.0.0") {
    return `${envelope.loop_iteration ?? 1}.${envelope.attempt}.json`;
  }
  const instance = envelope.instance_id.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return `${instance}.${envelope.attempt}.json`;
}

/** Validates and durably records one attempt envelope; an existing attempt is never replaced. */
export function persistEnvelope(runDir: string | null, envelope: WorkflowNodeEnvelope): void {
  validateNodeEnvelope(envelope);
  if (!runDir) return;
  const directory = resolve(runDir, "workflow", "attempts", envelope.node_id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeExclusiveFileAtomic(
    resolve(directory, envelopeFileName(envelope)),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
}

/** Parses a persisted envelope and names the file when it is truncated or not JSON. */
export function readEnvelopeFile(pathValue: string): unknown {
  const text = readFileSync(pathValue, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `workflow envelope ${basename(dirname(pathValue))}/${basename(pathValue)} is truncated or not valid JSON; inspect or move it aside before resuming`,
    );
  }
}

function findingBlocks(finding: Record<string, unknown>): boolean {
  return finding.blocking === true || finding.severity === "blocking";
}

function payloadField(payload: JsonValue, key: string): JsonValue | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

/**
 * Evaluates an edge condition with each schema version's own semantics: v2.0 treats an absent
 * condition as always true and also reads a failed payload status as blocking; v2.1 and v2.2 treat
 * an absent condition as success, and v2.1 counts `collected` as a failure.
 */
export function conditionMatches(
  schemaVersion: string,
  edge: ConditionEdge,
  envelope: ConditionEnvelope,
): boolean {
  const legacy = schemaVersion === "2.0.0";
  if (!edge.condition) return legacy || envelope.status === "passed";
  if (edge.condition === "success") return envelope.status === "passed";
  if (edge.condition === "failure") {
    const failed =
      schemaVersion === "2.1.0" ? ["failed", "blocked", "collected"] : ["failed", "blocked"];
    return failed.includes(envelope.status);
  }
  if (edge.condition === "budget-available") {
    return payloadField(envelope.payload, "budget_available") !== false;
  }
  if (edge.condition === "blocking-findings") {
    const payloadFailed =
      legacy && ["failed", "blocked"].includes(String(payloadField(envelope.payload, "status")));
    return payloadFailed || (envelope.findings ?? []).some(findingBlocks);
  }
  return false;
}

/** Names the nodes whose failure disabled the remaining path, so a blocked run says why. */
export function noProgressMessage(
  failures: ReadonlyArray<{ id: string; kind: string; status: string; message?: unknown }>,
  completedIds: Iterable<string>,
): string {
  const failed = [
    ...new Set(
      failures.map(
        ({ id, kind, status, message }) =>
          `${kind === "gate" ? "gate" : "node"} ${id} ${status}${typeof message === "string" ? `: ${message}` : ""}`,
      ),
    ),
  ].sort();
  const reason = failed.length
    ? `${failed.join("; ")} and no loop-back or alternative path continues the workflow`
    : "no node is ready";
  return `workflow cannot make progress: ${reason}; completed: ${[...completedIds].sort().join(", ")}`;
}

/** Awaits every settled-record promise; they never reject, so none is left running. */
export async function drainSettled<T>(promises: Iterable<Promise<T>>): Promise<T[]> {
  return Promise.all([...promises]);
}

/**
 * Polls `stopRequested` while providers run and aborts `controller` once it is true, so an
 * operator stop terminates running provider process groups instead of waiting for them.
 * Returns a disposer that stops polling.
 */
export function abortOnStop(stopRequested: () => boolean, controller: AbortController): () => void {
  const timer = setInterval(() => {
    let requested = false;
    try {
      requested = stopRequested();
    } catch {
      // An unreadable control file is handled by the scheduler's own stop check.
    }
    if (requested) controller.abort(new Error("workflow stop requested"));
  }, STOP_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Decides whether a persisted failed checkpoint is re-evaluated on resume. Checkpoints are exempt
 * from the per-node attempt budget and never retried within one scheduler pass, so each resume
 * evaluates them once and numbering continues from the persisted attempt. A final human decision
 * is never re-evaluated, and the envelope schema bounds the attempt number. Returns true or the
 * reason the checkpoint cannot be re-evaluated.
 */
export function checkpointResumable(envelope: {
  attempt: number;
  failure?: Record<string, unknown> | null;
}): true | string {
  if (terminalCheckpointFailure(envelope)) {
    const message = envelope.failure?.message;
    return `the human decision is final${typeof message === "string" ? ` (${message})` : ""}`;
  }
  if (envelope.attempt >= MAX_ENVELOPE_ATTEMPT) {
    return `all ${MAX_ENVELOPE_ATTEMPT} recordable attempts are used; start a new run`;
  }
  return true;
}

/** True for a persisted checkpoint failure caused by a final human rejection or escalation. */
export function terminalCheckpointFailure(envelope: {
  failure?: Record<string, unknown> | null;
}): boolean {
  const failure = envelope.failure;
  if (!failure) return false;
  if (failure.terminal === true) return true;
  // Envelopes written before `terminal` was recorded carry only the runtime's message.
  return (
    typeof failure.message === "string" &&
    /^checkpoint \S+ was (rejected|escalated)$/.test(failure.message)
  );
}

interface GateEnvelope {
  status: string;
  payload: JsonValue;
  findings?: Array<Record<string, unknown>>;
  output_digest: string;
}

function outputDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Identifies a finding by its summary and blocking flag; the id only stands in for an empty summary. */
function findingIdentity(finding: Record<string, unknown>): string {
  const blocking = findingBlocks(finding);
  if (typeof finding.summary === "string" && finding.summary !== "") {
    return `summary:${finding.summary}|blocking:${blocking}`;
  }
  if (typeof finding.id === "string") return `id:${finding.id}|blocking:${blocking}`;
  return `finding:${canonicalJson(finding)}`;
}

/**
 * Summarizes a failed gate for repair accounting. The no-progress key is the digest of the sorted
 * blocking finding identities, excluding the writer re-verification finding; without blocking
 * findings the gate's output digest stands in. A failure caused only by the writer
 * re-verification finding (with every input passed) is writer-forced and consumes no repair round.
 */
export function gateProgress(envelope: GateEnvelope): { key: string; writerOnly: boolean } {
  const blocking = (envelope.findings ?? []).filter(findingBlocks);
  const substantive = blocking.filter((finding) => finding.id !== WRITER_REVERIFICATION_FINDING);
  const inputsFailed = payloadField(envelope.payload, "inputs_failed") === true;
  return {
    key: substantive.length
      ? outputDigest([...new Set(substantive.map(findingIdentity))].sort())
      : `output:${envelope.output_digest}`,
    writerOnly: blocking.length > substantive.length && substantive.length === 0 && !inputsFailed,
  };
}

/**
 * `repairs` counts repair rounds already consumed and `repairLimit` is how many are allowed, so
 * `--max-repair-rounds N` permits N repairs. Writer-forced failures consume no round but still
 * advance the loop iteration, which the envelope schema caps at MAX_LOOP_ITERATION.
 */
function loopExhaustionReason({
  repairs,
  repairLimit,
  consumesRound,
  nextIteration,
  iterationLimit,
  repeats,
  budgetAvailable,
}: {
  repairs: number;
  repairLimit: number;
  consumesRound: boolean;
  nextIteration: number;
  iterationLimit: number;
  repeats: number;
  budgetAvailable: unknown;
}): "no-progress" | "budget-exhausted" | "rounds-exhausted" | null {
  if (repeats >= 2) return "no-progress";
  if (budgetAvailable === false) return "budget-exhausted";
  if ((consumesRound && repairs >= repairLimit) || nextIteration > iterationLimit) {
    return "rounds-exhausted";
  }
  return null;
}

/** Per-loop accounting for bounded loops, keyed by loop node id. */
export interface LoopLedger {
  iterations: Map<string, number>;
  repairs: Map<string, number>;
  progress: Map<string, string[]>;
  limits: Map<string, number>;
}

/**
 * Decides whether a failed gate restarts its bounded loop. Returns `repeat` after advancing the
 * ledger, or the reason the loop is exhausted; the caller clears the loop members on `repeat`.
 */
export function decideBoundedRepeat(
  ledger: LoopLedger,
  loopId: string,
  envelope: GateEnvelope,
  repairLimit: number,
): Exclude<LoopState, "none"> {
  const iteration = ledger.iterations.get(loopId) ?? 1;
  const repairs = ledger.repairs.get(loopId) ?? 0;
  const { key, writerOnly } = gateProgress(envelope);
  let repeats = 0;
  if (!writerOnly) {
    const prior = ledger.progress.get(loopId) ?? [];
    repeats = prior.filter((entry) => entry === key).length + 1;
    ledger.progress.set(loopId, [...prior, key]);
  }
  const exhaustion = loopExhaustionReason({
    repairs,
    repairLimit,
    consumesRound: !writerOnly,
    nextIteration: iteration + 1,
    iterationLimit: ledger.limits.get(loopId) ?? MAX_LOOP_ITERATION,
    repeats,
    budgetAvailable: payloadField(envelope.payload, "budget_available"),
  });
  if (exhaustion) return exhaustion;
  if (!writerOnly) ledger.repairs.set(loopId, repairs + 1);
  ledger.iterations.set(loopId, iteration + 1);
  return "repeat";
}

/** True for node kinds that call a provider. */
export function isProviderKind(kind: string): boolean {
  return kind === "agent" || kind === "map";
}

/**
 * Reports which run-level budget, if any, forbids more work. The wall clock is exceeded once more
 * than `max_wall_clock_seconds` have elapsed; provider attempts stop further provider launches
 * once `max_provider_attempts` have started.
 */
export function runBudgetStop(
  budgets: object | undefined,
  usage: { elapsedMs: number; providerAttempts: number; wantsProvider: boolean },
): RunBudgetStop | null {
  const limits = (budgets ?? {}) as {
    max_wall_clock_seconds?: number;
    max_provider_attempts?: number;
  };
  const wallClock = limits.max_wall_clock_seconds;
  if (wallClock !== undefined && usage.elapsedMs > wallClock * 1000) return "wall-clock-exhausted";
  const attempts = limits.max_provider_attempts;
  if (attempts !== undefined && usage.wantsProvider && usage.providerAttempts >= attempts) {
    return "provider-attempts-exhausted";
  }
  return null;
}
