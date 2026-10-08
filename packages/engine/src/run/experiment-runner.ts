/** Executes planned trials in disposable repositories and writes one record per trial. */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type ExperimentsTrialRecordV1,
  type ExperimentsTrialExecutionV1,
  parseContract,
} from "@rae/contracts";
import {
  type BoundedProcessRequest,
  type BoundedProcessResult,
  runBoundedProcess,
} from "../agents/bounded-process.js";
import { redact } from "../agents/agent-provider-runtime.js";
import { cliAutonomousEntrypoint } from "../primitives/installation-paths.js";
import {
  experimentDefaults,
  type LoadedExperiment,
  type LoadedTaskSuite,
  type SuiteRepository,
} from "./experiment-contract.js";
import {
  buildTrialRecord,
  type CheckResult,
  collectRunEvidence,
  evaluateChecks,
  type RunEvidence,
  type RunResultSummary,
} from "./experiment-collect.js";
import { type PlannedTrial, planTrials, trialRunArguments } from "./experiment-plan.js";
import { isWithinRoot } from "../primitives/paths.js";
import { acquireExclusiveLock } from "../primitives/stale-lock.js";
import { canonicalJson } from "../workflow/workflow-contract.js";
import { fingerprintExperimentInputs, type ExperimentInputs } from "./experiment-inputs.js";
import {
  acknowledgeTrialExecution,
  finishTrialExecution,
  readTrialExecution,
  startTrialExecution,
  trialOutcomeDigest,
  writeExperimentArtifact,
} from "./experiment-journal.js";
import {
  assertTrialWorkspace,
  retainTrialEvidence,
  verifyTrialEvidence,
} from "./experiment-evidence.js";
import { readJsonStrict, writeJson } from "./state.js";

export const EXPERIMENT_MARKER = ".rae-experiment";
export const TRIAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,191}$/;
const ERROR_EXCERPT_CHARS = 2000;
const BASELINE_DATE = "2026-01-01T00:00:00Z";

export interface RunnerIo {
  spawn: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  now: () => Date;
  rm: (path: string) => void;
}

export interface RunTrialsOptions {
  outputDir: string;
  maxTrials?: number;
  dryRun?: boolean;
  cleanupWork?: boolean;
  acknowledgeInterrupted?: boolean;
  signal?: AbortSignal;
  io?: Partial<RunnerIo>;
  log?: (line: string) => void;
}

export interface ExperimentLock {
  schema_version: "1.0.0" | "2.0.0" | "3.0.0";
  execution_journal?: "1.0.0";
  inputs?: ExperimentInputs;
  experiment_id: string;
  experiment_digest: string;
  suite_digest: string;
  experiment_path: string;
  suite_path: string;
  locked_at: string;
  trials: PlannedTrial[];
}

const defaultRm = (path: string): void => rmSync(path, { recursive: true, force: true });

/** `<cwd>/.pipeline/experiments/<id>` unless the caller supplies an explicit output directory. */
export function experimentOutputDirectory(
  cwd: string,
  experimentId: string,
  override?: string,
): string {
  return override ? resolve(cwd, override) : resolve(cwd, ".pipeline", "experiments", experimentId);
}

/**
 * Allowlist guard for recursive deletes: only `<outputDir>/work/<trial_id>` of an output directory
 * carrying the experiment marker, with `work` itself not redirected through a symlink.
 */
export function isDisposableTrialWorkspace(outputDir: string, candidate: string): boolean {
  const output = resolve(outputDir);
  const target = resolve(candidate);
  const workDir = join(output, "work");
  const trialId = basename(target);
  if (!TRIAL_ID_PATTERN.test(trialId) || target !== join(workDir, trialId)) return false;
  try {
    if (!lstatSync(join(output, EXPERIMENT_MARKER)).isFile()) return false;
    return realpathSync(dirname(target)) === join(realpathSync(output), "work");
  } catch {
    return false;
  }
}

