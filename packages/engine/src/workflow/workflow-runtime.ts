/** Executes immutable graph workflow snapshots through the central scheduler. */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ValidateFunction } from "ajv";
import {
  changedIgnoredPaths,
  changedPaths,
  assertGitStateInvariant,
  ignoredDirectoryHasControlFile,
  ignoredPathFingerprints,
  type IgnoredWalkLimits,
  isIgnoreControlFile,
  truncatedIgnoredPaths,
} from "../run/autonomous-git.js";
import { ignoredWriteAllow } from "../run/autonomous-policy.js";
import { runBoundedProcess } from "../agents/bounded-process.js";
import {
  createCheckpoint,
  listCheckpoints,
  readOperatorControl,
  setRunStatus,
} from "../run/operator-control.js";
import { appendTraceEvent } from "../run/trace.js";
import { writeJson } from "../run/state.js";
import { createRuntimeStateGuard, reconcileRuntimeStateGuard } from "../run/runtime-state-guard.js";
import { scheduleWorkflow } from "./workflow-scheduler.js";
import { readEnvelopeFile, WRITER_REVERIFICATION_FINDING } from "./workflow-scheduler-common.js";
import { writeExclusiveFileAtomic } from "../primitives/atomic-file.js";
import { canonicalJson } from "./workflow-contract.js";
import { applyWorkflowTransform } from "./workflow-transforms.js";
import { resolveExecutionTier, resolveNodeCapabilities } from "./execution-profile.js";
import type { CapabilitySet } from "./execution-profile.js";
import { cliWorkflowAgentWorkerEntrypoint } from "../primitives/installation-paths.js";
import { validateNodeEnvelope } from "./workflow-envelope.js";
import type { WorkflowContract } from "./workflow-contract.js";
import type {
  WorkflowsNodeEnvelopeV2,
  WorkflowsNodeEnvelopeV21,
  WorkflowsNodeEnvelopeV22,
} from "@rae/contracts";
import { DEFAULT_CHECKPOINT_POLICY } from "../run/autonomous-lifecycle.js";
import type {
  AutonomousCommandOptions,
  AutonomousLifecycleContext,
} from "../run/autonomous-lifecycle.js";
import type {
  AgentPhaseOptions,
  AgentExecutionResult,
  AgentProvider,
} from "../agents/agent-executor.js";

const WORKER = cliWorkflowAgentWorkerEntrypoint();
type WorkflowEnvelope =
  | WorkflowsNodeEnvelopeV2
  | WorkflowsNodeEnvelopeV21
  | WorkflowsNodeEnvelopeV22;
type WorkflowNode = WorkflowContract["nodes"][number];
interface WorkflowEdgeLike {
  from: string;
  type: string;
  artifact?: string;
}
interface WorkflowInput {
  edge: WorkflowEdgeLike;
  envelope: WorkflowEnvelope;
}
interface OwnershipPayload extends Record<string, unknown> {
  file_ownership: string[];
}
interface ProviderResult extends AgentExecutionResult {
  provider?: AgentProvider;
  commandEvents?: Array<Record<string, unknown>>;
  resourceUsage?: Record<string, unknown>;
  capabilitySurface?: unknown;
  credentialManifest?: unknown[];
}
interface ContextAssembly {
  prompt_context: unknown;
  digest: string;
  evidence: Record<string, unknown>;
  manifest: Record<string, unknown> & {
    policy_digest: string;
    assembled_bytes: number;
  };
}
interface NodeInstance extends Record<string, unknown> {
  instance_id?: string;
  loop_iteration?: number;
  item?: unknown;
  execution?: Record<string, unknown> & {
    executor?: AgentProvider;
    model?: string;
    reasoning_effort?: string;
    variant?: string;
    route_id?: string;
    capabilities?: CapabilitySet | null;
  };
  context?: ContextAssembly;
  /** Aborted by the scheduler on stop or fatal failure; terminates the provider process group. */
  signal?: AbortSignal;
}
interface RuntimeContext extends AutonomousLifecycleContext {
  workflow: WorkflowContract;
  workflowDigest: string;
  options?: AutonomousActionOptions;
  verifiedGraphRecords?: unknown[];
  admittedMemory?: unknown[];
  /** Overrides the ignored-directory fingerprint walk caps (tests). */
  ignoredWalkLimits?: Partial<IgnoredWalkLimits>;
}
interface WorkerRequest extends AgentPhaseOptions {
  timeoutMs: number;
}
interface RuntimeFailure extends Error {
  workflowWaiting?: boolean;
  workflowTerminal?: boolean;
}
interface DeterministicPayload extends Record<string, unknown> {
  node_id: string;
  status: "passed" | "failed";
  inputs: Array<{ source: string; digest: string }>;
  findings?: Array<Record<string, unknown>>;
  selection?: Record<string, unknown>;
  quorum?: Record<string, unknown>;
  items?: unknown;
}
interface NodeExecutionResult extends Record<string, unknown> {
  status: string;
  payload: unknown;
  findings: Array<Record<string, unknown>>;
  changed_paths?: string[];
  command_evidence?: Array<Record<string, unknown>>;
  resource_usage?: Record<string, unknown>;
  evidence_refs?: string[];
}
interface AutonomousActionOptions extends AutonomousCommandOptions {
  through?: string;
  contextPolicy?: unknown;
}

