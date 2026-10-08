/** Collects run evidence, evaluates acceptance checks and builds schema-valid trial records. */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExperimentsExperimentV1DefsArm,
  ExperimentsTaskSuiteV1DefsCheck,
  ExperimentsTaskSuiteV1DefsTask,
  ExperimentsTrialRecordV1,
  ExperimentsTrialRecordV1DefsCheckResult,
} from "@rae/contracts";
import {
  executableFromPath,
  minimalChildEnvironment,
  redact,
} from "../agents/agent-provider-runtime.js";
import type { BoundedProcessRequest, BoundedProcessResult } from "../agents/bounded-process.js";
import { isWithinRoot } from "../primitives/paths.js";
import type { LoadedExperiment } from "./experiment-contract.js";
import type { PlannedTrial } from "./experiment-plan.js";
import { changedPaths } from "./autonomous-git.js";
import { graphRows } from "./run-report-writer.js";
import { readJsonStrict } from "./state.js";

const MAX_CHECK_FILE_BYTES = 16 * 1024 * 1024;
const DETAIL_CHARS = 500;
const SHIP_STATES = new Set(["implemented-awaiting-human-release-review", "completed"]);
const DIGEST = /^[a-f0-9]{64}$/;
const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

export type CheckResult = ExperimentsTrialRecordV1DefsCheckResult;
export type TrialStatus = ExperimentsTrialRecordV1["status"];
export type TrialTokens = ExperimentsTrialRecordV1["measurements"]["tokens"];
export type TrialNodeCounts = ExperimentsTrialRecordV1["measurements"]["nodes"];

export interface CheckIo {
  spawn: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
}

/** Measurements and identity read from one autonomous run directory. */
export interface RunEvidence {
  runDir: string;
  request: Record<string, unknown>;
  providerAttempts: number;
  nodes: TrialNodeCounts;
  repairRounds: number;
  tokens: TrialTokens;
  changedPaths: number;
}

/** The final JSON object printed by `autonomous.js run --json`. */
export interface RunResultSummary {
  run_id: string;
  workspace_root: string;
  status?: string;
  report?: string;
}

export interface TrialRecordInput {
  loaded: LoadedExperiment;
  trial: PlannedTrial;
  arm: ExperimentsExperimentV1DefsArm;
  task: ExperimentsTaskSuiteV1DefsTask;
  status: TrialStatus;
  startedAt: Date;
  finishedAt: Date;
  result?: RunResultSummary | null;
  evidence?: RunEvidence | null;
  /** null when acceptance could not be evaluated. */
  acceptance?: CheckResult[] | null;
  /** null when seeded-defect detectors could not be evaluated. */
  seededDefects?: CheckResult[] | null;
  evidenceRefs?: readonly string[];
  error?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function envelopeFiles(runDir: string): string[] {
  const root = resolve(runDir, "workflow", "attempts");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(resolve(root, entry.name))
        .filter((name) => name.endsWith(".json"))
        .map((name) => resolve(root, entry.name, name)),
    )
    .sort();
}

interface SnapshotNode {
  id: string;
  kind: string;
  access: string;
  members: string[];
}

function snapshotNodes(runDir: string): SnapshotNode[] {
  const path = resolve(runDir, "workflow", "snapshot.json");
  if (!existsSync(path)) return [];
  const workflow = record(readJsonStrict(path).workflow);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  return nodes.map((value) => {
    const node = record(value);
    const loop = record(node.loop);
    return {
      id: String(node.id),
      kind: String(node.kind),
      access: String(node.access),
      members: Array.isArray(loop.members) ? loop.members.map(String) : [],
    };
  });
}

function repairMembers(nodes: readonly SnapshotNode[]): Set<string> {
  const access = new Map(nodes.map((node) => [node.id, node.access]));
  const members = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "loop") continue;
    if (!node.members.some((member) => access.get(member) === "write")) continue;
    for (const member of node.members) members.add(member);
  }
  return members;
}

function countNodes(runDir: string): TrialNodeCounts {
  const counts: TrialNodeCounts = { passed: 0, failed: 0, blocked: 0, stopped: 0, skipped: 0 };
  for (const row of graphRows(runDir)) {
    const status = row.status;
    if (typeof status === "string" && Object.hasOwn(counts, status))
      counts[status as keyof TrialNodeCounts]++;
  }
  return counts;
}