/** Deletes one trial workspace through the allowlist guard; throws when the guard refuses. */
export function removeTrialWorkspace(
  outputDir: string,
  candidate: string,
  rm: (path: string) => void = defaultRm,
): void {
  if (!isDisposableTrialWorkspace(outputDir, candidate))
    throw new Error(`refusing to delete ${candidate}: not a disposable trial workspace`);
  rm(resolve(candidate));
}

export function readExperimentLock(outputDir: string): ExperimentLock | null {
  const path = join(resolve(outputDir), "experiment.lock.json");
  if (!existsSync(path)) return null;
  return readJsonStrict(path) as unknown as ExperimentLock;
}

/** Throws when an existing lock was written for a different experiment or suite revision. */
export function assertExperimentLock(
  outputDir: string,
  loaded: LoadedExperiment,
  verifyInputs = true,
): void {
  const lock = readExperimentLock(outputDir);
  if (!lock) return;
  if (!["1.0.0", "2.0.0", "3.0.0"].includes(lock.schema_version))
    throw new Error("unsupported experiment lock version");
  if (lock.schema_version === "3.0.0" && (!lock.inputs || lock.execution_journal !== "1.0.0"))
    throw new Error("journal-enabled experiment lock is missing required provenance");
  if (canonicalJson(lock.trials) !== canonicalJson(planTrials(loaded)))
    throw new Error("experiment lock trial schedule does not match the design");
  if (verifyInputs) {
    if (lock.schema_version !== "3.0.0" || lock.execution_journal !== "1.0.0" || !lock.inputs)
      throw new Error(
        "legacy experiment lock lacks current execution-journal guarantees; retained results can be reported, but execution requires a new output directory",
      );
    const current = fingerprintExperimentInputs(loaded);
    if (canonicalJson(current) !== canonicalJson(lock.inputs))
      throw new Error(
        "experiment input drift: repository, workflow, profile or policy changed since planning; use a new experiment revision and output directory",
      );
  }
  if (lock.experiment_digest !== loaded.digest || lock.suite_digest !== loaded.suite.digest)
    throw new Error(
      `experiment lock mismatch in ${resolve(outputDir)}: locked experiment ${lock.experiment_digest} and suite ${lock.suite_digest}, current experiment ${loaded.digest} and suite ${loaded.suite.digest}; preregistration is immutable, use a new output directory or experiment revision`,
    );
}

/** Writes the marker and lock once; an existing matching lock is kept unchanged. */
export function writeExperimentLock(
  outputDir: string,
  loaded: LoadedExperiment,
  trials: readonly PlannedTrial[],
  now: Date = new Date(),
): ExperimentLock {
  const output = resolve(outputDir);
  const experimentId = loaded.experiment.experiment_id;
  mkdirSync(output, { recursive: true });
  const planningLock = acquireExclusiveLock(join(output, "plan.lock"));
  if (!planningLock)
    throw new Error("another process is planning this experiment output directory");
  try {
    const marker = join(output, EXPERIMENT_MARKER);
    if (existsSync(marker)) {
      if (readFileSync(marker, "utf8") !== `${experimentId}\n`)
        throw new Error(`${output} is marked for a different experiment`);
    } else writeFileSync(marker, `${experimentId}\n`, { encoding: "utf8", flag: "wx" });
    assertExperimentLock(output, loaded);
    const existing = readExperimentLock(output);
    if (existing) return existing;
    const lock: ExperimentLock = {
      schema_version: "3.0.0",
      execution_journal: "1.0.0",
      inputs: fingerprintExperimentInputs(loaded),
      experiment_id: experimentId,
      experiment_digest: loaded.digest,
      suite_digest: loaded.suite.digest,
      experiment_path: loaded.source,
      suite_path: loaded.suite.source,
      locked_at: now.toISOString(),
      trials: trials.map((trial) => ({ ...trial })),
    };
    writeJson(join(output, "experiment.lock.json"), lock);
    return lock;
  } finally {
    planningLock.release();
  }
}

/** Environment for materialization: the caller's, minus any GIT_* redirection of the repository. */
function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("GIT_")) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

function git(
  args: readonly string[],
  env: NodeJS.ProcessEnv = gitEnvironment(),
  timeoutMs = 120000,
): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    encoding: "utf8",
    env,
    timeout: Math.max(1, timeoutMs),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Copies or clones the suite repository into `destination` as a fresh Git repository. */
