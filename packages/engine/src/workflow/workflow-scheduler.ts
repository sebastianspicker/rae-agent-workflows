/** Deterministically schedules graph workflow nodes with reader and writer isolation. */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, validateWorkflow, workflowDigest } from "./workflow-contract.js";
import { assembleBoundedWorkflowContext } from "./workflow-context-bounded.js";
import { scheduleWorkflowV21 } from "./workflow-scheduler-v21.js";
import { scheduleWorkflowV22 } from "./workflow-scheduler-v22.js";
import {
  abortOnStop,
  conditionMatches as edgeConditionMatches,
  decideBoundedRepeat,
  drainSettled,
  gateProgress,
  isProviderKind,
  noProgressMessage,
  MAX_LOOP_ITERATION,
  persistEnvelope,
  runBudgetStop,
} from "./workflow-scheduler-common.js";
import type { LoopLedger, LoopState, RunBudgetStop } from "./workflow-scheduler-common.js";
import type {
  JsonValue,
  WorkflowsNodeEnvelopeV2,
  WorkflowsNodeEnvelopeV21,
  WorkflowsNodeEnvelopeV22,
  WorkflowsWorkflowV2,
  WorkflowsWorkflowV2DefsEdge,
  WorkflowsWorkflowV2DefsNode,
} from "@rae/contracts";
import type { WorkflowContract } from "./workflow-contract.js";

type WorkflowV2Node = WorkflowsWorkflowV2DefsNode;
type WorkflowV2Edge = WorkflowsWorkflowV2DefsEdge;
interface WorkflowInput {
  edge: WorkflowV2Edge;
  envelope: WorkflowsNodeEnvelopeV2;
}

interface SchedulerExecutionResult extends Record<string, unknown> {
  payload?: JsonValue;
  status?: WorkflowsNodeEnvelopeV2["status"];
  findings?: Array<Record<string, unknown>>;
  evidence_refs?: string[];
  ownership?: Record<string, unknown>;
  changed_paths?: string[];
  command_evidence?: Array<Record<string, unknown>>;
  resource_usage?: Record<string, unknown>;
}

interface SchedulerInvocation {
  node: WorkflowV2Node;
  inputs: WorkflowInput[];
  attempt: number;
  loop_iteration: number;
  sessionId: string;
  workflowDigest: string;
  context: unknown;
  execution: Record<string, unknown>;
  /** Aborted when the run is stopped or fails, so providers can terminate their processes. */
  signal: AbortSignal;
}

interface SettledNode {
  node: WorkflowV2Node;
  envelope?: Readonly<WorkflowsNodeEnvelopeV2>;
  error?: unknown;
}

type TierResolver = (tier?: string, nodeId?: string) => Record<string, unknown>;

type VersionedScheduler = (options: Record<string, unknown>) => Promise<unknown>;
type BoundedContextAssembler = (options: Record<string, unknown>) => {
  evidence: Record<string, unknown>;
};

function payloadField(payload: JsonValue, key: string): JsonValue | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

