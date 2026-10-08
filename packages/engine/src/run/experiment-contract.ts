/** Loads preregistered experiments and frozen task suites with semantic checks and digests. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type ExperimentsExperimentV1,
  type ExperimentsExperimentV1DefsMetricName,
  type ExperimentsTaskSuiteV1,
  type ExperimentsTaskSuiteV1DefsCheck,
  type ExperimentsTaskSuiteV1DefsTask,
  parseContract,
} from "@rae/contracts";
import { repositoryRoot } from "../primitives/installation-paths.js";
import { isWithinRoot } from "../primitives/paths.js";
import { canonicalJson } from "../workflow/workflow-contract.js";

const MAX_CONTRACT_BYTES = 1024 * 1024;

export type SuiteRepository =
  | { kind: "directory"; path: string; description?: string }
  | { kind: "git"; url: string; commit: string; description?: string };

export interface LoadedTaskSuite {
  suite: ExperimentsTaskSuiteV1;
  digest: string;
  /** Absolute, symlink-free path of the suite file. */
  source: string;
  /** Directory containing the suite file; `directory` repositories resolve below it. */
  root: string;
}

export interface LoadedExperiment {
  experiment: ExperimentsExperimentV1;
  digest: string;
  /** Absolute, symlink-free path of the experiment file. */
  source: string;
  /** Directory containing the experiment file; arm run paths resolve below it. */
  root: string;
  suite: LoadedTaskSuite;
  /** Selected suite tasks, in suite order. */
  tasks: ExperimentsTaskSuiteV1DefsTask[];
}