export function materializeRepository(
  suite: LoadedTaskSuite,
  repositoryId: string,
  destination: string,
  timeoutMs = 120000,
): void {
  const deadline = Date.now() + timeoutMs;
  const boundedGit = (args: readonly string[], env?: NodeJS.ProcessEnv) => {
    if (Date.now() >= deadline) throw new Error("repository materialization deadline reached");
    return git(args, env, deadline - Date.now());
  };
  const repositories = suite.suite.repositories as Record<string, SuiteRepository>;
  if (!Object.hasOwn(repositories, repositoryId))
    throw new Error(`unknown repository ${repositoryId}`);
  const repository = repositories[repositoryId];
  if (repository.kind === "git") {
    boundedGit(["clone", "--quiet", "--", repository.url, destination]);
    boundedGit(["-C", destination, "checkout", "--quiet", "--detach", repository.commit]);
    const head = boundedGit(["-C", destination, "rev-parse", "HEAD"]).trim();
    if (head !== repository.commit)
      throw new Error(
        `repository ${repositoryId} HEAD ${head} does not match ${repository.commit}`,
      );
    return;
  }
  cpSync(resolve(suite.root, repository.path), destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new Error(`repository ${repositoryId} contains symlink ${path}`);
      // A `.git` directory or gitdir pointer file must never travel into the fresh repository.
      return basename(path) !== ".git";
    },
  });
  const env = gitEnvironment({
    GIT_AUTHOR_NAME: "RAE Experiment",
    GIT_AUTHOR_EMAIL: "experiment@rae.local",
    GIT_COMMITTER_NAME: "RAE Experiment",
    GIT_COMMITTER_EMAIL: "experiment@rae.local",
    GIT_AUTHOR_DATE: BASELINE_DATE,
    GIT_COMMITTER_DATE: BASELINE_DATE,
  });
  const config = ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
  boundedGit([...config, "-C", destination, "init", "-q"], env);
  boundedGit([...config, "-C", destination, "add", "-A"], env);
  const message = `RAE experiment baseline ${suite.suite.suite_id}@${suite.suite.revision}`;
  boundedGit([...config, "-C", destination, "commit", "-q", "-m", message], env);
}

/** Parses the final JSON object: from the last line starting with `{` to the end of stdout. */
export function parseFinalRunJson(stdout: string): RunResultSummary | null {
  const lines = stdout.split("\n");
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].startsWith("{")) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(start).join("\n"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.run_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.run_id))
    return null;
  if (typeof value.workspace_root !== "string" || value.workspace_root.length === 0) return null;
  return {
    run_id: value.run_id,
    workspace_root: value.workspace_root,
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.report === "string" ? { report: value.report } : {}),
  };
}

/** Redacted, bounded failure text; records and exports are meant to be shared. */
function excerpt(result: BoundedProcessResult | null, headline: string): string {
  const text = redact(
    [headline, result?.error?.message, result?.stderr, result?.stdout]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n"),
  );
  return text.length > ERROR_EXCERPT_CHARS ? text.slice(0, ERROR_EXCERPT_CHARS) : text;
}

function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

interface TrialContext {
  loaded: LoadedExperiment;
  outputDir: string;
  io: RunnerIo;
  start: ExperimentsTrialExecutionV1;
  deadline: number;
  signal?: AbortSignal;
  stopReason?: string;
}

function trialSubjects(loaded: LoadedExperiment, trial: PlannedTrial) {
  const arm = loaded.experiment.arms.find((candidate) => candidate.arm_id === trial.arm_id);
  const task = loaded.tasks.find((candidate) => candidate.task_id === trial.task_id);
  if (!arm || !task) throw new Error(`trial ${trial.trial_id} does not match the experiment`);
  return { arm, task };
}