const payloadValidatorCaches = new WeakMap<object, Map<string | null, ValidateFunction>>();

function workspaceMutationFingerprint(workspaceRoot: string): string {
  const hash = createHash("sha256");
  const visit = (relativePath: string): void => {
    const absolute = resolve(workspaceRoot, relativePath);
    if (!existsSync(absolute)) {
      hash.update(`${relativePath}\0missing\0`);
      return;
    }
    const stat = lstatSync(absolute);
    hash.update(`${relativePath}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(absolute));
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relativePath}/${name}`);
      return;
    }
    if (stat.isFile()) hash.update(readFileSync(absolute));
  };
  for (const pathValue of changedPaths(workspaceRoot)) visit(pathValue);
  return hash.digest("hex");
}

function latestPassedEnvelope(directory: string): WorkflowEnvelope | undefined {
  const loopIteration = (envelope: WorkflowEnvelope): number =>
    "loop_iteration" in envelope ? (envelope.loop_iteration ?? 1) : 1;
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readEnvelopeFile(resolve(directory, name)) as WorkflowEnvelope)
    .filter((envelope) => envelope.status === "passed")
    .sort(
      (left, right) => loopIteration(left) - loopIteration(right) || left.attempt - right.attempt,
    )
    .at(-1);
}

function assertSafeOwnershipPath(
  planNode: WorkflowNode,
  pathValue: unknown,
): asserts pathValue is string {
  const unsafe =
    typeof pathValue !== "string" ||
    !pathValue ||
    pathValue.startsWith("/") ||
    pathValue.split("/").includes("..");
  if (unsafe) throw new Error(`ownership plan ${planNode.id} contains an unsafe path`);
}

function ownershipPlan(context: RuntimeContext): OwnershipPayload {
  const planNode = context.workflow.nodes.find((node) => node.ownership_plan === true);
  if (!planNode) throw new Error("workflow writer has no ownership-plan node");
  const directory = resolve(context.runDir, "workflow", "attempts", planNode.id);
  if (!existsSync(directory)) throw new Error(`workflow writer has no ${planNode.id} envelope`);
  const payload = latestPassedEnvelope(directory)?.payload;
  const plan =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (!plan || !Array.isArray(plan.file_ownership) || plan.file_ownership.length === 0)
    throw new Error(`ownership plan ${planNode.id} must declare file_ownership`);
  for (const pathValue of plan.file_ownership) assertSafeOwnershipPath(planNode, pathValue);
  return plan as OwnershipPayload;
}

function assertWriterEvidence(
  context: RuntimeContext,
  node: WorkflowNode,
  result: ProviderResult,
  changed: string[],
): void {
  if (node.access !== "write") return;
  const plan = ownershipPlan(context);
  const unauthorized = changed.filter(
    (pathValue) =>
      !plan.file_ownership.some(
        (owned) => pathValue === owned || pathValue.startsWith(`${owned.replace(/\/$/, "")}/`),
      ),
  );
  if (unauthorized.length)
    throw new Error(
      `writer ${node.id} changed paths outside file_ownership: ${unauthorized.join(", ")}`,
    );
  if (
    result.provider === "codex" &&
    !(result.commandEvents ?? []).some(
      (event) => event.successful === true && event.exit_code === 0,
    )
  ) {
    throw new Error(`writer ${node.id} returned no successful command execution evidence`);
  }
}

/** Worker stderr kept for diagnostics; stdout keeps the bounded-process default cap. */
const WORKER_STDERR_LIMIT_BYTES = 1024 * 1024;

/**
 * Runs one provider session in the isolated worker process. The worker leads its own process
 * group; a timeout, an output overflow, or `signal` (a scheduler stop or fatal failure)
 * terminates the whole group.
 */
