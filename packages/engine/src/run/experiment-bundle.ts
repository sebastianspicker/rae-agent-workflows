/** Reproduce an exported analysis without providers, original fixtures, or arm configuration files. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseContract } from "@rae/contracts";
import { experimentDigest, suiteDigest } from "./experiment-contract.js";
import { canonicalJson } from "../workflow/workflow-contract.js";
import { planTrials } from "./experiment-plan.js";
import {
  aggregateExperiment,
  EXPERIMENT_ANALYSIS_IMPLEMENTATION,
  selectedTasks,
} from "./experiment-report.js";
import { readJsonStrict } from "./state.js";

export function analyzeExperimentBundle(directory: string) {
  const experiment = parseContract(
    "experiments/experiment-v1.schema.json",
    readJsonStrict(join(directory, "experiment.json")),
  );
  const suite = parseContract(
    "experiments/task-suite-v1.schema.json",
    readJsonStrict(join(directory, "suite.json")),
  );
  const previous = parseContract(
    "experiments/experiment-report-v2.schema.json",
    readJsonStrict(join(directory, "analysis.json")),
  );
  if (previous.analysis.implementation !== EXPERIMENT_ANALYSIS_IMPLEMENTATION)
    throw new Error(
      `analysis implementation mismatch: bundle requires ${previous.analysis.implementation}; use its original RAE revision`,
    );
  const digest = experimentDigest(experiment);
  const suiteHash = suiteDigest(suite);
  if (
    previous.experiment_digest !== digest ||
    previous.suite_digest !== suiteHash ||
    (experiment.suite.digest && experiment.suite.digest !== suiteHash)
  )
    throw new Error("analysis bundle design or suite digest mismatch");
  const lock = readJsonStrict(join(directory, "experiment.lock.json"));
  if (
    !lock ||
    typeof lock !== "object" ||
    Array.isArray(lock) ||
    !Array.isArray(lock.trials) ||
    lock.experiment_digest !== digest ||
    lock.suite_digest !== suiteHash
  )
    throw new Error("analysis bundle lock mismatch");
  if (
    canonicalJson(lock.trials) !==
    canonicalJson(planTrials({ experiment, tasks: selectedTasks(experiment, suite) }))
  )
    throw new Error("analysis bundle schedule mismatch");
  const inputs = lock.inputs;
  if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) {
    if (
      !("digest" in inputs) ||
      !("entries" in inputs) ||
      inputs.digest !== previous.input_digest ||
      experimentDigest(inputs.entries) !== inputs.digest
    )
      throw new Error("analysis bundle input manifest mismatch");
  } else if (previous.input_digest !== null)
    throw new Error("analysis bundle input manifest missing");
  const plannedTrialIds = lock.trials.map((trial) => {
    if (
      !trial ||
      typeof trial !== "object" ||
      Array.isArray(trial) ||
      typeof trial.trial_id !== "string"
    )
      throw new Error("invalid bundle trial schedule");
    return trial.trial_id;
  });
  const records = readFileSync(join(directory, "records.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => parseContract("experiments/trial-record-v1.schema.json", JSON.parse(line)));
  const report = aggregateExperiment({
    experiment,
    experimentDigest: digest,
    suite,
    suiteDigest: suiteHash,
    records,
    plannedTrialIds,
    inputDigest: previous.input_digest,
    generatedAt: previous.generated_at,
  });
  // Commands describe the original checkout; preserve them as historical provenance, not executable bundle paths.
  report.card.reproduction = previous.card.reproduction;
  if (report.records_digest !== previous.records_digest)
    throw new Error("analysis bundle trial records digest mismatch");
  return parseContract("experiments/experiment-report-v2.schema.json", report);
}