async function executeTrial(
  context: TrialContext,
  trial: PlannedTrial,
): Promise<ExperimentsTrialRecordV1> {
  const { loaded, outputDir, io } = context;
  const { arm, task } = trialSubjects(loaded, trial);
  const trialDir = join(outputDir, "work", trial.trial_id);
  const repositoryDir = join(trialDir, "repository");
  const stdoutRef = join("logs", `${trial.trial_id}.stdout.txt`);
  const base = { loaded, trial, arm, task };
  if (existsSync(trialDir))
    throw new Error(
      `trial workspace already exists without a retained outcome: ${trialDir}; inspect it before using a new output directory`,
    );
  mkdirSync(trialDir, { recursive: true });
  try {
    materializeRepository(
      loaded.suite,
      task.repository,
      repositoryDir,
      Math.max(1, context.deadline - io.now().getTime()),
    );
  } catch (error) {
    const now = io.now();
    return buildTrialRecord({
      ...base,
      status: "launch-failed",
      startedAt: now,
      finishedAt: now,
      error: excerpt(null, `repository materialization failed: ${errorMessage(error)}`),
    });
  }
  const startedAt = io.now();
  if (context.signal?.aborted || startedAt.getTime() >= context.deadline)
    throw new Error("trial deadline or cancellation reached before launch");
  let processResult: BoundedProcessResult;
  try {
    processResult = await io.spawn({
      command: process.execPath,
      args: [cliAutonomousEntrypoint(), ...trialRunArguments(loaded, arm, task, repositoryDir)],
      cwd: repositoryDir,
      env: process.env,
      timeoutMs: Math.max(1, context.deadline - io.now().getTime()),
      signal: context.signal,
    });
  } catch (error) {
    return buildTrialRecord({
      ...base,
      status: "launch-failed",
      startedAt,
      finishedAt: io.now(),
      error: excerpt(null, `run could not be launched: ${errorMessage(error)}`),
    });
  }
  const finishedAt = io.now();
  if (
    processResult.termination?.containmentUncertain ||
    processResult.backgroundCleanup?.containmentUncertain
  )
    context.stopReason = "containment-uncertain";
  mkdirSync(join(outputDir, "logs"), { recursive: true, mode: 0o700 });
  const logOptions = { encoding: "utf8" as const, mode: 0o600 };
  writeFileSync(join(outputDir, stdoutRef), redact(processResult.stdout), logOptions);
  writeFileSync(
    join(outputDir, "logs", `${trial.trial_id}.stderr.txt`),
    redact(processResult.stderr),
    logOptions,
  );
  const timing = { startedAt, finishedAt };
  const result = parseFinalRunJson(processResult.stdout);
  if (!result)
    return buildTrialRecord({
      ...base,
      ...timing,
      status: "launch-failed",
      evidenceRefs: [stdoutRef],
      error: excerpt(processResult, "run did not print a final JSON result"),
    });
  const evidenceRefs = [
    join(result.workspace_root, ".pipeline", "runs", result.run_id),
    ...(result.report ? [result.report] : []),
    stdoutRef,
  ];
  let evidence: RunEvidence | undefined;
  let acceptance: CheckResult[];
  let seededDefects: CheckResult[];
  try {
    if (!isWithinRoot(realpathSync(trialDir), realpathSync(result.workspace_root)))
      throw new Error("run workspace does not belong to the trial");
    evidence = collectRunEvidence(result.workspace_root, result.run_id);
    assertTrialWorkspace(
      trialDir,
      repositoryDir,
      result.workspace_root,
      evidence.request,
      task.prompt,
    );
    if (
      processResult.signal !== null ||
      processResult.error ||
      processResult.termination ||
      processResult.backgroundCleanup?.containmentUncertain
    )
      throw new Error("autonomous process did not finish cleanly; outcome is not evaluable");
    const checkIo = {
      spawn: async (request: BoundedProcessRequest) => {
        const remaining = context.deadline - io.now().getTime();
        if (context.signal?.aborted || remaining <= 0)
          throw new Error("trial deadline or cancellation reached during evaluation");
        const checked = await io.spawn({
          ...request,
          timeoutMs: Math.min(request.timeoutMs, remaining),
          signal: context.signal,
        });
        if (
          checked.termination?.containmentUncertain ||
          checked.backgroundCleanup?.containmentUncertain
        )
          context.stopReason = "containment-uncertain";
        return checked;
      },
    };
    acceptance = await evaluateChecks(task.acceptance.checks, result.workspace_root, checkIo);
    seededDefects = await evaluateChecks(
      (task.seeded_defects ?? []).map((defect) => defect.detector),
      result.workspace_root,
      checkIo,
    );
    if (context.signal?.aborted || io.now().getTime() >= context.deadline)
      throw new Error("trial deadline or cancellation reached during evaluation");
    const manifest = retainTrialEvidence(
      outputDir,
      context.start,
      result.workspace_root,
      result.run_id,
      io.now(),
    );
    evidenceRefs.splice(
      0,
      evidenceRefs.length,
      manifest,
      stdoutRef,
      join("logs", `${trial.trial_id}.stderr.txt`),
      `execution/${trial.trial_id}/started.json`,
    );
    if (context.signal?.aborted || io.now().getTime() >= context.deadline)
      throw new Error("trial deadline or cancellation reached while retaining evidence");
  } catch (error) {
    return buildTrialRecord({
      ...base,
      ...timing,
      status: "collect-failed",
      result,
      evidence,
      evidenceRefs,
      error: excerpt(null, errorMessage(error)),
    });
  }
  return buildTrialRecord({
    ...base,
    ...timing,
    status: "completed",
    result,
    evidence,
    acceptance,
    seededDefects,
    evidenceRefs,
  });
}