export interface ScheduleWorkflowOptions {
  workflow: WorkflowContract;
  runId: string;
  execute: (invocation: SchedulerInvocation) => Promise<SchedulerExecutionResult>;
  runDir?: string | null;
  maxConcurrency?: number;
  maxRepairRounds?: number;
  stopRequested?: () => boolean;
  through?: string | null;
  resumeEnvelopes?: Array<
    WorkflowsNodeEnvelopeV2 | WorkflowsNodeEnvelopeV21 | WorkflowsNodeEnvelopeV22
  >;
  onEvent?: (event: Record<string, unknown>) => void;
  resolveTier?: unknown;
  task?: string;
  verifiedGraphRecords?: unknown;
  admittedMemory?: unknown;
  contextPolicy?: unknown;
  contextMode?: string;
  /** Wall clock in milliseconds; injectable so tests can exhaust `max_wall_clock_seconds`. */
  now?: () => number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function freezeEnvelope(
  value: Partial<WorkflowsNodeEnvelopeV2>,
): Readonly<WorkflowsNodeEnvelopeV2> {
  return Object.freeze({
    schema_version: "2.0.0",
    findings: [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
    ...value,
  } as WorkflowsNodeEnvelopeV2);
}

function conditionMatches(edge: WorkflowV2Edge, envelope: WorkflowsNodeEnvelopeV2): boolean {
  return edgeConditionMatches("2.0.0", edge, envelope);
}

function predecessors(workflow: WorkflowsWorkflowV2, nodeId: string): WorkflowV2Edge[] {
  return workflow.edges.filter((edge) => edge.to === nodeId && edge.type !== "loop-back");
}

function inputsFor(
  workflow: WorkflowsWorkflowV2,
  nodeId: string,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
): WorkflowInput[] {
  return predecessors(workflow, nodeId)
    .filter((edge) => {
      const envelope = completed.get(edge.from);
      return envelope ? conditionMatches(edge, envelope) : false;
    })
    .sort((left, right) => left.from.localeCompare(right.from))
    .map((edge) => ({ edge, envelope: completed.get(edge.from) as WorkflowsNodeEnvelopeV2 }));
}

function shouldDisableNode(
  workflow: WorkflowsWorkflowV2,
  node: WorkflowV2Node,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
  running: Map<string, Promise<SettledNode>>,
  disabled: Set<string>,
): boolean {
  if (completed.has(node.id) || running.has(node.id) || disabled.has(node.id)) return false;
  const incoming = predecessors(workflow, node.id);
  if (incoming.length === 0) return false;
  if (!incoming.every((edge) => completed.has(edge.from) || disabled.has(edge.from))) return false;
  return !incoming.some((edge) => {
    const envelope = completed.get(edge.from);
    return envelope ? conditionMatches(edge, envelope) : false;
  });
}

function disabledNodes(
  workflow: WorkflowsWorkflowV2,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
  running: Map<string, Promise<SettledNode>>,
): Set<string> {
  const disabled = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of workflow.nodes) {
      if (!shouldDisableNode(workflow, node, completed, running, disabled)) continue;
      disabled.add(node.id);
      changed = true;
    }
  }
  return disabled;
}

function nodeReady(
  workflow: WorkflowsWorkflowV2,
  node: WorkflowV2Node,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
  running: Map<string, Promise<SettledNode>>,
  disabled: Set<string>,
): boolean {
  if (completed.has(node.id) || running.has(node.id)) return false;
  const incoming = predecessors(workflow, node.id);
  if (node.id === workflow.entry_node) return true;
  if (incoming.some((edge) => !completed.has(edge.from) && !disabled.has(edge.from))) return false;
  const active = incoming.filter((edge) => {
    const envelope = completed.get(edge.from);
    return envelope ? conditionMatches(edge, envelope) : false;
  });
  const enabledIncoming = incoming.filter((edge) => !disabled.has(edge.from));
  return (
    active.length > 0 &&
    (node.kind !== "join" || node.join !== "all" || active.length === enabledIncoming.length)
  );
}

/** The loop that lists the node as a member; gates restart it whether or not they verify. */
function loopForMember(workflow: WorkflowsWorkflowV2, nodeId: string): WorkflowV2Node | undefined {
  return workflow.nodes.find(
    (node) => node.kind === "loop" && node.loop?.members?.includes(nodeId),
  );
}

function resultValue<T>(result: SchedulerExecutionResult, key: string, fallback: T): T {
  return (result[key] as T | undefined) ?? fallback;
}

/** Gate payloads carry whether the run budget still affords another attempt. */
function withBudget(node: WorkflowV2Node, payload: JsonValue, budgetAvailable: boolean): JsonValue {
  if (node.kind !== "gate" || payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload) || "budget_available" in payload) return payload;
  return { ...payload, budget_available: budgetAvailable };
}