async function runWorker(
  request: WorkerRequest,
  cwd: string,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const proc = await runBoundedProcess({
    command: process.execPath,
    args: [WORKER],
    cwd,
    env: process.env,
    input: `${JSON.stringify(request)}\n`,
    timeoutMs: request.timeoutMs + 5000,
    stderrLimitBytes: WORKER_STDERR_LIMIT_BYTES,
    signal,
  });
  if (proc.error) throw new Error(`workflow agent worker failed to start: ${proc.error.message}`);
  if (proc.termination) {
    const uncertain = proc.termination.containmentUncertain ? "; containment_uncertain" : "";
    throw new Error(
      `workflow agent worker was terminated (${proc.termination.reason})${uncertain}: ${proc.stderrTail.trim()}`,
    );
  }
  if (proc.backgroundCleanup?.containmentUncertain) {
    throw new Error(
      `workflow agent worker left background processes that could not be stopped; containment_uncertain: ${proc.stderrTail.trim()}`,
    );
  }
  if (proc.status !== 0) {
    throw new Error(`workflow agent worker exited with ${proc.status}: ${proc.stderrTail.trim()}`);
  }
  try {
    return JSON.parse(proc.stdout) as ProviderResult;
  } catch (error) {
    throw new Error(
      `workflow agent worker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The node's payload contract, defaulting to any object. */
function nodePayloadContract(context: RuntimeContext, node: WorkflowNode): unknown {
  return (
    context.workflow.payload_contracts?.[node.payload_contract ?? ""] ?? {
      type: "object",
    }
  );
}

/** Writes the node's payload schema once, atomically; later attempts reuse the same file. */
function nodeSchemaPath(context: RuntimeContext, node: WorkflowNode): string {
  const pathValue = resolve(
    context.runDir,
    "workflow",
    "payload-contracts",
    `${node.id}.schema.json`,
  );
  if (existsSync(pathValue)) return pathValue;
  mkdirSync(dirname(pathValue), { recursive: true, mode: 0o700 });
  try {
    writeExclusiveFileAtomic(
      pathValue,
      `${JSON.stringify(nodePayloadContract(context, node), null, 2)}\n`,
    );
  } catch (error) {
    // A concurrent instance of the same node wrote the identical schema first.
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return pathValue;
}

function boundedRunReferenceBase(context: RuntimeContext): string {
  const relativeRunDir = relative(
    resolve(context.workspaceRoot),
    resolve(context.runDir),
  ).replaceAll("\\", "/");
  const expected = `.pipeline/runs/${context.runId}`;
  if (relativeRunDir !== expected || !/^\.pipeline\/runs\/[a-zA-Z0-9._-]+$/.test(relativeRunDir)) {
    throw new Error("bounded provider context requires a safe run directory inside the workspace");
  }
  return `${relativeRunDir}/`;
}

/** Inlines the canonical payload schema for providers that cannot enforce an output schema. */
function outputSchemaSection(outputSchema: unknown): string {
  if (outputSchema === null || outputSchema === undefined) return "";
  return `
Output JSON schema:
${JSON.stringify(outputSchema, null, 2)}
`;
}

/** True when the provider enforces the payload schema itself (Codex --output-schema). */
function providerEnforcesSchema(provider: string): boolean {
  // "auto" only ever resolves to Codex; OpenCode is always explicit.
  return provider === "codex" || provider === "auto";
}

function boundedPromptFor(
  context: RuntimeContext,
  node: WorkflowNode,
  assembledContext: unknown,
  outputSchema: unknown = null,
): string {
  const runReferenceBase = boundedRunReferenceBase(context);
  return `You are executing one node in a RAE graph-native autonomous workflow.

Run: ${context.runId}
Workflow digest: ${context.workflowDigest}
Node: ${node.id}
Role: ${node.role ?? node.kind}
Mutation mode: ${node.access === "write" ? "workspace-write" : "read-only"}

Bounded workflow context (canonical JSON; complete inline artifacts or immutable artifact references):
${canonicalJson(assembledContext)}

Artifact reference base: ${runReferenceBase}
- Resolve every artifact_ref relative to this run directory before reading it.
- Verify artifact_digest and output_digest before relying on a referenced artifact.

Mandatory rules:
- Read applicable repository instructions and inspect source evidence before deciding.
- Stay inside the workspace. Never commit, push, publish, deploy, install dependencies, or alter Git remotes.
- Never read or print secrets, credentials, environment files, tokens, or private key material.
- ${node.access === "write" ? "Modify only paths owned by the plan and capture verification commands." : "Do not modify repository files."}
- Return only the JSON payload required by the supplied schema, without Markdown.
${outputSchemaSection(outputSchema)}`;
}

/** Builds the exact provider prompt while preserving the legacy and v2.2 serialization contract. */
export function providerPromptForWorkflow(
  context: RuntimeContext,
  node: WorkflowNode,
  inputs: WorkflowInput[],
  item: unknown,
  assembledContext: unknown = null,
  outputSchema: unknown = null,
): string {
  if (
    assembledContext &&
    context.contextMode === "bounded" &&
    ["2.0.0", "2.1.0"].includes(context.workflow?.schema_version)
  ) {
    return boundedPromptFor(context, node, assembledContext, outputSchema);
  }
  const inputPayloads = inputs.map(({ edge, envelope }) => ({
    source_node: edge.from,
    edge_type: edge.type,
    artifact: edge.artifact ?? null,
    envelope,
  }));
  return `You are executing one node in a RAE graph-native autonomous workflow.

Run: ${context.runId}
Workflow digest: ${context.workflowDigest}
Node: ${node.id}
Role: ${node.role ?? node.kind}
Mutation mode: ${node.access === "write" ? "workspace-write" : "read-only"}

User task:
${context.task}

${assembledContext ? "Bounded predecessor context (complete inline artifacts or immutable artifact references):" : "Typed predecessor envelopes:"}
${JSON.stringify(assembledContext ?? inputPayloads, null, 2)}

${item === undefined || item === null ? "" : `Mapped item:\n${JSON.stringify(item, null, 2)}\n`}

Node guidance:
${node.guidance}

Mandatory rules:
- Read applicable repository instructions and inspect source evidence before deciding.
- Stay inside the workspace. Never commit, push, publish, deploy, install dependencies, or alter Git remotes.
- Never read or print secrets, credentials, environment files, tokens, or private key material.
- ${node.access === "write" ? "Modify only paths owned by the plan and capture verification commands." : "Do not modify repository files."}
- Return only the JSON payload required by the supplied schema, without Markdown.
${outputSchemaSection(outputSchema)}`;
}

async function providerNode(
  context: RuntimeContext & { options: AutonomousActionOptions },
  node: WorkflowNode,
  inputs: WorkflowInput[],
  attempt: number,
  instance: NodeInstance = {},
): Promise<NodeExecutionResult> {
  const { request, instancePart, eventLogPath, cleanup } = prepareProviderRequest(
    context,
    node,
    inputs,
    attempt,
    instance,
  );
  try {
    return await executeProviderNode(
      context,
      node,
      request,
      instancePart,
      eventLogPath,
      attempt,
      instance,
    );
  } finally {
    cleanup();
  }
}

/**
 * Builds the worker request. The provider output file lives in a temp directory outside the
 * workspace so it cannot trip the runtime-state guard under .pipeline.
 */
export function prepareProviderRequest(
  context: RuntimeContext & { options: AutonomousActionOptions },
  node: WorkflowNode,
  inputs: WorkflowInput[],
  attempt: number,
  instance: NodeInstance = {},
): { request: WorkerRequest; instancePart: string; eventLogPath: string; cleanup: () => void } {
  const { instancePart, schemaPath, eventLogPath } = providerPaths(
    context,
    node,
    attempt,
    instance,
  );
  const tempDir = mkdtempSync(join(tmpdir(), "rae-workflow-"));
  const cleanup = (): void => rmSync(tempDir, { recursive: true, force: true });
  try {
    const request = providerRequest(context, node, inputs, instance, {
      schemaPath,
      eventLogPath,
      outputPath: resolve(tempDir, `${instancePart}.${attempt}.json`),
    });
    return { request, instancePart, eventLogPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function executeProviderNode(
  context: RuntimeContext & { options: AutonomousActionOptions },
  node: WorkflowNode,
  request: WorkerRequest,
  instancePart: string,
  eventLogPath: string,
  attempt: number,
  instance: NodeInstance,
): Promise<NodeExecutionResult> {
  const contextAssemblyRef = persistBoundedContextAssembly(
    context,
    node,
    attempt,
    instance,
    instancePart,
    request,
  );
  const { result, beforeFingerprint, ignoredBefore } = await runProviderWorker(
    context,
    node,
    request,
    eventLogPath,
    instance.signal,
  );
  validateProviderArtifact(context, node, result);
  const changed = changedPaths(context.workspaceRoot);
  assertReadOnlyNodeDidNotMutate(context, node, beforeFingerprint);
  assertWriterEvidence(context, node, result, changed);
  const ignoredFindings = ignoredPathFindings(context, node, ignoredBefore);
  const contextEvidence = instance.context
    ? {
        ...instance.context.evidence,
        ...(contextAssemblyRef
          ? {
              provider_context_bytes: Buffer.byteLength(
                canonicalJson(instance.context.prompt_context),
                "utf8",
              ),
              context_assembly_ref: contextAssemblyRef,
            }
          : {}),
        provider_prompt_bytes: Buffer.byteLength(request.prompt, "utf8"),
      }
    : null;
  const nodeResult = providerResult(node, result, changed, instancePart, attempt, contextEvidence);
  return ignoredFindings.length
    ? { ...nodeResult, findings: [...nodeResult.findings, ...ignoredFindings] }
    : nodeResult;
}

/**
 * True when a changed ignored entry matches an `ignored_write_allow` prefix at the top level or
 * below any directory (`node_modules/` also covers `packages/a/node_modules/`). Ignore and
 * attributes files, and directories that carry their own, are never allowed: they can hide
 * other changes from ownership checks.
 */
function ignoredWriteAllowed(
  workspaceRoot: string,
  entry: string,
  allow: readonly string[],
): boolean {
  if (isIgnoreControlFile(entry) || ignoredDirectoryHasControlFile(workspaceRoot, entry)) {
    return false;
  }
  return allow.some((prefix) => entry.startsWith(prefix) || entry.includes(`/${prefix}`));
}

/**
 * Compares ignored-path fingerprints taken before and after one provider node. Read-only nodes
 * may not change anything, ignored or not. A writer's ignored changes block unless the autonomous
 * policy's ignored-write allow list covers them; allowed changes stay visible as a warning.
 */
export function ignoredPathFindings(
  context: RuntimeContext,
  node: WorkflowNode,
  ignoredBefore: Readonly<Record<string, string>>,
): Array<Record<string, unknown>> {
  const after = ignoredPathFingerprints(context.workspaceRoot, context.ignoredWalkLimits);
  const changed = changedIgnoredPaths(ignoredBefore, after);
  const allow = ignoredWriteAllow(context.policy);
  // A directory whose fingerprint hit the walk cap cannot prove it is unchanged, so outside the
  // allow list it blocks like a change.
  const truncated = truncatedIgnoredPaths(after);
  const unverifiable = truncated.filter(
    (entry) => !ignoredWriteAllowed(context.workspaceRoot, entry, allow),
  );
  if ((changed.length || unverifiable.length) && node.access !== "write") {
    const detail = [
      changed.length ? `added, removed, or changed gitignored paths: ${changed.join(", ")}` : "",
      unverifiable.length
        ? `gitignored directories too large to fingerprint: ${unverifiable.join(", ")}`
        : "",
    ].filter(Boolean);
    throw new Error(`read-only node ${node.id} ${detail.join("; ")}`);
  }
  if (node.access !== "write") return [];
  const blocked = changed.filter(
    (entry) => !ignoredWriteAllowed(context.workspaceRoot, entry, allow),
  );
  const allowed = changed.filter((entry) => !blocked.includes(entry));
  const findings: Array<Record<string, unknown>> = [];
  if (blocked.length) {
    findings.push({
      severity: "blocking",
      blocking: true,
      source: node.id,
      summary: `writer ${node.id} changed gitignored paths outside the ignored-write allow list: ${blocked.join(", ")}`,
      paths: blocked,
    });
  }
  if (allowed.length) {
    findings.push({
      severity: "warning",
      blocking: false,
      source: node.id,
      summary: `writer ${node.id} changed allowed gitignored paths: ${allowed.join(", ")}`,
      paths: allowed,
    });
  }
  if (unverifiable.length) {
    findings.push({
      severity: "blocking",
      blocking: true,
      source: node.id,
      summary: `writer ${node.id} ran with gitignored directories too large to fingerprint outside the ignored-write allow list: ${unverifiable.join(", ")}`,
      paths: unverifiable,
    });
  }
  const allowedTruncated = truncated.filter((entry) => !unverifiable.includes(entry));
  if (allowedTruncated.length) {
    findings.push({
      severity: "warning",
      blocking: false,
      source: node.id,
      summary: `allowed gitignored directories exceed the fingerprint bound; deep changes may be missed: ${allowedTruncated.join(", ")}`,
      paths: allowedTruncated,
    });
  }
  return findings;
}

function persistBoundedContextAssembly(
  context: RuntimeContext,
  node: WorkflowNode,
  attempt: number,
  instance: NodeInstance,
  instancePart: string,
  request: WorkerRequest,
): string | null {
  if (
    !instance.context ||
    context.contextMode !== "bounded" ||
    !["2.0.0", "2.1.0"].includes(context.workflow?.schema_version)
  ) {
    return null;
  }
  const loopIteration = Number(instance.loop_iteration ?? 1);
  const directory = resolve(context.runDir, "workflow", "context-assemblies", node.id);
  const filename = `${instancePart}.loop-${loopIteration}.attempt-${attempt}.json`;
  const pathValue = resolve(directory, filename);
  const artifactRef = relative(context.runDir, pathValue).replaceAll("\\", "/");
  const serializedContext = canonicalJson(instance.context.prompt_context);
  writeJson(pathValue, {
    record_version: "1.0.0",
    run_id: context.runId,
    workflow_digest: context.workflowDigest,
    node_id: node.id,
    instance_id: instance.instance_id ?? node.id,
    loop_iteration: loopIteration,
    attempt,
    context_mode: "bounded",
    context_policy_digest: instance.context.manifest.policy_digest,
    context_digest: instance.context.digest,
    prompt_context_digest: createHash("sha256").update(serializedContext).digest("hex"),
    prompt_digest: createHash("sha256").update(request.prompt).digest("hex"),
    artifact_reference_base: boundedRunReferenceBase(context),
    context_assembly_ref: artifactRef,
    byte_metrics: {
      assembled_bytes: instance.context.manifest.assembled_bytes,
      provider_context_bytes: Buffer.byteLength(serializedContext, "utf8"),
      provider_prompt_bytes: Buffer.byteLength(request.prompt, "utf8"),
    },
    assembly: {
      prompt_context: instance.context.prompt_context,
      manifest: instance.context.manifest,
      evidence: instance.context.evidence,
    },
  });
  return artifactRef;
}

function providerPaths(
  context: RuntimeContext,
  node: WorkflowNode,
  attempt: number,
  instance: NodeInstance,
): { instancePart: string; schemaPath: string; eventLogPath: string } {
  const outputDir = resolve(context.runDir, "workflow", "agent-outputs");
  const instanceName =
    !instance.instance_id && Number(instance.loop_iteration ?? 1) > 1
      ? `${node.id}.loop-${instance.loop_iteration}`
      : (instance.instance_id ?? node.id);
  const instancePart = instanceName.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return {
    instancePart,
    schemaPath: nodeSchemaPath(context, node),
    eventLogPath: resolve(outputDir, `${instancePart}.${attempt}.events.jsonl`),
  };
}

function providerRequest(
  context: RuntimeContext & { options: AutonomousActionOptions },
  node: WorkflowNode,
  inputs: WorkflowInput[],
  instance: NodeInstance,
  {
    schemaPath,
    eventLogPath,
    outputPath,
  }: {
    schemaPath: string;
    eventLogPath: string;
    outputPath: string;
  },
): WorkerRequest {
  return {
    provider: instance.execution?.executor ?? context.options.provider ?? "auto",
    command: context.options["agent-command"],
    commandArgs: context.options.agentArgs,
    phase: node.id,
    runId: context.runId,
    workspaceRoot: context.workspaceRoot,
    schemaPath,
    outputPath,
    eventLogPath,
    prompt: providerPromptForWorkflow(
      context,
      node,
      inputs,
      instance.item,
      instance.context?.prompt_context,
      providerEnforcesSchema(
        String(instance.execution?.executor ?? context.options.provider ?? "auto"),
      )
        ? null
        : nodePayloadContract(context, node),
    ),
    sandboxMode: node.access === "write" ? "workspace-write" : "read-only",
    model: instance.execution?.model ?? context.options.model ?? undefined,
    reasoningEffort: instance.execution?.reasoning_effort ?? context.options["reasoning-effort"],
    variant: instance.execution?.variant,
    routeId: instance.execution?.route_id ?? null,
    capabilities: instance.execution?.capabilities ?? null,
    sourceRoot: context.projectRoot,
    runDir: context.runDir,
    inPlace: context.workspaceRoot === context.projectRoot,
    timeoutMs: Number(context.options["timeout-seconds"] ?? 1800) * 1000,
    allowUnsafeCommand: context.options["allow-unsafe-command-provider"] === true,
  };
}

async function runProviderWorker(
  context: RuntimeContext,
  node: WorkflowNode,
  request: WorkerRequest,
  eventLogPath: string,
  signal?: AbortSignal,
): Promise<{
  result: ProviderResult;
  beforeFingerprint: string;
  ignoredBefore: Record<string, string>;
}> {
  const beforeFingerprint = workspaceMutationFingerprint(context.workspaceRoot);
  const ignoredBefore = ignoredPathFingerprints(context.workspaceRoot, context.ignoredWalkLimits);
  if (node.access !== "write") {
    return {
      result: await runWorker(request, context.workspaceRoot, signal),
      beforeFingerprint,
      ignoredBefore,
    };
  }
  createRuntimeStateGuard(context.workspaceRoot, context.runId, node.id);
  let result: ProviderResult | undefined;
  let executionError: unknown;
  try {
    result = await runWorker(request, context.workspaceRoot, signal);
  } catch (error) {
    executionError = error;
  } finally {
    const reconciliation = reconcileRuntimeStateGuard(context.workspaceRoot, {
      allowedRefs: [relative(resolve(context.workspaceRoot, ".pipeline"), eventLogPath)],
      expectedRunId: context.runId,
    });
    if (reconciliation.tampered) {
      executionError = new Error(`provider modified protected runtime state in ${node.id}`);
    }
  }
  if (executionError) throw executionError;
  if (!result) throw new Error(`workflow provider ${node.id} returned no result`);
  return { result, beforeFingerprint, ignoredBefore };
}

function validateProviderArtifact(
  context: RuntimeContext,
  node: WorkflowNode,
  result: ProviderResult,
): void {
  const validate = payloadValidatorForWorkflow(context.workflow, node.payload_contract);
  if (!validate(result.artifact)) throw new Error(`node ${node.id} returned an invalid payload`);
  assertGitStateInvariant(context.workspaceRoot, context.initialGitState, node.id);
}

/** Reuses one selected-contract validator for the lifetime of an immutable workflow object. */
export function payloadValidatorForWorkflow(
  workflow: { payload_contracts?: Record<string, unknown> },
  contractName?: string,
): ValidateFunction {
  let validators = payloadValidatorCaches.get(workflow);
  if (!validators) {
    validators = new Map();
    payloadValidatorCaches.set(workflow, validators);
  }
  const key = contractName ?? null;
  if (!validators.has(key)) {
    const contract = key === null ? { type: "object" } : workflow.payload_contracts?.[key];
    if (!contract) throw new Error(`workflow payload contract is missing: ${key}`);
    validators.set(
      key,
      new Ajv2020({ allErrors: true, strict: false }).compile(contract as AnySchema),
    );
  }
  const validator = validators.get(key);
  if (!validator) throw new Error(`workflow payload validator is unavailable: ${key}`);
  return validator;
}

function assertReadOnlyNodeDidNotMutate(
  context: RuntimeContext,
  node: WorkflowNode,
  beforeFingerprint: string,
): void {
  if (
    node.access !== "write" &&
    workspaceMutationFingerprint(context.workspaceRoot) !== beforeFingerprint
  ) {
    throw new Error(`read-only node ${node.id} changed repository content`);
  }
}

function providerResult(
  node: WorkflowNode,
  result: ProviderResult,
  changed: string[],
  instancePart: string,
  attempt: number,
  contextEvidence: Record<string, unknown> | null = null,
): NodeExecutionResult {
  return {
    status: typeof result.artifact.status === "string" ? result.artifact.status : "passed",
    payload: result.artifact,
    findings: Array.isArray(result.artifact.findings)
      ? result.artifact.findings.filter(
          (finding): finding is Record<string, unknown> =>
            Boolean(finding) && typeof finding === "object" && !Array.isArray(finding),
        )
      : [],
    changed_paths: node.access === "write" ? changed : [],
    command_evidence: result.commandEvents ?? [],
    resource_usage: {
      ...(result.resourceUsage ?? {}),
      ...(contextEvidence ? { context_assembly: contextEvidence } : {}),
      capability_surface: result.capabilitySurface ?? null,
      credential_manifest: result.credentialManifest ?? [],
    },
    evidence_refs: [`workflow/agent-outputs/${instancePart}.${attempt}.events.jsonl`],
  };
}

function envelopeInstanceId(envelope: WorkflowEnvelope): string {
  return "instance_id" in envelope ? envelope.instance_id : envelope.node_id;
}

/** A single non-map input passes through; map instances and multiple inputs are wrapped. */
export function transformSource(
  workflow: { nodes: Array<{ id: string; kind: string }> },
  inputs: WorkflowInput[],
): unknown {
  const [only] = inputs;
  if (inputs.length === 1 && only) {
    const itemKey = "item_key" in only.envelope ? only.envelope.item_key : null;
    const sourceKind = workflow.nodes.find(({ id }) => id === only.edge.from)?.kind;
    if (sourceKind !== "map" && (itemKey === null || itemKey === undefined))
      return only.envelope.payload;
  }
  return { inputs: inputs.map(({ envelope }) => envelope.payload) };
}

/** Fails on blocking findings, non-passed inputs, or an unverified writer feeding a loop gate. */
export function evaluateGate(
  node: { id: string; verification?: boolean },
  inputs: WorkflowInput[],
  workflow: {
    nodes: Array<{ id: string; access?: string }>;
    edges: Array<{ from: string; type: string }>;
  },
): {
  status: "passed" | "failed";
  findings: Array<Record<string, unknown>>;
  inputsFailed: boolean;
} {
  const findings: Array<Record<string, unknown>> = inputs.flatMap(
    ({ envelope }) => envelope.findings ?? [],
  );
  let failed = findings.some(
    (finding) => finding.blocking === true || finding.severity === "blocking",
  );
  const inputsFailed = inputs.some(({ envelope }) => envelope.status !== "passed");
  if (inputsFailed) failed = true;
  if (node.verification === true) {
    const writerInput = inputs.find(
      ({ edge }) => workflow.nodes.find(({ id }) => id === edge.from)?.access === "write",
    );
    const hasLoopBack = workflow.edges.some(
      (edge) => edge.type === "loop-back" && edge.from === node.id,
    );
    if (writerInput && hasLoopBack) {
      failed = true;
      findings.push({
        id: WRITER_REVERIFICATION_FINDING,
        severity: "blocking",
        blocking: true,
        summary: `write node ${writerInput.edge.from} output requires re-verification by the loop members`,
      });
    }
  }
  return { status: failed ? "failed" : "passed", findings, inputsFailed };
}

function deterministicNode(
  context: RuntimeContext & { options: AutonomousActionOptions },
  node: WorkflowNode,
  inputs: WorkflowInput[],
): NodeExecutionResult {
  if (node.kind === "checkpoint") {
    const policy = context.options["checkpoint-policy"] ?? DEFAULT_CHECKPOINT_POLICY;
    // mutation_checkpoint: false marks a release checkpoint that only pauses before shipping.
    const release = node.mutation_checkpoint === false;
    const pauses = release
      ? policy === "before-mutation-and-ship"
      : ["before-mutation", "before-mutation-and-ship"].includes(policy);
    if (pauses) {
      // A release checkpoint recorded under the former "mutation" purpose keeps its identity, so
      // a resumed run honors the decision already made instead of asking again.
      const recorded = release
        ? listCheckpoints(context.runId, context.workspaceRoot).find(
            ({ phase, purpose }) => phase === node.id && purpose === "mutation",
          )
        : undefined;
      const checkpoint =
        recorded ??
        createCheckpoint(
          context.runId,
          {
            phase: node.id,
            purpose: release ? "ship" : "mutation",
            message: release
              ? "Human approval is required before the graph workflow may complete."
              : "Human approval is required before the graph workflow may modify the workspace.",
          },
          context.workspaceRoot,
        );
      if (checkpoint.status === "pending") {
        setRunStatus(context.runId, "waiting", context.workspaceRoot, {
          waiting_checkpoint_id: checkpoint.checkpoint_id,
          stop_requested: false,
        });
        const error: RuntimeFailure = new Error(
          `workflow is waiting for checkpoint ${checkpoint.checkpoint_id}`,
        );
        error.workflowWaiting = true;
        throw error;
      }
      if (checkpoint.status !== "approved") {
        // A human decision is final for this run: schedulers must not retry the node.
        const error: RuntimeFailure = new Error(
          `checkpoint ${checkpoint.checkpoint_id} was ${checkpoint.status}`,
        );
        error.workflowTerminal = true;
        throw error;
      }
    }
  }
  const payload: DeterministicPayload = {
    node_id: node.id,
    status: "passed",
    inputs: inputs.map(({ edge, envelope }) => ({
      source: edge.from,
      digest: envelope.output_digest,
    })),
  };
  if (node.kind === "join") {
    payload.findings = inputs.flatMap(({ envelope }) => envelope.findings ?? []);
    if (node.join === "any" && inputs[0])
      payload.selection = {
        mode: "any",
        winner: envelopeInstanceId(inputs[0].envelope),
      };
    if (node.join === "quorum") {
      if (!("quorum" in node) || !node.quorum) {
        throw new Error(`quorum node ${node.id} is missing its quorum contract`);
      }
      payload.quorum = { threshold: node.quorum.threshold, accepted: inputs.length };
    }
  }
  if (node.kind === "transform") {
    const source = transformSource(context.workflow, inputs);
    if (!("transform" in node) || !node.transform) {
      throw new Error(`transform node ${node.id} is missing its transform contract`);
    }
    payload.items = applyWorkflowTransform(node.transform, source);
  }
  if (node.kind === "gate") {
    const evaluation = evaluateGate(node, inputs, context.workflow);
    payload.status = evaluation.status;
    payload.findings = evaluation.findings;
    // Lets the scheduler tell a failure forced only by a fresh writer from a real input failure.
    if (evaluation.inputsFailed) payload.inputs_failed = true;
  }
  return { status: payload.status, payload, findings: payload.findings ?? [] };
}

function envelopeOrder(envelope: WorkflowEnvelope): [number, number] {
  const iteration = "loop_iteration" in envelope ? (envelope.loop_iteration ?? 1) : 1;
  return [iteration, envelope.attempt];
}

function compareEnvelopeOrder(left: WorkflowEnvelope, right: WorkflowEnvelope): number {
  const [leftIteration, leftAttempt] = envelopeOrder(left);
  const [rightIteration, rightAttempt] = envelopeOrder(right);
  return leftIteration - rightIteration || leftAttempt - rightAttempt;
}

/** Picks the newest envelope per instance by (loop_iteration, attempt). */
export function resumeEnvelopes(context: RuntimeContext): WorkflowEnvelope[] {
  const root = resolve(context.runDir, "workflow", "attempts");
  if (!existsSync(root)) return [];
  const envelopes: WorkflowEnvelope[] = [];
  for (const nodeId of readdirSync(root).sort()) {
    const directory = resolve(root, nodeId);
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const latestByInstance = new Map<string, WorkflowEnvelope>();
    for (const name of files) {
      const envelope = validateNodeEnvelope(readEnvelopeFile(resolve(directory, name)));
      if (envelope.run_id !== context.runId)
        throw new Error(`resume envelope ${nodeId} belongs to a different run`);
      if (envelope.workflow_digest !== context.workflowDigest) {
        throw new Error(`resume envelope ${nodeId} does not match the immutable workflow snapshot`);
      }
      const id = envelopeInstanceId(envelope);
      const prior = latestByInstance.get(id);
      if (!prior || compareEnvelopeOrder(envelope, prior) >= 0) latestByInstance.set(id, envelope);
    }
    envelopes.push(...latestByInstance.values());
  }
  return envelopes;
}

export async function runGraphWorkflow(
  context: RuntimeContext,
  options: AutonomousActionOptions,
): Promise<unknown> {
  const event = (entry: Record<string, unknown>) =>
    appendTraceEvent(
      context.runId,
      {
        event: `workflow_${entry.event}`,
        phase: typeof entry.node_id === "string" ? entry.node_id : context.workflow.entry_node,
        status: typeof entry.status === "string" ? entry.status : "ok",
        metadata: Object.fromEntries(
          Object.entries(entry).filter(([key]) => !["event", "status"].includes(key)),
        ),
      },
      context.workspaceRoot,
    );
  return scheduleWorkflow({
    workflow: context.workflow,
    runId: context.runId,
    runDir: context.runDir,
    maxConcurrency:
      options["max-concurrency"] === undefined ? undefined : Number(options["max-concurrency"]),
    maxRepairRounds:
      options["max-repair-rounds"] === undefined ? undefined : Number(options["max-repair-rounds"]),
    through: options.through ?? null,
    stopRequested: () => readOperatorControl(context.runId, context.workspaceRoot).stop_requested,
    resumeEnvelopes: resumeEnvelopes(context),
    onEvent: event,
    task: context.task,
    verifiedGraphRecords: context.verifiedGraphRecords ?? [],
    admittedMemory: context.admittedMemory ?? [],
    contextPolicy: context.contextPolicy ?? options.contextPolicy ?? {},
    contextMode: context.contextMode ?? options["context-mode"] ?? "legacy",
    resolveTier: (tier: "economy" | "standard" | "judgment", nodeId: string) => ({
      ...resolveExecutionTier(context.executionProfile, tier, nodeId),
      capabilities: resolveNodeCapabilities(context.executionProfile, nodeId),
    }),
    execute: async ({ node, inputs, attempt, ...instance }) => {
      const runtimeNode = node as unknown as WorkflowNode;
      const runtimeInputs = inputs as unknown as WorkflowInput[];
      const result = ["agent", "map"].includes(runtimeNode.kind)
        ? await providerNode(
            { ...context, options },
            runtimeNode,
            runtimeInputs,
            attempt,
            instance as NodeInstance,
          )
        : deterministicNode({ ...context, options }, runtimeNode, runtimeInputs);
      return result as unknown as Awaited<
        ReturnType<Parameters<typeof scheduleWorkflow>[0]["execute"]>
      >;
    },
  });
}