function retainedRecord(
  path: string,
  loaded: LoadedExperiment,
  trial: PlannedTrial,
): ExperimentsTrialRecordV1 | null {
  if (!existsSync(path)) return null;
  const record = parseContract("experiments/trial-record-v1.schema.json", readJsonStrict(path));
  if (
    record.experiment_id !== loaded.experiment.experiment_id ||
    record.experiment_digest !== loaded.digest ||
    record.suite_digest !== loaded.suite.digest ||
    record.trial_id !== trial.trial_id ||
    record.arm_id !== trial.arm_id ||
    record.task_id !== trial.task_id ||
    record.repetition !== trial.repetition ||
    record.sequence !== trial.sequence
  )
    throw new Error(`retained trial does not match the plan: ${path}`);
  return record;
}

function recordCost(record: ExperimentsTrialRecordV1): number | null {
  return record.measurements.estimated_cost?.value ?? null;
}

function logDryRun(
  loaded: LoadedExperiment,
  outputDir: string,
  trials: readonly PlannedTrial[],
  log: (line: string) => void,
): void {
  for (const trial of trials) {
    const { arm, task } = trialSubjects(loaded, trial);
    const repositoryDir = join(outputDir, "work", trial.trial_id, "repository");
    const argv = [
      cliAutonomousEntrypoint(),
      ...trialRunArguments(loaded, arm, task, repositoryDir),
    ];
    log(`${trial.trial_id}\t${trial.arm_id}\t${trial.task_id}\t${JSON.stringify(argv)}`);
  }
}