function completedEnvelope({
  result,
  runId,
  workflowHash,
  node,
  attempt,
  loopIteration,
  inputDigest,
  budgetAvailable,
}: {
  result: SchedulerExecutionResult;
  runId: string;
  workflowHash: string;
  node: WorkflowV2Node;
  attempt: number;
  loopIteration: number;
  inputDigest: string;
  budgetAvailable: boolean;
}): Readonly<WorkflowsNodeEnvelopeV2> {
  const payload = withBudget(
    node,
    resultValue<JsonValue>(result, "payload", result as unknown as JsonValue),
    budgetAvailable,
  );
  const payloadFindings = payloadField(payload, "findings");
  return freezeEnvelope({
    run_id: runId,
    workflow_digest: workflowHash,
    node_id: node.id,
    attempt,
    loop_iteration: loopIteration,
    status: resultValue(result, "status", "passed"),
    payload,
    findings: resultValue(
      result,
      "findings",
      (Array.isArray(payloadFindings) ? payloadFindings : []) as Array<Record<string, unknown>>,
    ),
    evidence_refs: resultValue(result, "evidence_refs", []),
    ownership: resultValue(result, "ownership", {}),
    changed_paths: resultValue(result, "changed_paths", []),
    command_evidence: resultValue(result, "command_evidence", []),
    resource_usage: resultValue(result, "resource_usage", {}),
    input_digest: inputDigest,
    output_digest: digest(payload),
  });
}

/**
 * Executes ready nodes. Every invocation receives a fresh session id. The
 * callback owns provider mechanics; the scheduler owns ordering and envelopes.
 */