export interface ExperimentDefaults {
  order: "interleaved" | "sequential";
  paired: boolean;
  max_trial_wall_clock_seconds: number;
  bootstrap_samples: number;
  permutation_samples: number;
  correction: "none" | "holm";
  secondary: ExperimentsExperimentV1DefsMetricName[];
  pass_at_k: number[];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Canonical preregistration identity of an experiment document. */
export function experimentDigest(value: unknown): string {
  return sha256(value);
}

/** Canonical identity of a frozen task suite document. */
export function suiteDigest(value: unknown): string {
  return sha256(value);
}

export function experimentDefaults(experiment: ExperimentsExperimentV1): ExperimentDefaults {
  return {
    order: experiment.design.order ?? "interleaved",
    paired: experiment.design.paired ?? true,
    max_trial_wall_clock_seconds: experiment.design.max_trial_wall_clock_seconds ?? 7200,
    bootstrap_samples: experiment.analysis.bootstrap_samples ?? 10000,
    permutation_samples: experiment.analysis.permutation_samples ?? 10000,
    correction: experiment.analysis.correction ?? "holm",
    secondary: experiment.metrics.secondary ?? [],
    pass_at_k: experiment.metrics.pass_at_k ?? [],
  };
}

function readContractDocument(pathValue: string, fail: (message: string) => Error): unknown {
  const supplied = resolve(pathValue);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(supplied);
  } catch {
    throw fail(`file not found: ${supplied}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw fail("path must be a regular non-symlink file");
  if (stat.size > MAX_CONTRACT_BYTES) throw fail(`file exceeds ${MAX_CONTRACT_BYTES} bytes`);
  if (realpathSync(supplied) !== supplied) throw fail("path must not traverse symlinks");
  try {
    return JSON.parse(readFileSync(supplied, "utf8"));
  } catch (error) {
    throw fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function suiteError(message: string): Error {
  return new Error(`task suite contract: ${message}`);
}

function experimentError(message: string): Error {
  return new Error(`experiment contract: ${message}`);
}

function assertUnique(values: readonly string[], label: string, fail: (m: string) => Error): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw fail(`duplicate ${label} ${value}`);
    seen.add(value);
  }
}

function assertCheckPattern(check: ExperimentsTaskSuiteV1DefsCheck, owner: string): void {
  if (check.kind !== "file-contains" && check.kind !== "file-lacks") return;
  try {
    new RegExp(check.pattern, "u");
  } catch (error) {
    throw suiteError(
      `${owner} check ${check.check_id} has an invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertDirectoryRepository(root: string, id: string, pathValue: string): void {
  const target = resolve(root, pathValue);
  if (!isWithinRoot(root, target)) throw suiteError(`repository ${id} escapes the suite root`);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw suiteError(`repository ${id} directory does not exist: ${pathValue}`);
  }
  if (!isWithinRoot(root, real)) throw suiteError(`repository ${id} escapes the suite root`);
  if (!statSync(real).isDirectory())
    throw suiteError(`repository ${id} is not a directory: ${pathValue}`);
}

/** Remote transports only: `https://`, `ssh://`, `git://` or scp-like `user@host:path`. */
const GIT_URL_PATTERN =
  /^(?:https:\/\/|ssh:\/\/|git:\/\/)[^\s]+$|^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

function assertGitRepository(id: string, url: string): void {
  if (url.startsWith("-") || !GIT_URL_PATTERN.test(url))
    throw suiteError(
      `repository ${id} url must be an https://, ssh://, git:// or user@host:path remote`,
    );
}

function validateSuiteSemantics(suite: ExperimentsTaskSuiteV1, root: string): void {
  const repositories = suite.repositories as Record<string, SuiteRepository>;
  for (const [id, repository] of Object.entries(repositories)) {
    if (repository.kind === "directory") assertDirectoryRepository(root, id, repository.path);
    else assertGitRepository(id, repository.url);
  }
  assertUnique(
    suite.tasks.map((task) => task.task_id),
    "task_id",
    suiteError,
  );
  for (const task of suite.tasks) {
    if (!Object.hasOwn(repositories, task.repository))
      throw suiteError(`task ${task.task_id} references unknown repository ${task.repository}`);
    if (task.prompt.trimStart().startsWith("-"))
      throw suiteError(
        `task ${task.task_id} prompt must not start with "-" (it would parse as a flag)`,
      );
    assertUnique(
      task.acceptance.checks.map((check) => check.check_id),
      `check_id in task ${task.task_id}:`,
      suiteError,
    );
    for (const check of task.acceptance.checks) assertCheckPattern(check, `task ${task.task_id}`);
    for (const defect of task.seeded_defects ?? [])
      assertCheckPattern(defect.detector, `task ${task.task_id} seeded defect ${defect.defect_id}`);
  }
}

/** Reads, validates and digests a frozen task suite. */
export function loadTaskSuite(pathValue: string): LoadedTaskSuite {
  const source = resolve(pathValue);
  const document = readContractDocument(source, suiteError);
  let suite: ExperimentsTaskSuiteV1;
  try {
    suite = parseContract("experiments/task-suite-v1.schema.json", document);
  } catch (error) {
    throw suiteError(error instanceof Error ? error.message : String(error));
  }
  const root = dirname(source);
  validateSuiteSemantics(suite, root);
  return { suite, digest: suiteDigest(suite), source, root };
}

function resolveSuitePath(experiment: ExperimentsExperimentV1, root: string): string {
  const target = resolve(root, experiment.suite.path);
  if (!isWithinRoot(root, target) && !isWithinRoot(repositoryRoot, target))
    throw experimentError(
      "suite.path must resolve inside the experiment directory or the repository",
    );
  return target;
}

function selectTasks(
  experiment: ExperimentsExperimentV1,
  suite: ExperimentsTaskSuiteV1,
): ExperimentsTaskSuiteV1DefsTask[] {
  const known = new Set(suite.tasks.map((task) => task.task_id));
  for (const taskId of experiment.suite.task_ids ?? [])
    if (!known.has(taskId)) throw experimentError(`suite.task_ids names unknown task ${taskId}`);
  const ids = experiment.suite.task_ids ? new Set(experiment.suite.task_ids) : null;
  const tags = experiment.suite.tags ? new Set(experiment.suite.tags) : null;
  const tasks = suite.tasks.filter(
    (task) =>
      (!ids || ids.has(task.task_id)) && (!tags || (task.tags ?? []).some((tag) => tags.has(tag))),
  );
  if (tasks.length === 0) throw experimentError("task selection is empty");
  return tasks;
}

function assertArmFile(root: string, armId: string, field: string, pathValue: string): void {
  const target = resolve(root, pathValue);
  let regular = false;
  try {
    const stat = lstatSync(target);
    regular = stat.isFile() && !stat.isSymbolicLink() && realpathSync(target) === target;
  } catch {
    regular = false;
  }
  if (!regular)
    throw experimentError(
      `arm ${armId} ${field} is not a regular, symlink-free file: ${pathValue}`,
    );
}

function validateArms(experiment: ExperimentsExperimentV1, root: string): void {
  const armIds = experiment.arms.map((arm) => arm.arm_id);
  assertUnique(armIds, "arm_id", experimentError);
  const { treatment_arm: treatment, control_arm: control } = experiment.hypothesis;
  if (!armIds.includes(treatment))
    throw experimentError(`hypothesis.treatment_arm ${treatment} is not an arm`);
  if (!armIds.includes(control))
    throw experimentError(`hypothesis.control_arm ${control} is not an arm`);
  if (treatment === control)
    throw experimentError("hypothesis.treatment_arm and control_arm must differ");
  for (const arm of experiment.arms) {
    if (arm.run.workflow) assertArmFile(root, arm.arm_id, "workflow", arm.run.workflow);
    if (arm.run.execution_profile)
      assertArmFile(root, arm.arm_id, "execution_profile", arm.run.execution_profile);
    if (arm.run.policy) assertArmFile(root, arm.arm_id, "policy", arm.run.policy);
    if (arm.run.provider === "command") {
      if (arm.run.allow_unsafe_command_provider !== true)
        throw experimentError(
          `arm ${arm.arm_id} uses the command provider without allow_unsafe_command_provider`,
        );
      if (!arm.run.agent_command)
        throw experimentError(`arm ${arm.arm_id} uses the command provider without agent_command`);
    }
  }
}

function validateMetrics(
  experiment: ExperimentsExperimentV1,
  tasks: readonly ExperimentsTaskSuiteV1DefsTask[],
): void {
  if ((experiment.analysis.unit ?? "task") === "task" && experiment.design.paired === false)
    throw experimentError(
      "task-level analysis requires paired=true because arms share the same tasks; use analysis.unit=trial for legacy unpaired inference",
    );
  if (
    experiment.analysis.minimum_detectable_effect !== undefined &&
    experiment.analysis.minimum_detectable_effect < 0
  )
    throw experimentError("minimum_detectable_effect must be non-negative");
  if (
    experiment.metrics.primary === "estimated_cost" ||
    experiment.metrics.secondary?.includes("estimated_cost") ||
    experiment.budgets?.max_estimated_cost !== undefined
  ) {
    if (experiment.arms.some((arm) => !arm.pricing))
      throw experimentError("cost analysis and budgets require pricing on every arm");
    if (new Set(experiment.arms.map((arm) => arm.pricing?.currency)).size !== 1)
      throw experimentError("cost analysis and budgets require a common currency");
  }
  for (const k of experiment.metrics.pass_at_k ?? [])
    if (k > experiment.design.repetitions)
      throw experimentError(
        `metrics.pass_at_k value ${k} exceeds design.repetitions ${experiment.design.repetitions}`,
      );
  const metrics = [experiment.metrics.primary, ...(experiment.metrics.secondary ?? [])];
  if (
    metrics.includes("seeded_defects_shipped") &&
    !tasks.some((task) => (task.seeded_defects ?? []).length > 0)
  )
    throw experimentError("seeded_defects_shipped requires a selected task with seeded_defects");
}

/** Reads, validates and digests a preregistered experiment together with its suite. */
export function loadExperiment(pathValue: string): LoadedExperiment {
  const source = resolve(pathValue);
  const document = readContractDocument(source, experimentError);
  let experiment: ExperimentsExperimentV1;
  try {
    experiment = parseContract("experiments/experiment-v1.schema.json", document);
  } catch (error) {
    throw experimentError(error instanceof Error ? error.message : String(error));
  }
  const root = dirname(source);
  validateArms(experiment, root);
  const suite = loadTaskSuite(resolveSuitePath(experiment, root));
  if (experiment.suite.digest !== undefined && experiment.suite.digest !== suite.digest)
    throw experimentError(
      `suite digest mismatch (preregistered ${experiment.suite.digest}, actual ${suite.digest})`,
    );
  const tasks = selectTasks(experiment, suite.suite);
  validateMetrics(experiment, tasks);
  return { experiment, digest: experimentDigest(experiment), source, root, suite, tasks };
}