/** Runs missing trials only; every recorded outcome is retained, including infrastructure failures. */
export async function runExperiment(
  loaded: LoadedExperiment,
  options: RunTrialsOptions,
): Promise<{
  executed: string[];
  skipped: string[];
  failed: string[];
  recovered: string[];
  stop_reason: string | null;
}> {
  const io: RunnerIo = {
    spawn: options.io?.spawn ?? runBoundedProcess,
    now: options.io?.now ?? (() => new Date()),
    rm: options.io?.rm ?? defaultRm,
  };
  const log = options.log ?? (() => undefined);
  const outputDir = resolve(options.outputDir);
  const planned = planTrials(loaded);
  const trials = planned;
  const summary = {
    executed: [] as string[],
    skipped: [] as string[],
    failed: [] as string[],
    recovered: [] as string[],
    stop_reason: null as string | null,
  };
  if (options.dryRun) {
    logDryRun(
      loaded,
      outputDir,
      options.maxTrials === undefined ? trials : trials.slice(0, options.maxTrials),
      log,
    );
    return summary;
  }
  if (!existsSync(join(outputDir, EXPERIMENT_MARKER)) || !readExperimentLock(outputDir))
    throw new Error(`${outputDir} is not a planned experiment directory; run plan first`);
  assertExperimentLock(outputDir, loaded);
  const runnerLock = acquireExclusiveLock(join(outputDir, "runner.lock"));
  if (!runnerLock) throw new Error("another process owns this experiment output directory");
  try {
    const budgets = loaded.experiment.budgets ?? {};
    const started = io.now().getTime();
    const retained = new Map(
      planned.map((trial) => [
        trial.trial_id,
        retainedRecord(join(outputDir, "trials", `${trial.trial_id}.json`), loaded, trial),
      ]),
    );
    const inputDigest = readExperimentLock(outputDir)?.inputs?.digest;
    if (!inputDigest) throw new Error("execution requires an input manifest");
    let elapsed = 0;
    let unknownElapsed = false;
    const unconfirmed: { start: ExperimentsTrialExecutionV1; record: ExperimentsTrialRecordV1 }[] =
      [];
    for (const trial of planned) {
      const start = readTrialExecution(outputDir, loaded, trial, inputDigest, "started");
      let finish = readTrialExecution(outputDir, loaded, trial, inputDigest, "finished");
      let record = retained.get(trial.trial_id);
      if (finish && (!start || !record || finish.record_digest !== trialOutcomeDigest(record)))
        throw new Error(
          `terminal execution receipt does not match retained outcome: ${trial.trial_id}`,
        );
      if (start && !record) {
        const { arm, task } = trialSubjects(loaded, trial);
        record = buildTrialRecord({
          loaded,
          trial,
          arm,
          task,
          status: "collect-failed",
          startedAt: new Date(start.started_at),
          finishedAt: new Date(start.started_at),
          error:
            "Interrupted execution: a durable start exists without a terminal outcome. Usage and duration are unknown. Original workspace retained; automatic retry refused.",
          evidenceRefs: [`execution/${trial.trial_id}/started.json`],
        });
        writeExperimentArtifact(join(outputDir, "trials", `${trial.trial_id}.json`), record);
        retained.set(trial.trial_id, record);
        summary.recovered.push(trial.trial_id);
        summary.failed.push(trial.trial_id);
      }
      if (start && record && !finish) {
        finish = finishTrialExecution(outputDir, start, record, io.now(), true);
        unknownElapsed = true;
      } else if (finish) {
        if (finish.elapsed_ms === null || finish.elapsed_ms === undefined) unknownElapsed = true;
        else elapsed += finish.elapsed_ms;
      } else if (record) {
        throw new Error(`journal-enabled trial is missing its start receipt: ${trial.trial_id}`);
      }
      if (finish?.requires_acknowledgment && start && record) {
        const ack = readTrialExecution(outputDir, loaded, trial, inputDigest, "acknowledged");
        if (ack && ack.record_digest !== trialOutcomeDigest(record))
          throw new Error(`recovery acknowledgment does not match outcome: ${trial.trial_id}`);
        if (!ack) unconfirmed.push({ start, record });
      }
    }
    if (summary.recovered.length) {
      summary.stop_reason = "interrupted-trials-recovered";
      log(
        "Recovered interrupted trials as unknown outcomes; execution stopped. Inspect retained workspaces and confirm old child processes have stopped before continuing with missing trials.",
      );
      return summary;
    }
    if (unconfirmed.length && !options.acknowledgeInterrupted) {
      summary.stop_reason = "interrupted-trials-unacknowledged";
      summary.failed.push(...unconfirmed.map(({ record }) => record.trial_id));
      log(
        "Interrupted or uncertain executions require --acknowledge-interrupted after confirming child processes have stopped. No new trials launched.",
      );
      return summary;
    }
    for (const { start, record } of unconfirmed)
      acknowledgeTrialExecution(outputDir, start, record, io.now());
    let cost = [...retained.values()].reduce(
      (total, record) => total + (record ? (recordCost(record) ?? 0) : 0),
      0,
    );
    let unknownCost = [...retained.values()].some(
      (record) => record && recordCost(record) === null,
    );
    const budgetDeadline =
      budgets.max_wall_clock_seconds === undefined
        ? Infinity
        : started + Math.max(0, budgets.max_wall_clock_seconds * 1000 - elapsed);
    for (const trial of trials) {
      const recordPath = join(outputDir, "trials", `${trial.trial_id}.json`);
      const existing = retained.get(trial.trial_id);
      if (existing) {
        if (existing.status !== "completed") summary.failed.push(trial.trial_id);
        summary.skipped.push(trial.trial_id);
        log(`trial ${trial.trial_id} skipped (retained record exists)`);
        continue;
      }
      if (options.maxTrials !== undefined && summary.executed.length >= options.maxTrials) break;
      assertExperimentLock(outputDir, loaded);
      if (options.signal?.aborted) {
        summary.stop_reason = "aborted";
        break;
      }
      if (
        budgets.max_wall_clock_seconds !== undefined &&
        (unknownElapsed || io.now().getTime() >= budgetDeadline)
      ) {
        summary.stop_reason = unknownElapsed
          ? "unknown-wall-clock-usage"
          : "max-wall-clock-seconds";
        log(`budget: ${summary.stop_reason}; stopping`);
        break;
      }
      if (
        budgets.max_estimated_cost !== undefined &&
        (unknownCost || cost >= budgets.max_estimated_cost)
      ) {
        summary.stop_reason = unknownCost ? "unknown-cost-usage" : "max-estimated-cost";
        log(`budget: ${summary.stop_reason}; stopping`);
        break;
      }
      const start = startTrialExecution(outputDir, loaded, trial, inputDigest, io.now());
      const context: TrialContext = {
        loaded,
        outputDir,
        io,
        start,
        deadline: Math.min(
          budgetDeadline,
          Date.parse(start.started_at) +
            experimentDefaults(loaded.experiment).max_trial_wall_clock_seconds * 1000,
        ),
        signal: options.signal,
      };
      let record: ExperimentsTrialRecordV1;
      try {
        record = parseContract(
          "experiments/trial-record-v1.schema.json",
          await executeTrial(context, trial),
        );
      } catch (error) {
        const { arm, task } = trialSubjects(loaded, trial);
        record = buildTrialRecord({
          loaded,
          trial,
          arm,
          task,
          status: "collect-failed",
          startedAt: new Date(start.started_at),
          finishedAt: io.now(),
          error: errorMessage(error),
          evidenceRefs: [`execution/${trial.trial_id}/started.json`],
        });
      }
      let drift: unknown;
      try {
        assertExperimentLock(outputDir, loaded);
      } catch (error) {
        drift = error;
        record = {
          ...record,
          status: "collect-failed",
          error: errorMessage(error),
          outcome: {
            ...record.outcome,
            pass: null,
            acceptance_pass: null,
            seeded_defects_shipped: null,
          },
        };
      }
      writeExperimentArtifact(recordPath, record);
      finishTrialExecution(
        outputDir,
        start,
        record,
        io.now(),
        false,
        context.stopReason === "containment-uncertain",
      );
      if (drift) throw drift;
      const measuredCost = recordCost(record);
      unknownCost ||= measuredCost === null;
      cost += measuredCost ?? 0;
      summary.executed.push(trial.trial_id);
      if (record.status !== "completed") summary.failed.push(trial.trial_id);
      log(
        `trial ${trial.trial_id} ${record.status} pass=${String(record.outcome.pass)} ${record.run.wall_clock_ms}ms`,
      );
      if (options.cleanupWork && record.status === "completed") {
        if (verifyTrialEvidence(outputDir, record, inputDigest).manifests !== 1)
          throw new Error("verified retained evidence is required before cleanup");
        removeTrialWorkspace(outputDir, join(outputDir, "work", trial.trial_id), io.rm);
      }
      if (context.stopReason) {
        summary.stop_reason = context.stopReason;
        break;
      }
      if (options.signal?.aborted) {
        summary.stop_reason = "aborted";
        break;
      }
    }
    return summary;
  } finally {
    runnerLock.release();
  }
}