function sumTokens(envelopes: readonly Record<string, unknown>[]): TrialTokens {
  const sums: Partial<Record<(typeof TOKEN_FIELDS)[number], number>> = {};
  let measured = 0;
  let complete = 0;
  for (const envelope of envelopes) {
    const usage = record(envelope.resource_usage);
    if (usage.measurement_status === "complete") complete++;
    let numeric = false;
    for (const field of TOKEN_FIELDS) {
      const value = usage[field];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        sums[field] = (sums[field] ?? 0) + value;
        numeric = true;
      }
    }
    if (numeric) measured++;
  }
  const status: TrialTokens["measurement_status"] =
    envelopes.length > 0 && complete === envelopes.length
      ? "complete"
      : measured === 0
        ? "unavailable"
        : "partial";
  return { measurement_status: status, attempts_measured: complete, ...sums };
}

/** Same definition as the run report: tracked, staged and untracked changes outside `.pipeline`. */
function countChangedPaths(workspaceRoot: string): number {
  return changedPaths(workspaceRoot).length;
}

/** Reads request, snapshot, envelopes and Git status for one run; throws when evidence is absent. */
export function collectRunEvidence(workspaceRoot: string, runId: string): RunEvidence {
  const runDir = resolve(workspaceRoot, ".pipeline", "runs", runId);
  if (!isWithinRoot(resolve(workspaceRoot, ".pipeline", "runs"), runDir) || runId.length === 0)
    throw new Error(`run id escapes the run directory: ${runId}`);
  const request = readJsonStrict(resolve(runDir, "request.json"));
  const nodes = snapshotNodes(runDir);
  const kinds = new Map(nodes.map((node) => [node.id, node.kind]));
  const members = repairMembers(nodes);
  const envelopes = envelopeFiles(runDir).map((path) => readJsonStrict(path));
  const providerEnvelopes = envelopes.filter((envelope) => {
    const kind = kinds.get(String(envelope.node_id));
    return kind === "agent" || kind === "map";
  });
  let maxIteration = 0;
  for (const envelope of envelopes) {
    if (!members.has(String(envelope.node_id))) continue;
    const iteration = typeof envelope.loop_iteration === "number" ? envelope.loop_iteration : 1;
    maxIteration = Math.max(maxIteration, iteration);
  }
  return {
    runDir,
    request,
    providerAttempts: providerEnvelopes.length,
    nodes: countNodes(runDir),
    repairRounds: Math.max(0, Math.floor(maxIteration) - 1),
    tokens: sumTokens(providerEnvelopes),
    changedPaths: countChangedPaths(workspaceRoot),
  };
}

function tail(text: string, limit = DETAIL_CHARS): string {
  return text.length > limit ? text.slice(-limit) : text;
}

function containedPath(workspaceRoot: string, pathValue: string): string | null {
  const target = resolve(workspaceRoot, pathValue);
  return isWithinRoot(workspaceRoot, target) ? target : null;
}

async function evaluateCommand(
  check: Extract<ExperimentsTaskSuiteV1DefsCheck, { kind: "command" }>,
  workspaceRoot: string,
  io: CheckIo,
): Promise<CheckResult> {
  // Sealed allowlist: acceptance commands import agent-written code, so they must never see
  // provider credentials or proxy settings. An empty credential list selects the sealed set.
  const env = minimalChildEnvironment(process.env, workspaceRoot, []);
  const [name, ...args] = check.command;
  const executable = executableFromPath(name, env);
  if (!executable) throw new Error(`acceptance command not found: ${name}`);
  const result = await io.spawn({
    command: executable,
    args,
    cwd: workspaceRoot,
    env,
    timeoutMs: (check.timeout_seconds ?? 600) * 1000,
  });
  if (
    result.error ||
    result.signal !== null ||
    result.termination ||
    result.backgroundCleanup?.containmentUncertain
  )
    throw new Error(`acceptance command did not finish cleanly: ${check.check_id}`);
  const passed = result.status === (check.expected_exit_code ?? 0);
  const output = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const detail = output;
  return {
    check_id: check.check_id,
    kind: "command",
    passed,
    exit_code: result.status,
    ...(passed ? {} : { detail: tail(redact(detail)) }),
  };
}

