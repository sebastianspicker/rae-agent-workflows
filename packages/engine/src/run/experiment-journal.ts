/** Durable, non-overwriting experiment execution receipts, separate from terminal outcomes. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  type ExperimentsTrialExecutionV1,
  type ExperimentsTrialRecordV1,
  parseContract,
} from "@rae/contracts";
import { writeExclusiveFileAtomic } from "../primitives/atomic-file.js";
import { canonicalJson } from "../workflow/workflow-contract.js";
import type { LoadedExperiment } from "./experiment-contract.js";
import type { PlannedTrial } from "./experiment-plan.js";
import { readJsonStrict } from "./state.js";

export function writeExperimentArtifact(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeExclusiveFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function trialExecutionPath(
  output: string,
  trialId: string,
  phase: "started" | "finished" | "acknowledged",
): string {
  return join(output, "execution", trialId, `${phase}.json`);
}

/** Labels can change after execution; the immutable execution digest binds everything else. */
export function trialOutcomeDigest(record: ExperimentsTrialRecordV1): string {
  const { failure_layer_labels: _labels, ...outcome } = record;
  return createHash("sha256").update(canonicalJson(outcome)).digest("hex");
}

export function startTrialExecution(
  output: string,
  loaded: LoadedExperiment,
  trial: PlannedTrial,
  inputDigest: string,
  now: Date,
): ExperimentsTrialExecutionV1 {
  const receipt = parseContract("experiments/trial-execution-v1.schema.json", {
    schema_version: "1.0.0",
    ...trial,
    experiment_id: loaded.experiment.experiment_id,
    experiment_digest: loaded.digest,
    suite_digest: loaded.suite.digest,
    input_digest: inputDigest,
    phase: "started",
    started_at: now.toISOString(),
    runner: { pid: process.pid, hostname: hostname() },
  });
  writeExperimentArtifact(trialExecutionPath(output, trial.trial_id, "started"), receipt);
  return receipt;
}

export function readTrialExecution(
  output: string,
  loaded: LoadedExperiment,
  trial: PlannedTrial,
  inputDigest: string,
  phase: "started" | "finished" | "acknowledged",
): ExperimentsTrialExecutionV1 | null {
  const path = trialExecutionPath(output, trial.trial_id, phase);
  if (!existsSync(path)) return null;
  const value = parseContract("experiments/trial-execution-v1.schema.json", readJsonStrict(path));
  if (
    value.phase !== phase ||
    value.experiment_id !== loaded.experiment.experiment_id ||
    value.experiment_digest !== loaded.digest ||
    value.suite_digest !== loaded.suite.digest ||
    value.input_digest !== inputDigest ||
    value.trial_id !== trial.trial_id ||
    value.arm_id !== trial.arm_id ||
    value.task_id !== trial.task_id ||
    value.repetition !== trial.repetition ||
    value.sequence !== trial.sequence
  )
    throw new Error(`execution receipt does not match the trial plan: ${path}`);
  return value;
}

export function finishTrialExecution(
  output: string,
  start: ExperimentsTrialExecutionV1,
  record: ExperimentsTrialRecordV1,
  now: Date,
  recovered = false,
  requiresAcknowledgment = recovered,
): ExperimentsTrialExecutionV1 {
  const receipt = parseContract("experiments/trial-execution-v1.schema.json", {
    ...start,
    phase: "finished",
    finished_at: now.toISOString(),
    elapsed_ms: recovered ? null : Math.max(0, now.getTime() - Date.parse(start.started_at)),
    record_digest: trialOutcomeDigest(record),
    recovered,
    requires_acknowledgment: requiresAcknowledgment,
  });
  writeExperimentArtifact(trialExecutionPath(output, start.trial_id, "finished"), receipt);
  return receipt;
}

/** Records the operator's explicit assertion that interrupted child processes have stopped. */
export function acknowledgeTrialExecution(
  output: string,
  start: ExperimentsTrialExecutionV1,
  record: ExperimentsTrialRecordV1,
  now: Date,
): void {
  const receipt = parseContract("experiments/trial-execution-v1.schema.json", {
    ...start,
    phase: "acknowledged",
    acknowledged_at: now.toISOString(),
    record_digest: trialOutcomeDigest(record),
  });
  writeExperimentArtifact(trialExecutionPath(output, start.trial_id, "acknowledged"), receipt);
}
