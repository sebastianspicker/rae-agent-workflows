/** Schedules immutable v2.1 node instances with bounded fan-out, joins, and stream pipelines. */
import { randomUUID } from "node:crypto";
import { validateWorkflow, workflowDigest } from "./workflow-contract.js";
import { deduplicateDiscovery, pointerValue } from "./workflow-transforms.js";
import { assembleBoundedWorkflowContext } from "./workflow-context-bounded.js";
import {
  anyJoinDecision,
  conditionMatches,
  digest,
  failureEnvelope,
  freezeEnvelope,
  instanceId,
  pendingInstanceId,
  predecessors,
  successful,
  valueOr,
} from "./workflow-scheduler-v21-support.js";
import {
  abortOnStop,
  decideBoundedRepeat,
  drainSettled,
  checkpointResumable,
  gateProgress,
  isProviderKind,
  MAX_LOOP_ITERATION,
  noProgressMessage,
  persistEnvelope,
  runBudgetStop,
} from "./workflow-scheduler-common.js";
import type { LoopLedger, LoopState, RunBudgetStop } from "./workflow-scheduler-common.js";
import type {
  JsonValue,
  WorkflowsNodeEnvelopeV21,
  WorkflowsWorkflowV21,
  WorkflowsWorkflowV21DefsEdge,
  WorkflowsWorkflowV21DefsNode,
} from "@rae/contracts";

type WorkflowNode = WorkflowsWorkflowV21DefsNode;
type WorkflowEdge = WorkflowsWorkflowV21DefsEdge;
interface WorkflowInput {
  edge: WorkflowEdge;
  envelope: WorkflowsNodeEnvelopeV21;
}
interface PendingSpec {
  node: WorkflowNode;
  instance_id: string;
  item: unknown;
  item_key: string | null;
  item_digest: string | null;
  parent_node: string | null;
  inputs: WorkflowInput[] | null;
  loop_iteration: number;
}
interface RunningSpec {
  spec: PendingSpec;
  promise: Promise<SettledSpec>;
}
interface SettledSpec {
  spec: PendingSpec;
  envelope?: Readonly<WorkflowsNodeEnvelopeV21>;
  error?: unknown;
}
interface ExecutionResult extends Record<string, unknown> {
  payload?: JsonValue;
  status?: WorkflowsNodeEnvelopeV21["status"];
  findings?: Array<Record<string, unknown>>;
  evidence_refs?: string[];
  ownership?: Record<string, unknown>;
  changed_paths?: string[];
  command_evidence?: Array<Record<string, unknown>>;
  resource_usage?: Record<string, unknown>;
  selection?: Record<string, unknown> | null;
  quorum?: Record<string, unknown> | null;
  convergence?: Record<string, unknown> | null;
}
interface ExecutionTier extends Record<string, unknown> {
  tier?: WorkflowsNodeEnvelopeV21["execution_tier"];
}
interface ScheduleV21Options {
  workflow: WorkflowsWorkflowV21;
  runId: string;
  execute: (context: Record<string, unknown>) => Promise<ExecutionResult>;
  runDir?: string | null;
  maxConcurrency?: number;
  maxRepairRounds?: number;
  stopRequested?: () => boolean;
  through?: string | null;
  resumeEnvelopes?: WorkflowsNodeEnvelopeV21[];
  onEvent?: (event: Record<string, unknown>) => void;
  resolveTier?: (tier?: string, nodeId?: string) => ExecutionTier;
  task?: string;
  contextMode?: string;
  /** Wall clock in milliseconds; injectable so tests can exhaust `max_wall_clock_seconds`. */
  now?: () => number;
}
interface ExhaustedResult {
  status: "repair-exhausted";
  reason: Exclude<LoopState, "none" | "repeat"> | RunBudgetStop;
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV21>>;
  workflow_digest: string;
  loop_rounds: Map<string, number>;
}
type BoundedContextAssembler = (options: Record<string, unknown>) => {
  evidence: Record<string, unknown>;
};

function payloadField(payload: JsonValue, key: string): JsonValue | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

function isWorkflowWaiting(error: unknown): boolean {
  return (error as { workflowWaiting?: unknown } | null)?.workflowWaiting === true;
}

function failureMessage(envelope: WorkflowsNodeEnvelopeV21): string | undefined {
  const message = envelope.failure?.message;
  return typeof message === "string" ? message : undefined;
}