function evaluatePath(
  check: Extract<ExperimentsTaskSuiteV1DefsCheck, { kind: "path-exists" | "path-absent" }>,
  workspaceRoot: string,
): CheckResult {
  const target = containedPath(workspaceRoot, check.path);
  if (!target)
    return { check_id: check.check_id, kind: check.kind, passed: false, detail: "path escapes" };
  // The leaf is inspected without following it, so a symlink to a host path cannot satisfy the
  // check; a dangling link still counts as present for path-absent purposes.
  let exists = false;
  try {
    lstatSync(target);
    exists = true;
  } catch {
    exists = false;
  }
  return {
    check_id: check.check_id,
    kind: check.kind,
    passed: check.kind === "path-exists" ? exists : !exists,
  };
}

function evaluateFile(
  check: Extract<ExperimentsTaskSuiteV1DefsCheck, { kind: "file-contains" | "file-lacks" }>,
  workspaceRoot: string,
): CheckResult {
  const fail = (detail: string): CheckResult => ({
    check_id: check.check_id,
    kind: check.kind,
    passed: false,
    detail,
  });
  const target = containedPath(workspaceRoot, check.path);
  if (!target) return fail("path escapes the workspace");
  if (!existsSync(target)) return fail("file not found");
  const real = realpathSync(target);
  if (!isWithinRoot(realpathSync(workspaceRoot), real)) return fail("path escapes the workspace");
  const stat = statSync(real);
  if (!stat.isFile()) return fail("not a regular file");
  if (stat.size > MAX_CHECK_FILE_BYTES) return fail("file exceeds 16 MiB");
  const matched = new RegExp(check.pattern, "u").test(readFileSync(real, "utf8"));
  return {
    check_id: check.check_id,
    kind: check.kind,
    passed: check.kind === "file-contains" ? matched : !matched,
  };
}

/** Evaluates acceptance checks or seeded-defect detectors inside one workspace, in order. */
export async function evaluateChecks(
  checks: readonly ExperimentsTaskSuiteV1DefsCheck[],
  workspaceRoot: string,
  io: CheckIo,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (check.kind === "command") results.push(await evaluateCommand(check, workspaceRoot, io));
    else if ("pattern" in check) results.push(evaluateFile(check, workspaceRoot));
    else results.push(evaluatePath(check, workspaceRoot));
  }
  return results;
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function nullableString(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function digestOf(value: unknown): string | undefined {
  const digest = record(value).digest;
  return typeof digest === "string" && DIGEST.test(digest) ? digest : undefined;
}

function runSection(input: TrialRecordInput): ExperimentsTrialRecordV1["run"] {
  const result = input.result;
  const request = input.evidence?.request ?? {};
  const agent = record(request.agent);
  const contextMode = record(request.context_policy).mode;
  const runtime = agent.runtime;
  const provider = boundedString(agent.provider ?? request.provider, 64);
  const run: ExperimentsTrialRecordV1["run"] = {
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    wall_clock_ms: Math.max(0, Math.round(input.finishedAt.getTime() - input.startedAt.getTime())),
  };
  if (result) {
    run.run_id = result.run_id.slice(0, 128);
    if (result.status !== undefined) run.status = result.status.slice(0, 128);
    run.workspace_root = result.workspace_root.slice(0, 4096);
    if (result.report !== undefined) run.report_path = result.report.slice(0, 4096);
  }
  if (!input.evidence) return run;
  const workflowDigest = digestOf(request.workflow);
  const policyDigest = digestOf(request.policy);
  const profileDigest = digestOf(request.execution_profile);
  if (workflowDigest) run.workflow_digest = workflowDigest;
  if (policyDigest) run.policy_digest = policyDigest;
  if (profileDigest) run.execution_profile_digest = profileDigest;
  if (contextMode === "legacy" || contextMode === "bounded") run.context_mode = contextMode;
  if (provider !== undefined) run.provider = provider;
  run.model = nullableString(agent.model, 160);
  run.reasoning_effort = nullableString(agent.reasoning_effort, 32);
  run.runtime_identity =
    runtime && typeof runtime === "object" && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>)
      : null;
  return run;
}