export async function scheduleWorkflow({
  workflow: suppliedWorkflow,
  runId,
  execute,
  runDir = null,
  maxConcurrency,
  maxRepairRounds,
  stopRequested = () => false,
  through = null,
  resumeEnvelopes = [],
  onEvent = () => {},
  resolveTier,
  task,
  verifiedGraphRecords,
  admittedMemory,
  contextPolicy,
  contextMode = "legacy",
  now = Date.now,
}: ScheduleWorkflowOptions): Promise<unknown> {
  if (suppliedWorkflow?.schema_version === "2.2.0") {
    return (scheduleWorkflowV22 as unknown as VersionedScheduler)({
      workflow: suppliedWorkflow,
      runId,
      execute,
      runDir,
      maxConcurrency,
      stopRequested,
      through,
      resumeEnvelopes,
      onEvent,
      resolveTier,
      task,
      verifiedGraphRecords,
      admittedMemory,
      contextPolicy,
    });
  }
  if (suppliedWorkflow?.schema_version === "2.1.0") {
    return (scheduleWorkflowV21 as unknown as VersionedScheduler)({
      workflow: suppliedWorkflow,
      runId,
      execute,
      runDir,
      maxConcurrency,
      stopRequested,
      through,
      resumeEnvelopes,
      onEvent,
      resolveTier,
      task,
      contextMode,
      maxRepairRounds,
      now,
    });
  }
  // Stored snapshots validate structurally so newer authoring rules cannot strand a resumed run.
  const workflow = validateWorkflow(suppliedWorkflow, { mode: "snapshot" }) as WorkflowsWorkflowV2;
  const workflowHash = workflowDigest(workflow);
  const concurrency = Math.min(maxConcurrency ?? workflow.budgets?.max_concurrency ?? 4, 4);
  const repairLimit = Math.min(maxRepairRounds ?? workflow.budgets?.max_repair_rounds ?? 5, 5);
  const attemptsLimit = Math.min(workflow.budgets?.max_attempts_per_node ?? 3, 3);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("max concurrency must be from 1 to 4");
  if (!Number.isInteger(repairLimit) || repairLimit < 0)
    throw new Error("max repair rounds must be from 0 to 5");

  const nodes = new Map<string, WorkflowV2Node>(workflow.nodes.map((node) => [node.id, node]));
  const v2ResumeEnvelopes = resumeEnvelopes as WorkflowsNodeEnvelopeV2[];
  const completed = new Map<string, Readonly<WorkflowsNodeEnvelopeV2>>(
    v2ResumeEnvelopes.map((envelope) => [envelope.node_id, Object.freeze(envelope)]),
  );
  const tierResolver: TierResolver =
    (resolveTier as TierResolver | undefined) ?? ((tier) => ({ tier: tier ?? "standard" }));
  const running = new Map<string, Promise<SettledNode>>();
  const attempts = new Map<string, number>();
  const busyResources = new Set<string>();
  const loopIterations = new Map<string, number>();
  const loopRepairs = new Map<string, number>();
  const loopProgress = new Map<string, string[]>();
  const loopIterationLimits = new Map<string, number>();
  let attemptsUsed = v2ResumeEnvelopes.reduce((total, envelope) => total + envelope.attempt, 0);
  // Provider attempts carry across resumes, like the per-node attempt total above.
  let providerAttempts = v2ResumeEnvelopes
    .filter((envelope) => isProviderKind(nodes.get(envelope.node_id)?.kind ?? ""))
    .reduce((total, envelope) => total + envelope.attempt, 0);
  const startedAt = now();
  let budgetStop: RunBudgetStop | null = null;
  const budgetFor = (wantsProvider: boolean): RunBudgetStop | null =>
    runBudgetStop(workflow.budgets, {
      elapsedMs: now() - startedAt,
      providerAttempts,
      wantsProvider,
    });
  for (const loop of workflow.nodes.filter(({ kind }) => kind === "loop")) {
    // N repair rounds need N + 1 iterations, so the repair limit also caps the iterations.
    loopIterationLimits.set(
      loop.id,
      Math.min(
        loop.loop?.max_iterations ?? MAX_LOOP_ITERATION,
        MAX_LOOP_ITERATION,
        repairLimit + 1,
      ),
    );
    const members = v2ResumeEnvelopes.filter(
      (envelope) => loop.loop?.members.includes(envelope.node_id) === true,
    );
    const latestIteration = Math.max(1, ...members.map((envelope) => envelope.loop_iteration ?? 1));
    loopIterations.set(loop.id, latestIteration);
    // Members persisted by earlier iterations are stale; resume inside the newest iteration.
    for (const envelope of members) {
      if ((envelope.loop_iteration ?? 1) < latestIteration) completed.delete(envelope.node_id);
    }
    // Restore repair accounting and no-progress history from failed gates of earlier iterations.
    const failedGates = new Map<number, WorkflowsNodeEnvelopeV2>();
    for (const envelope of members) {
      const iteration = envelope.loop_iteration ?? 1;
      if (
        nodes.get(envelope.node_id)?.kind !== "gate" ||
        envelope.status === "passed" ||
        iteration >= latestIteration
      )
        continue;
      const known = failedGates.get(iteration);
      if (!known || known.attempt <= envelope.attempt) failedGates.set(iteration, envelope);
    }
    const counted = [...failedGates.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, envelope]) => gateProgress(envelope))
      .filter(({ writerOnly }) => !writerOnly);
    loopRepairs.set(loop.id, counted.length);
    loopProgress.set(
      loop.id,
      counted.map(({ key }) => key),
    );
  }
  // The run budget: every node may use its per-node attempt allowance in each iteration its loop
  // can run, so only retries beyond the plan exhaust it.
  const nodeRuns = new Map<string, number>();
  for (const loop of workflow.nodes.filter(({ kind }) => kind === "loop")) {
    for (const member of loop.loop?.members ?? []) {
      nodeRuns.set(member, loopIterationLimits.get(loop.id) ?? 1);
    }
  }
  const attemptBudget =
    attemptsLimit * workflow.nodes.reduce((total, { id }) => total + (nodeRuns.get(id) ?? 1), 0);
  let sequence = 0;
  const abort = new AbortController();

  const emit = (event: string, metadata: Record<string, unknown> = {}): void =>
    onEvent({ seq: ++sequence, event, ...metadata });

  async function invoke(node: WorkflowV2Node): Promise<Readonly<WorkflowsNodeEnvelopeV2>> {
    const attempt = (attempts.get(node.id) ?? 0) + 1;
    attempts.set(node.id, attempt);
    attemptsUsed++;
    if (isProviderKind(node.kind)) providerAttempts++;
    const inputs = inputsFor(workflow, node.id, completed);
    const inputDigest = digest(inputs.map(({ envelope }) => envelope.output_digest));
    const sessionId = randomUUID();
    const loop = loopForMember(workflow, node.id);
    const loopIteration = loop ? (loopIterations.get(loop.id) ?? 1) : 1;
    const execution = tierResolver("standard", node.id);
    const context =
      contextMode === "bounded" && ["agent", "map"].includes(node.kind)
        ? (assembleBoundedWorkflowContext as unknown as BoundedContextAssembler)({
            task,
            node,
            inputs,
            runDir,
          })
        : null;
    if (context) emit("context_assembled", { node_id: node.id, ...context.evidence });
    emit("node_started", { node_id: node.id, attempt, session_id: sessionId });
    try {
      const result = await execute({
        node,
        inputs,
        attempt,
        loop_iteration: loopIteration,
        sessionId,
        workflowDigest: workflowHash,
        context,
        execution,
        signal: abort.signal,
      });
      const envelope = completedEnvelope({
        result,
        runId,
        workflowHash,
        node,
        attempt,
        loopIteration,
        inputDigest,
        budgetAvailable: attemptsUsed < attemptBudget,
      });
      persistEnvelope(runDir, envelope);
      emit("node_completed", { node_id: node.id, attempt, status: envelope.status });
      return envelope;
    } catch (error) {
      const flagged = error as { workflowWaiting?: unknown; workflowTerminal?: unknown } | null;
      if (flagged?.workflowWaiting === true || flagged?.workflowTerminal === true) throw error;
      emit("node_attempt_failed", {
        node_id: node.id,
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      const stop = budgetFor(isProviderKind(node.kind));
      if (stop && attempt < attemptsLimit) budgetStop ??= stop;
      if (attempt < attemptsLimit && !abort.signal.aborted && !stopRequested() && !stop) {
        return invoke(node);
      }
      throw error;
    }
  }

  function launch(node: WorkflowV2Node): void {
    if (node.resource) busyResources.add(node.resource);
    // Never rejects: failures settle to a record so no node is abandoned or left unhandled.
    const promise: Promise<SettledNode> = invoke(node)
      .then(
        (envelope): SettledNode => ({ node, envelope }),
        (error: unknown): SettledNode => ({ node, error }),
      )
      .finally(() => {
        if (node.resource) busyResources.delete(node.resource);
      });
    running.set(node.id, promise);
  }

  /** Awaits every in-flight node so none keeps running after the scheduler returns or throws. */
  async function drainRunning(): Promise<void> {
    const remaining = [...running.entries()];
    const results = await drainSettled(remaining.map(([, promise]) => promise));
    for (const [id] of remaining) running.delete(id);
    for (const { node, envelope } of results) if (envelope) completed.set(node.id, envelope);
  }

  function readyNodes(): WorkflowV2Node[] {
    const disabled = disabledNodes(workflow, completed, running);
    return workflow.nodes
      .filter((node) => nodeReady(workflow, node, completed, running, disabled))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  const ledger: LoopLedger = {
    iterations: loopIterations,
    repairs: loopRepairs,
    progress: loopProgress,
    limits: loopIterationLimits,
  };

  function maybeRepeatLoop(node: WorkflowV2Node, envelope: WorkflowsNodeEnvelopeV2): LoopState {
    if (node.kind !== "gate" || envelope.status === "passed") return "none";
    const loop = loopForMember(workflow, node.id);
    if (!loop) return "none";
    const state = decideBoundedRepeat(ledger, loop.id, envelope, repairLimit);
    if (state !== "repeat") return state;
    const iteration = loopIterations.get(loop.id) ?? 1;
    for (const member of loop.loop?.members ?? []) {
      completed.delete(member);
      attempts.delete(member);
    }
    emit("loop_restarted", { loop_id: loop.id, iteration });
    return "repeat";
  }

  function noProgress(): Error {
    return new Error(
      noProgressMessage(
        [...completed]
          .filter(([, envelope]) => envelope.status !== "passed")
          .map(([id, envelope]) => ({
            id,
            kind: nodes.get(id)?.kind ?? "node",
            status: envelope.status,
            message: (envelope as { failure?: { message?: unknown } }).failure?.message,
          })),
        completed.keys(),
      ),
    );
  }

  for (const [nodeId, envelope] of [...completed]) {
    const node = nodes.get(nodeId);
    if (node?.kind !== "gate" || envelope.status === "passed") continue;
    // Replay a persisted gate failure only when it is the newest event of its loop; otherwise
    // the crash happened mid-iteration and the run resumes inside the current iteration.
    const gateLoop = loopForMember(workflow, node.id);
    if (gateLoop && (envelope.loop_iteration ?? 1) !== loopIterations.get(gateLoop.id)) continue;
    const resumedLoopState = maybeRepeatLoop(node, envelope);
    if (!["none", "repeat"].includes(resumedLoopState)) {
      await drainRunning();
      return {
        status: "repair-exhausted",
        reason: resumedLoopState,
        completed,
        workflow_digest: workflowHash,
        loop_rounds: loopRepairs,
      };
    }
  }

  /** Stops scheduling, drains running nodes, and reports the spent run-level budget. */
  async function finishBudget(reason: RunBudgetStop): Promise<unknown> {
    await drainRunning();
    emit("budget_exhausted", { reason });
    return {
      status: "repair-exhausted",
      reason,
      completed,
      workflow_digest: workflowHash,
      loop_rounds: loopRepairs,
    };
  }

  /** Launches the node unless a run-level budget forbids it; returns whether it started. */
  function launchWithinBudget(node: WorkflowV2Node): boolean {
    budgetStop ??= budgetFor(isProviderKind(node.kind));
    if (budgetStop) return false;
    launch(node);
    return true;
  }

  async function mainLoop(): Promise<unknown> {
    while (!completed.has(workflow.terminal_node)) {
      if (stopRequested()) {
        abort.abort(new Error("workflow stop requested"));
        await drainRunning();
        emit("workflow_stopped");
        return {
          status: "stopped",
          completed,
          workflow_digest: workflowHash,
          loop_rounds: loopRepairs,
        };
      }
      budgetStop ??= budgetFor(false);
      if (budgetStop) return finishBudget(budgetStop);
      const ready = readyNodes();
      const writer = ready.find(({ access }) => access === "write");
      if (writer && running.size === 0) {
        launchWithinBudget(writer);
      } else if (!writer && ![...running.keys()].some((id) => nodes.get(id)?.access === "write")) {
        for (const node of ready) {
          if (running.size >= concurrency) break;
          if (node.access === "write") continue;
          if (node.resource && busyResources.has(node.resource)) continue;
          if (!launchWithinBudget(node)) break;
        }
      }
      if (budgetStop) return finishBudget(budgetStop);
      if (running.size === 0) throw noProgress();
      const settled = await Promise.race(running.values());
      running.delete(settled.node.id);
      // A stop aborts running providers; their failures are not workflow failures.
      if (!settled.envelope && abort.signal.aborted && stopRequested()) continue;
      if (!settled.envelope) {
        if (budgetStop) return finishBudget(budgetStop);
        throw settled.error;
      }
      completed.set(settled.node.id, settled.envelope);
      if (through === settled.node.id) {
        await drainRunning();
        emit("workflow_through_reached", { node_id: through });
        return {
          status: "through",
          completed,
          workflow_digest: workflowHash,
          loop_rounds: loopRepairs,
        };
      }
      const loopState = maybeRepeatLoop(settled.node, settled.envelope);
      if (!["none", "repeat"].includes(loopState)) {
        emit("loop_exhausted", { node_id: settled.node.id, reason: loopState });
        await drainRunning();
        return {
          status: "repair-exhausted",
          reason: loopState,
          completed,
          workflow_digest: workflowHash,
          loop_rounds: loopRepairs,
        };
      }
    }
    await drainRunning();
    emit("workflow_completed", { node_id: workflow.terminal_node });
    return {
      status: "completed",
      completed,
      workflow_digest: workflowHash,
      loop_rounds: loopRepairs,
    };
  }

  const stopWatch = abortOnStop(stopRequested, abort);
  try {
    return await mainLoop();
  } catch (error) {
    // Any failure aborts and awaits in-flight providers before it surfaces; a checkpoint wait
    // lets running readers finish.
    if ((error as { workflowWaiting?: unknown } | null)?.workflowWaiting !== true) {
      abort.abort(error);
    }
    await drainRunning();
    throw error;
  } finally {
    stopWatch();
  }
}