/** Executes a validated v2.1 workflow without mutating its logical topology. */
export async function scheduleWorkflowV21({
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
  resolveTier = (tier) => ({
    tier: (tier ?? "standard") as WorkflowsNodeEnvelopeV21["execution_tier"],
  }),
  task = "",
  contextMode = "legacy",
  now = Date.now,
}: ScheduleV21Options): Promise<
  | {
      status: "stopped" | "through" | "completed";
      completed: Map<string, Readonly<WorkflowsNodeEnvelopeV21>>;
      workflow_digest: string;
    }
  | ExhaustedResult
> {
  // Stored snapshots validate structurally so newer authoring rules cannot strand a resumed run.
  const workflow = validateWorkflow(suppliedWorkflow, { mode: "snapshot" }) as WorkflowsWorkflowV21;
  if (workflow.schema_version !== "2.1.0") throw new Error("v2.1 scheduler requires schema 2.1.0");
  const workflowHash = workflowDigest(workflow);
  const concurrency = Math.min(maxConcurrency ?? workflow.budgets?.max_concurrency ?? 4, 4);
  const attemptsLimit = Math.min(workflow.budgets?.max_attempts_per_node ?? 3, 3);
  const dynamicLimit = Math.min(workflow.budgets?.max_dynamic_instances ?? 128, 128);
  const mapLimit = Math.min(workflow.budgets?.max_map_items ?? 32, 32);
  const repairLimit = Math.min(maxRepairRounds ?? workflow.budgets?.max_repair_rounds ?? 5, 5);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("max concurrency must be from 1 to 4");
  if (!Number.isInteger(repairLimit) || repairLimit < 0)
    throw new Error("max repair rounds must be from 0 to 5");

  const nodes = new Map<string, WorkflowNode>(workflow.nodes.map((node) => [node.id, node]));
  const completed = new Map<string, Readonly<WorkflowsNodeEnvelopeV21>>();
  const byNode = new Map<string, Set<string>>(
    workflow.nodes.map((node) => [node.id, new Set<string>()]),
  );
  const pending = new Map<string, PendingSpec>();
  const running = new Map<string, RunningSpec>();
  const expanded = new Set<string>();
  const busyResources = new Set<string>();
  const attempts = new Map<string, number>();
  const memberLoop = new Map<string, WorkflowNode>();
  const loopIterations = new Map<string, number>();
  const loopSeen = new Map<string, string[]>();
  const loopRepairs = new Map<string, number>();
  const loopProgress = new Map<string, string[]>();
  const loopLimits = new Map<string, number>();
  const ledger: LoopLedger = {
    iterations: loopIterations,
    repairs: loopRepairs,
    progress: loopProgress,
    limits: loopLimits,
  };
  for (const loop of workflow.nodes.filter((node) => node.kind === "loop")) {
    loopIterations.set(loop.id, 1);
    loopSeen.set(loop.id, []);
    // N repair rounds need N + 1 iterations, so the repair limit also caps the iterations.
    loopLimits.set(
      loop.id,
      Math.min(
        loop.loop?.max_iterations ?? MAX_LOOP_ITERATION,
        MAX_LOOP_ITERATION,
        repairLimit + 1,
      ),
    );
    for (const member of loop.loop?.members ?? []) memberLoop.set(member, loop);
  }
  let providerAttempts = 0;
  // Provider attempts bound the run and carry across resumes.
  let budgetAttempts = 0;
  const startedAt = now();
  let budgetStop: RunBudgetStop | null = null;
  let loopStop: Exclude<LoopState, "none" | "repeat"> | null = null;
  const budgetFor = (wantsProvider: boolean): RunBudgetStop | null =>
    runBudgetStop(workflow.budgets, {
      elapsedMs: now() - startedAt,
      providerAttempts: budgetAttempts,
      wantsProvider,
    });
  let sequence = 0;
  let fatal: Error | null = null;
  const abort = new AbortController();
  const emit = (event: string, metadata: Record<string, unknown> = {}): void =>
    onEvent({ seq: ++sequence, event, ...metadata });

  function addCompleted(envelope: WorkflowsNodeEnvelopeV21): void {
    if (envelope.workflow_digest !== workflowHash)
      throw new Error("resume envelope workflow digest mismatch");
    completed.set(envelope.instance_id ?? envelope.node_id, Object.freeze(envelope));
    byNode.get(envelope.node_id)?.add(envelope.instance_id ?? envelope.node_id);
  }
  for (const envelope of resumeEnvelopes) {
    const id = envelope.instance_id ?? envelope.node_id;
    const checkpoint = nodes.get(envelope.node_id)?.kind === "checkpoint";
    if (envelope.status === "failed" && checkpoint) {
      const resumable = checkpointResumable(envelope);
      if (resumable === true) {
        attempts.set(id, envelope.attempt);
        continue;
      }
      addCompleted(envelope);
      fatal = new Error(`checkpoint instance ${id} cannot be re-evaluated: ${resumable}`);
      continue;
    }
    if (envelope.status === "failed" && envelope.attempt < attemptsLimit) {
      attempts.set(id, envelope.attempt);
      continue;
    }
    addCompleted(envelope);
    if (envelope.status === "failed") {
      fatal = new Error(
        `workflow node instance ${id} exhausted retries: ${failureMessage(envelope) ?? "failed"}`,
      );
    }
  }
  for (const node of workflow.nodes) {
    const instances = [...(byNode.get(node.id) ?? [])];
    if (node.kind !== "map" && instances.length) expanded.add(node.id);
  }
  budgetAttempts = resumeEnvelopes
    .filter((envelope) => isProviderKind(nodes.get(envelope.node_id)?.kind ?? ""))
    .reduce((total, envelope) => total + envelope.attempt, 0);
  restoreBoundedLoops();

  /** Resumes a bounded loop inside its newest iteration with its repair accounting intact. */
  function restoreBoundedLoops(): void {
    for (const loop of workflow.nodes.filter(
      (node) => node.kind === "loop" && node.loop?.mode !== "until-dry",
    )) {
      const members = new Set(loop.loop?.members ?? []);
      const stored = resumeEnvelopes.filter((envelope) => members.has(envelope.node_id));
      const latest = Math.max(1, ...stored.map((envelope) => envelope.loop_iteration ?? 1));
      if (latest === 1) continue;
      loopIterations.set(loop.id, latest);
      for (const member of members) {
        const current = stored.some(
          (envelope) => envelope.node_id === member && (envelope.loop_iteration ?? 1) === latest,
        );
        if (!current) expanded.delete(member);
      }
      const failedGates = new Map<number, WorkflowsNodeEnvelopeV21>();
      for (const envelope of stored) {
        const iteration = envelope.loop_iteration ?? 1;
        if (
          nodes.get(envelope.node_id)?.kind !== "gate" ||
          envelope.status === "passed" ||
          iteration >= latest
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
  }

  const nodeEnvelopes = (nodeId: string): WorkflowsNodeEnvelopeV21[] =>
    [...(byNode.get(nodeId) ?? [])]
      .map((id) => completed.get(id))
      .filter((envelope): envelope is Readonly<WorkflowsNodeEnvelopeV21> => Boolean(envelope));
  const nodeRunning = (nodeId: string): boolean =>
    [...running.values()].some((entry) => entry.spec.node.id === nodeId);
  const nodePending = (nodeId: string): boolean =>
    [...pending.values()].some((spec) => spec.node.id === nodeId);
  const isSettled = (nodeId: string): boolean =>
    expanded.has(nodeId) && !nodeRunning(nodeId) && !nodePending(nodeId);

  function baseInputs(nodeId: string): WorkflowInput[] {
    const loop = memberLoop.get(nodeId);
    const iteration = loop ? loopIterations.get(loop.id) : null;
    return predecessors(workflow, nodeId)
      .filter((edge) => edge.type !== "stream")
      .flatMap((edge) =>
        nodeEnvelopes(edge.from)
          .filter(
            (envelope) =>
              conditionMatches(edge, envelope) &&
              (!loop || !memberLoop.has(edge.from) || envelope.loop_iteration === iteration),
          )
          .map((envelope) => ({ edge, envelope })),
      )
      .sort((left, right) => left.envelope.instance_id.localeCompare(right.envelope.instance_id));
  }

  function predecessorsSettled(
    nodeId: string,
    { excludeStream = true }: { excludeStream?: boolean } = {},
  ): boolean {
    const edges = predecessors(workflow, nodeId).filter(
      (edge) => !excludeStream || edge.type !== "stream",
    );
    return edges.every((edge) => isSettled(edge.from));
  }

  function queue(
    node: WorkflowNode,
    {
      item = null,
      itemKey = null,
      itemDigest = null,
      parentNode = null,
      inputs = null,
    }: {
      item?: unknown;
      itemKey?: string | null;
      itemDigest?: string | null;
      parentNode?: string | null;
      inputs?: WorkflowInput[] | null;
    } = {},
  ): void {
    const loop = memberLoop.get(node.id);
    const loopIteration = loop ? (loopIterations.get(loop.id) ?? 1) : 1;
    const id = pendingInstanceId(node.id, itemKey, loop, loopIteration);
    if (completed.has(id) || pending.has(id) || running.has(id)) return;
    if (pending.size + running.size + completed.size >= dynamicLimit)
      throw new Error(`workflow exceeds ${dynamicLimit} dynamic instances`);
    pending.set(id, {
      node,
      instance_id: id,
      item,
      item_key: itemKey,
      item_digest: itemDigest,
      parent_node: parentNode,
      inputs,
      loop_iteration: loopIteration,
    });
    byNode.get(node.id)?.add(id);
  }

  function expandStreamMap(node: WorkflowNode, streamEdge: WorkflowEdge): void {
    for (const envelope of nodeEnvelopes(streamEdge.from).filter(successful)) {
      const key = envelope.item_key ?? envelope.instance_id;
      queue(node, {
        item: envelope.payload,
        itemKey: key,
        itemDigest: envelope.item_digest ?? digest(envelope.payload),
        parentNode: streamEdge.from,
        inputs: [{ edge: streamEdge, envelope }],
      });
    }
    if (isSettled(streamEdge.from)) expanded.add(node.id);
  }

  function mapItems(node: WorkflowNode, inputs: WorkflowInput[]): unknown[] {
    const items = pointerValue(inputs[0]?.envelope?.payload, node.map?.source_pointer);
    if (!Array.isArray(items)) {
      throw new Error(`map ${node.id} source pointer must resolve to an array`);
    }
    const limit = Math.min(node.map?.max_items ?? mapLimit, mapLimit, 32);
    if (items.length > limit) throw new Error(`map ${node.id} exceeds its ${limit}-item bound`);
    return items;
  }

  function queueMapItems(node: WorkflowNode, items: unknown[], inputs: WorkflowInput[]): void {
    const identities = new Set<string>();
    for (const item of items) {
      const keyValue = pointerValue(item, node.map?.stable_key_pointer);
      if (!["string", "number", "boolean"].includes(typeof keyValue)) {
        throw new Error(`map ${node.id} stable key must be a scalar`);
      }
      const key = String(keyValue);
      const identity = instanceId(node.id, key);
      if (identities.has(identity)) {
        throw new Error(`map ${node.id} contains duplicate stable key ${key}`);
      }
      identities.add(identity);
      queue(node, {
        item,
        itemKey: key,
        itemDigest: digest(item),
        parentNode: inputs[0]?.envelope?.node_id ?? null,
        inputs,
      });
    }
  }

  function expandMap(node: WorkflowNode): void {
    if (expanded.has(node.id)) return;
    const streamEdge = predecessors(workflow, node.id).find((edge) => edge.type === "stream");
    if (streamEdge) {
      expandStreamMap(node, streamEdge);
      return;
    }
    if (!predecessorsSettled(node.id)) return;
    const inputs = baseInputs(node.id);
    const items = mapItems(node, inputs);
    queueMapItems(node, items, inputs);
    expanded.add(node.id);
    emit("map_expanded", { node_id: node.id, instances: items.length });
  }

  function quorumDecision(
    node: WorkflowNode,
    edges: WorkflowEdge[],
    envelopes: WorkflowInput[],
    passed: WorkflowInput[],
    allSettled: boolean,
  ): Record<string, unknown> {
    const threshold = node.quorum?.threshold ?? 0;
    const groupState = (node.quorum?.groups ?? []).map((group) => {
      const accepted = passed.filter(({ edge }) => group.members.includes(edge.from)).length;
      const remaining = group.members.filter((member) => !isSettled(member)).length;
      return { id: group.id, threshold: group.threshold, accepted, remaining };
    });
    const groupsPassed = groupState.every((group) => group.accepted >= group.threshold);
    const groupImpossible = groupState.some(
      (group) => group.accepted + group.remaining < group.threshold,
    );
    if (passed.length >= threshold && groupsPassed) {
      return {
        ready: true,
        inputs: passed,
        quorum: {
          threshold,
          passed: passed.length,
          possible: envelopes.length,
          groups: groupState,
        },
      };
    }
    const remaining = edges.filter((edge) => !isSettled(edge.from)).length;
    if (passed.length + remaining >= threshold && !groupImpossible && !allSettled) {
      return { ready: false };
    }
    return {
      impossible: true,
      reason: `quorum ${node.id} became impossible`,
      quorum: { threshold, passed: passed.length, remaining, groups: groupState },
    };
  }

  function joinDecision(node: WorkflowNode): Record<string, unknown> {
    const edges = predecessors(workflow, node.id);
    const loop = memberLoop.get(node.id);
    const iteration = loop ? loopIterations.get(loop.id) : null;
    const envelopes = edges.flatMap((edge) =>
      nodeEnvelopes(edge.from)
        .filter(
          (envelope) =>
            !loop || !memberLoop.has(edge.from) || envelope.loop_iteration === iteration,
        )
        .map((envelope) => ({ edge, envelope })),
    );
    const passed = envelopes.filter(({ edge, envelope }) => conditionMatches(edge, envelope));
    const allSettled = edges.every((edge) => isSettled(edge.from));
    if (node.join === "all") return allSettled ? { ready: true, inputs: passed } : { ready: false };
    if (node.join === "any") return anyJoinDecision(passed, allSettled);
    return quorumDecision(node, edges, envelopes, passed, allSettled);
  }

  function discoverJoin(node: WorkflowNode): void {
    const decision = joinDecision(node);
    if (decision.impossible === true) {
      fatal = new Error(String(decision.reason));
      emit("quorum_impossible", { node_id: node.id, quorum: decision.quorum });
      return;
    }
    if (decision.ready !== true) return;
    queue(node, { inputs: decision.inputs as WorkflowInput[] });
    expanded.add(node.id);
  }

  function discoverOrdinary(node: WorkflowNode): void {
    if (!predecessorsSettled(node.id)) return;
    const inputs = baseInputs(node.id);
    if (predecessors(workflow, node.id).length && inputs.length === 0) {
      expanded.add(node.id);
      return;
    }
    queue(node, { inputs });
    expanded.add(node.id);
  }

  function discoverNode(node: WorkflowNode): void {
    if (node.kind === "map") expandMap(node);
    if (node.kind === "map" || expanded.has(node.id)) return;
    if (node.id === workflow.entry_node) {
      queue(node);
      expanded.add(node.id);
      return;
    }
    if (node.kind === "join") {
      discoverJoin(node);
      return;
    }
    discoverOrdinary(node);
  }

  function streamSuccessors(spec: PendingSpec, envelope: WorkflowsNodeEnvelopeV21): void {
    for (const edge of workflow.edges.filter(
      (candidate) => candidate.from === spec.node.id && candidate.type === "stream",
    )) {
      const target = nodes.get(edge.to);
      if (!target) throw new Error(`stream edge references unknown node ${edge.to}`);
      if (!successful(envelope)) continue;
      const key = envelope.item_key ?? envelope.instance_id;
      const itemHash = envelope.item_digest ?? digest(envelope.payload);
      queue(target, {
        item: envelope.payload,
        itemKey: key,
        itemDigest: itemHash,
        parentNode: spec.node.id,
        inputs: [{ edge, envelope }],
      });
      emit("stream_instance_ready", {
        node_id: target.id,
        instance_id: instanceId(target.id, key),
        parent_node: spec.node.id,
      });
    }
  }

  function thresholdToleratesFailure(node: WorkflowNode): boolean {
    if (node.access === "write") return false;
    return workflow.edges
      .filter((edge) => edge.from === node.id && edge.type !== "loop-back")
      .some((edge) => {
        const join = nodes.get(edge.to)?.join;
        return join === "any" || join === "quorum";
      });
  }

  function collectPolicyError(node: WorkflowNode): string | null {
    const policy = node.failure_handling;
    if (policy?.mode !== "collect") return null;
    const envelopes = nodeEnvelopes(node.id);
    const failures = envelopes.filter((envelope) => !successful(envelope)).length;
    const maxFailures = valueOr(policy.max_failures, 0);
    const minimumSuccesses = valueOr(policy.minimum_successes, node.kind === "map" ? 1 : 0);
    if (failures > maxFailures) {
      return `collect node ${node.id} exceeded its failure bound`;
    }
    const hasMinimum = envelopes.filter(successful).length >= minimumSuccesses;
    if (isSettled(node.id) && !hasMinimum) {
      return `collect node ${node.id} did not reach its minimum successes`;
    }
    return null;
  }

  function advanceUntilDry(spec: PendingSpec, envelope: WorkflowsNodeEnvelopeV21): boolean {
    const edge = workflow.edges.find(
      (candidate) => candidate.from === spec.node.id && candidate.type === "loop-back",
    );
    if (!edge) return false;
    const loop = memberLoop.get(spec.node.id);
    if (!loop?.loop || loop.loop.mode !== "until-dry") return false;
    const convergence = deduplicateDiscovery(
      pointerValue(envelope.payload, loop.loop?.source_pointer),
      loop.loop?.stable_key_pointer ?? "",
      loopSeen.get(loop.id) ?? [],
    );
    loopSeen.set(loop.id, convergence.seen_keys);
    emit("loop_convergence", {
      loop_id: loop.id,
      iteration: loopIterations.get(loop.id),
      fresh: convergence.fresh.length,
      rejected: convergence.rejected.length,
      dry: convergence.dry,
      seen: convergence.seen_keys.length,
    });
    if (convergence.dry) return false;
    const iteration = loopIterations.get(loop.id) ?? 1;
    if (iteration >= (loop.loop?.max_iterations ?? 1)) {
      fatal = new Error(`until-dry loop ${loop.id} reached its ${iteration}-round bound`);
      return true;
    }
    loopIterations.set(loop.id, iteration + 1);
    for (const member of loop.loop?.members ?? []) expanded.delete(member);
    const target = nodes.get(edge.to);
    if (!target) throw new Error(`loop-back edge references unknown node ${edge.to}`);
    queue(target, {
      item: convergence.fresh,
      parentNode: spec.node.id,
      inputs: [{ edge, envelope }],
    });
    expanded.add(target.id);
    emit("loop_restarted", { loop_id: loop.id, iteration: iteration + 1 });
    return true;
  }

  /**
   * Restarts a bounded loop when its gate fails, reusing the v2.0 repair accounting. Returns
   * `repeat` after queueing a fresh iteration, or records why the loop is exhausted.
   */
  function advanceBounded(spec: PendingSpec, envelope: WorkflowsNodeEnvelopeV21): LoopState {
    if (spec.node.kind !== "gate" || successful(envelope)) return "none";
    const loop = memberLoop.get(spec.node.id);
    if (!loop?.loop || loop.loop.mode === "until-dry") return "none";
    const state = decideBoundedRepeat(ledger, loop.id, envelope, repairLimit);
    if (state !== "repeat") {
      loopStop = state;
      emit("loop_exhausted", { node_id: spec.node.id, reason: state });
      return state;
    }
    for (const member of loop.loop.members) expanded.delete(member);
    emit("loop_restarted", { loop_id: loop.id, iteration: loopIterations.get(loop.id) });
    return "repeat";
  }

  async function invoke(spec: PendingSpec): Promise<Readonly<WorkflowsNodeEnvelopeV21>> {
    const attempt = (attempts.get(spec.instance_id) ?? 0) + 1;
    attempts.set(spec.instance_id, attempt);
    providerAttempts++;
    if (isProviderKind(spec.node.kind)) budgetAttempts++;
    if (providerAttempts > dynamicLimit)
      throw new Error(`workflow exceeds ${dynamicLimit} provider attempts`);
    const inputs = spec.inputs ?? baseInputs(spec.node.id);
    const inputDigest = digest({
      inputs: inputs.map(({ envelope }) => envelope.output_digest),
      item: spec.item,
    });
    const resolvedTier = resolveTier(spec.node.tier ?? "standard", spec.node.id);
    const context =
      contextMode === "bounded" && ["agent", "map"].includes(spec.node.kind)
        ? (assembleBoundedWorkflowContext as unknown as BoundedContextAssembler)({
            task,
            node: spec.node,
            item: spec.item,
            inputs,
            runDir,
          })
        : null;
    const base = {
      run_id: runId,
      workflow_digest: workflowHash,
      node_id: spec.node.id,
      instance_id: spec.instance_id,
      parent_node: spec.parent_node,
      item_key: spec.item_key,
      item_digest: spec.item_digest,
      attempt,
      loop_iteration: spec.loop_iteration ?? 1,
      input_digest: inputDigest,
      execution_tier: resolvedTier.tier ?? spec.node.tier ?? "standard",
    };
    emit("node_instance_started", {
      node_id: spec.node.id,
      instance_id: spec.instance_id,
      attempt,
      item_key: spec.item_key,
      execution_tier: base.execution_tier,
    });
    if (context) {
      emit("context_assembled", {
        node_id: spec.node.id,
        instance_id: spec.instance_id,
        ...context.evidence,
      });
    }
    try {
      const result = await execute({
        node: spec.node,
        inputs,
        item: spec.item,
        item_key: spec.item_key,
        item_digest: spec.item_digest,
        instance_id: spec.instance_id,
        attempt,
        loop_iteration: spec.loop_iteration ?? 1,
        sessionId: randomUUID(),
        workflowDigest: workflowHash,
        execution: resolvedTier,
        context,
        signal: abort.signal,
      });
      const payload = result.payload ?? (result as unknown as JsonValue);
      const payloadFindings = payloadField(payload, "findings");
      const outputCore = {
        payload,
        findings:
          result.findings ??
          ((Array.isArray(payloadFindings) ? payloadFindings : []) as Array<
            Record<string, unknown>
          >),
        evidence_refs: result.evidence_refs ?? [],
        ownership: result.ownership ?? {},
        changed_paths: result.changed_paths ?? [],
        command_evidence: result.command_evidence ?? [],
        resource_usage: result.resource_usage ?? {},
        selection: result.selection ?? null,
        quorum: result.quorum ?? null,
        convergence: result.convergence ?? null,
      };
      const envelope = freezeEnvelope({
        ...base,
        status: result.status ?? "passed",
        ...outputCore,
        output_digest: digest(outputCore),
      });
      persistEnvelope(runDir, envelope);
      return envelope;
    } catch (error) {
      // A wait is resumable, and an attempt aborted by a stop or fatal failure is not recorded,
      // so neither consumes an attempt number.
      if (isWorkflowWaiting(error) || abort.signal.aborted) throw error;
      const terminal = (error as { workflowTerminal?: unknown } | null)?.workflowTerminal === true;
      const envelope = failureEnvelope(base, error, terminal);
      persistEnvelope(runDir, envelope);
      emit("node_instance_attempt_failed", {
        node_id: spec.node.id,
        instance_id: spec.instance_id,
        attempt,
        message: failureMessage(envelope),
      });
      // Checkpoints are evaluated once per pass; a resume re-evaluates them.
      const retryable = !terminal && spec.node.kind !== "checkpoint" && attempt < attemptsLimit;
      const stop = retryable ? budgetFor(isProviderKind(spec.node.kind)) : null;
      budgetStop ??= stop;
      if (retryable && !stopRequested() && !stop) return invoke(spec);
      return envelope;
    }
  }

  function launch(spec: PendingSpec): void {
    pending.delete(spec.instance_id);
    if (spec.node.resource) busyResources.add(spec.node.resource);
    // Never rejects: failures settle to a record so no instance is abandoned or left unhandled.
    const promise: Promise<SettledSpec> = invoke(spec)
      .then(
        (envelope): SettledSpec => ({ spec, envelope }),
        (error: unknown): SettledSpec => ({ spec, error }),
      )
      .finally(() => {
        if (spec.node.resource) busyResources.delete(spec.node.resource);
      });
    running.set(spec.instance_id, { spec, promise });
  }

  /**
   * Awaits every in-flight instance so none keeps running after the scheduler returns or throws,
   * and records the envelopes they produced.
   */
  async function drainRunning(): Promise<void> {
    const remaining = [...running.values()];
    const results = await drainSettled(remaining.map(({ promise }) => promise));
    for (const { spec } of remaining) running.delete(spec.instance_id);
    for (const { envelope } of results) if (envelope) addCompleted(envelope);
  }

  function noProgress(): Error {
    return new Error(
      noProgressMessage(
        [...completed.values()]
          .filter((envelope) => !successful(envelope))
          .map((envelope) => ({
            id: envelope.node_id,
            kind: nodes.get(envelope.node_id)?.kind ?? "node",
            status: "failed",
            message: failureMessage(envelope),
          })),
        completed.keys(),
      ),
    );
  }

  const exhaustionReason = (): ExhaustedResult["reason"] | null => loopStop ?? budgetStop;

  /** Launches the instance unless a run-level budget forbids it; returns whether it started. */
  function launchWithinBudget(spec: PendingSpec): boolean {
    budgetStop ??= budgetFor(isProviderKind(spec.node.kind));
    if (budgetStop) return false;
    launch(spec);
    return true;
  }

  let throughReached = false;
  async function mainLoop(): Promise<"stopped" | "through" | "completed" | "exhausted"> {
    while (!isSettled(workflow.terminal_node) || running.size || pending.size) {
      if (stopRequested()) {
        abort.abort(new Error("workflow stop requested"));
        await drainRunning();
        return "stopped";
      }
      budgetStop ??= budgetFor(false);
      if (budgetStop || loopStop) {
        // Stop scheduling, but let running nodes finish so none outlives the result.
        await drainRunning();
        return "exhausted";
      }
      for (const node of workflow.nodes) discoverNode(node);
      if (fatal) throw fatal;
      if (throughReached && running.size === 0) break;
      const writerRunning = [...running.values()].some(({ spec }) => spec.node.access === "write");
      const candidates = [...pending.values()].sort((left, right) =>
        left.instance_id.localeCompare(right.instance_id),
      );
      const writer = candidates.find(({ node }) => node.access === "write");
      if (throughReached) {
        // The through node settled: launch nothing new and let the running siblings drain.
      } else if (!writerRunning && running.size === 0 && writer) launchWithinBudget(writer);
      else if (!writerRunning && !writer) {
        for (const spec of candidates) {
          if (running.size >= concurrency) break;
          if (
            spec.node.access === "write" ||
            (spec.node.resource && busyResources.has(spec.node.resource))
          )
            continue;
          if (!launchWithinBudget(spec)) break;
        }
      }
      if (budgetStop) {
        await drainRunning();
        return "exhausted";
      }
      if (running.size === 0) {
        if (fatal) throw fatal;
        if (isSettled(workflow.terminal_node)) break;
        throw noProgress();
      }
      const settled = await Promise.race([...running.values()].map(({ promise }) => promise));
      running.delete(settled.spec.instance_id);
      if (!settled.envelope) {
        if (isWorkflowWaiting(settled.error)) throw settled.error;
        // A stop aborts running providers; their failures are not workflow failures.
        if (abort.signal.aborted && stopRequested()) continue;
        fatal = settled.error instanceof Error ? settled.error : new Error(String(settled.error));
        continue;
      }
      addCompleted(settled.envelope);
      emit("node_instance_completed", {
        node_id: settled.spec.node.id,
        instance_id: settled.spec.instance_id,
        status: settled.envelope.status,
        item_key: settled.envelope.item_key,
        execution_tier: settled.envelope.execution_tier,
      });
      streamSuccessors(settled.spec, settled.envelope);
      const loopContinued =
        advanceUntilDry(settled.spec, settled.envelope) ||
        advanceBounded(settled.spec, settled.envelope) !== "none";
      const collectionError = collectPolicyError(settled.spec.node);
      if (collectionError) fatal = new Error(collectionError);
      if (
        !successful(settled.envelope) &&
        settled.spec.node.failure_handling?.mode !== "collect" &&
        !thresholdToleratesFailure(settled.spec.node) &&
        !loopContinued &&
        !budgetStop
      ) {
        fatal = new Error(
          `workflow node instance ${settled.spec.instance_id} failed: ${failureMessage(settled.envelope) ?? "failed"}`,
        );
      }
      // A map or stream node is through only when every one of its instances has settled.
      if (through && isSettled(through)) throughReached = true;
    }
    if (fatal) throw fatal;
    return throughReached ? "through" : "completed";
  }

  const stopWatch = abortOnStop(stopRequested, abort);
  let outcome: "stopped" | "through" | "completed" | "exhausted";
  try {
    outcome = await mainLoop();
  } catch (error) {
    // Any failure aborts and awaits in-flight instances before it surfaces; a checkpoint wait
    // lets running readers finish.
    if (!isWorkflowWaiting(error)) abort.abort(error);
    await drainRunning();
    throw error;
  } finally {
    stopWatch();
  }
  if (outcome === "exhausted") {
    const reason = exhaustionReason();
    if (!reason) throw new Error("workflow stopped without a recorded reason");
    if (!loopStop) emit("budget_exhausted", { reason });
    return {
      status: "repair-exhausted",
      reason,
      completed,
      workflow_digest: workflowHash,
      loop_rounds: loopRepairs,
    };
  }
  if (outcome !== "completed") return { status: outcome, completed, workflow_digest: workflowHash };
  if (!nodeEnvelopes(workflow.terminal_node).some(successful)) {
    throw new Error(`workflow terminal node ${workflow.terminal_node} did not complete`);
  }
  emit("workflow_completed", { node_id: workflow.terminal_node });
  return { status: "completed", completed, workflow_digest: workflowHash };
}