/**
 * Cost from operator-supplied list prices. Codex reports `cached_input_tokens` as a subset of
 * `input_tokens`, so the cached share is charged once at the cached price (or the input price when
 * no cached price is given) and the remainder at the input price. Reasoning tokens are charged
 * only when `reasoning_output_per_million` is set, because Codex already counts them inside
 * `output_tokens`.
 */
function estimatedCost(
  arm: ExperimentsExperimentV1DefsArm,
  tokens: TrialTokens,
): ExperimentsTrialRecordV1["measurements"]["estimated_cost"] {
  const pricing = arm.pricing;
  if (!pricing || tokens.measurement_status !== "complete") return null;
  const cached = Math.min(tokens.cached_input_tokens ?? 0, tokens.input_tokens ?? 0);
  const uncached = (tokens.input_tokens ?? 0) - cached;
  const value =
    (uncached * pricing.input_per_million +
      cached * (pricing.cached_input_per_million ?? pricing.input_per_million) +
      (tokens.output_tokens ?? 0) * pricing.output_per_million +
      (tokens.reasoning_output_tokens ?? 0) * (pricing.reasoning_output_per_million ?? 0)) /
    1e6;
  return { currency: pricing.currency, value, basis: "arm-pricing" };
}

function measurementsSection(input: TrialRecordInput): ExperimentsTrialRecordV1["measurements"] {
  const evidence = input.evidence;
  if (!evidence)
    return {
      provider_attempts: 0,
      nodes: { passed: 0, failed: 0, blocked: 0, stopped: 0, skipped: 0 },
      repair_rounds: 0,
      changed_paths: 0,
      tokens: { measurement_status: "unavailable", attempts_measured: 0 },
      estimated_cost: null,
    };
  return {
    provider_attempts: evidence.providerAttempts,
    nodes: { ...evidence.nodes },
    repair_rounds: evidence.repairRounds,
    changed_paths: evidence.changedPaths,
    tokens: { ...evidence.tokens },
    estimated_cost: estimatedCost(input.arm, evidence.tokens),
  };
}

function outcomeSection(input: TrialRecordInput): ExperimentsTrialRecordV1["outcome"] {
  const status = input.result?.status;
  const reached = status !== undefined && SHIP_STATES.has(status);
  const acceptance = input.status === "completed" ? (input.acceptance ?? null) : null;
  const requireAll = input.task.acceptance.require_all ?? true;
  const acceptancePass =
    acceptance === null
      ? null
      : requireAll
        ? acceptance.every((check) => check.passed)
        : acceptance.some((check) => check.passed);
  const hasDefects = (input.task.seeded_defects ?? []).length > 0;
  const seeded = input.status === "completed" ? (input.seededDefects ?? null) : null;
  const shipped =
    !hasDefects || seeded === null
      ? null
      : reached
        ? seeded.filter((check) => check.passed).length
        : 0;
  return {
    pass: acceptancePass === null ? null : reached && acceptancePass,
    reached_ship_state: reached,
    acceptance_pass: acceptancePass,
    acceptance: (acceptance ?? []).slice(0, 64),
    seeded_defects_shipped: shipped,
    seeded_defects: (seeded ?? []).slice(0, 64),
  };
}

/** Builds a trial record that always satisfies `experiments/trial-record-v1.schema.json`. */
export function buildTrialRecord(input: TrialRecordInput): ExperimentsTrialRecordV1 {
  const { loaded, trial } = input;
  const built: ExperimentsTrialRecordV1 = {
    schema_version: "1.0.0",
    experiment_id: loaded.experiment.experiment_id,
    experiment_digest: loaded.digest,
    suite_digest: loaded.suite.digest,
    trial_id: trial.trial_id,
    arm_id: trial.arm_id,
    task_id: trial.task_id,
    repetition: trial.repetition,
    sequence: trial.sequence,
    status: input.status,
    run: runSection(input),
    outcome: outcomeSection(input),
    measurements: measurementsSection(input),
    failure_layer_labels: [],
    evidence_refs: (input.evidenceRefs ?? [])
      .filter((ref) => ref.length > 0)
      .map((ref) => ref.slice(0, 4096))
      .slice(0, 256),
  };
  if (input.error !== undefined) built.error = input.error.slice(0, 8000);
  return built;
}
