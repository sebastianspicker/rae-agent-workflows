/** Flattens trial records into analysis-ready JSON Lines or CSV plus a datasheet. */
import type {
  ExperimentsExperimentV1,
  ExperimentsExperimentReportV2,
  ExperimentsTaskSuiteV1,
  ExperimentsTrialRecordV1,
} from "@rae/contracts";
import { selectedTasks } from "./experiment-report.js";

export type ExportFormat = "jsonl" | "csv";

export interface DatasheetInput {
  experiment: ExperimentsExperimentV1;
  experimentDigest: string;
  suite: ExperimentsTaskSuiteV1;
  suiteDigest: string;
  records: readonly ExperimentsTrialRecordV1[];
}

/** Ordered export columns with the description published in the datasheet. */
const COLUMN_DICTIONARY = [
  ["trial_id", "Unique trial identifier: arm.task.rRepetition."],
  ["experiment_id", "Identifier of the preregistered experiment."],
  ["experiment_digest", "SHA-256 of the canonical experiment design."],
  ["suite_digest", "SHA-256 of the canonical task suite."],
  ["arm_id", "Experimental arm (run configuration)."],
  ["task_id", "Task within the frozen suite."],
  ["repetition", "1-based repetition index of the (arm, task) pair."],
  ["sequence", "Planned execution order across all trials."],
  ["status", "completed, launch-failed, collect-failed or skipped."],
  ["run_id", "Autonomous run identifier; empty when no run started."],
  ["run_status", "Final status reported by the autonomous run."],
  ["provider", "Agent provider that executed the run."],
  ["model", "Model requested for the run, if any."],
  ["reasoning_effort", "Reasoning effort requested for the run, if any."],
  ["context_mode", "Context policy mode: legacy or bounded."],
  ["workflow_digest", "Digest of the workflow snapshot that ran."],
  ["policy_digest", "Digest of the policy that ran."],
  ["execution_profile_digest", "Digest of the execution profile that ran."],
  ["started_at", "UTC start of the launch."],
  ["finished_at", "UTC end of the launch."],
  ["wall_clock_ms", "Launch duration in milliseconds, excluding acceptance checks."],
  ["pass", "True when the run reached a ship state and acceptance passed; empty when unknown."],
  ["reached_ship_state", "True when the run ended in a ship-ready state."],
  ["acceptance_pass", "Result of the task acceptance checks; empty when not evaluated."],
  [
    "seeded_defects_shipped",
    "Seeded defects still present in a shipped result; empty if none seeded.",
  ],
  ["provider_attempts", "Agent and map node attempts."],
  ["nodes_passed", "Workflow node instances that passed."],
  ["nodes_failed", "Workflow node instances that failed."],
  ["nodes_blocked", "Workflow node instances that were blocked."],
  ["nodes_stopped", "Workflow node instances that were stopped."],
  ["nodes_skipped", "Workflow node instances that were skipped."],
  ["repair_rounds", "Repair iterations beyond the first write attempt."],
  ["changed_paths", "Paths changed in the worktree."],
  ["tokens_measurement_status", "complete, partial or unavailable token measurement."],
  ["input_tokens", "Summed input tokens; empty when never reported."],
  ["cached_input_tokens", "Summed cached input tokens; empty when never reported."],
  ["output_tokens", "Summed output tokens; empty when never reported."],
  ["reasoning_output_tokens", "Summed reasoning output tokens; empty when never reported."],
  ["total_tokens", "input_tokens + output_tokens, only when measurement is complete."],
  ["estimated_cost", "Cost derived from arm pricing; empty unless tokens were complete."],
  ["estimated_cost_currency", "ISO 4217 currency of estimated_cost."],
  ["failure_layer_labels", "JSON array of rater labels (rater, layer, note, labeled_at)."],
  ["error", "Error excerpt for failed trials."],
] as const;

export const EXPORT_COLUMNS = COLUMN_DICTIONARY.map(([column]) => column);

export type ExportColumn = (typeof COLUMN_DICTIONARY)[number][0];
export type ExportValue = string | number | boolean | null;
export type ExportRow = Record<ExportColumn, ExportValue>;

/** One flat row per record; absent values are null. */
export function flattenTrialRecord(record: ExperimentsTrialRecordV1): ExportRow {
  const { run, outcome, measurements } = record;
  const tokens = measurements.tokens;
  const total =
    tokens.measurement_status === "complete"
      ? (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0)
      : null;
  return {
    trial_id: record.trial_id,
    experiment_id: record.experiment_id,
    experiment_digest: record.experiment_digest,
    suite_digest: record.suite_digest,
    arm_id: record.arm_id,
    task_id: record.task_id,
    repetition: record.repetition,
    sequence: record.sequence,
    status: record.status,
    run_id: run.run_id ?? null,
    run_status: run.status ?? null,
    provider: run.provider ?? null,
    model: run.model ?? null,
    reasoning_effort: run.reasoning_effort ?? null,
    context_mode: run.context_mode ?? null,
    workflow_digest: run.workflow_digest ?? null,
    policy_digest: run.policy_digest ?? null,
    execution_profile_digest: run.execution_profile_digest ?? null,
    started_at: run.started_at,
    finished_at: run.finished_at,
    wall_clock_ms: run.wall_clock_ms,
    pass: outcome.pass,
    reached_ship_state: outcome.reached_ship_state,
    acceptance_pass: outcome.acceptance_pass,
    seeded_defects_shipped: outcome.seeded_defects_shipped,
    provider_attempts: measurements.provider_attempts,
    nodes_passed: measurements.nodes.passed,
    nodes_failed: measurements.nodes.failed,
    nodes_blocked: measurements.nodes.blocked,
    nodes_stopped: measurements.nodes.stopped,
    nodes_skipped: measurements.nodes.skipped,
    repair_rounds: measurements.repair_rounds,
    changed_paths: measurements.changed_paths,
    tokens_measurement_status: tokens.measurement_status,
    input_tokens: tokens.input_tokens ?? null,
    cached_input_tokens: tokens.cached_input_tokens ?? null,
    output_tokens: tokens.output_tokens ?? null,
    reasoning_output_tokens: tokens.reasoning_output_tokens ?? null,
    total_tokens: total,
    estimated_cost: measurements.estimated_cost?.value ?? null,
    estimated_cost_currency: measurements.estimated_cost?.currency ?? null,
    failure_layer_labels: JSON.stringify(record.failure_layer_labels),
    error: record.error ?? null,
  };
}

function csvField(value: ExportValue): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows sorted by sequence; JSONL has one object per line, CSV has a header and RFC 4180 quoting. */
export function exportTrials(
  records: readonly ExperimentsTrialRecordV1[],
  format: ExportFormat,
): string {
  const rows = [...records]
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.trial_id.localeCompare(right.trial_id),
    )
    .map(flattenTrialRecord);
  if (format === "jsonl") return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of rows)
    lines.push(EXPORT_COLUMNS.map((column) => csvField(row[column])).join(","));
  return `${lines.join("\n")}\n`;
}

function cell(text: string | number | undefined): string {
  return String(text ?? "")
    .replaceAll("|", "\\|")
    .replaceAll(/\s*\n\s*/g, " ");
}

function describeRun(run: Record<string, unknown>): string {
  const entries = Object.entries(run).map(
    ([key, value]) => `${key}=${Array.isArray(value) ? value.join(" ") : String(value)}`,
  );
  return entries.length === 0 ? "defaults" : entries.join("; ");
}

export function renderDatasheet(input: DatasheetInput): string {
  const { experiment, suite, records } = input;
  const tasks = selectedTasks(experiment, suite);
  const { hypothesis, design } = experiment;
  const statusCounts = new Map<string, number>();
  for (const record of records)
    statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
  const lines: string[] = [`# Datasheet: ${experiment.title}`, ""];

  lines.push("## Motivation", "");
  lines.push(
    `Hypothesis${hypothesis.claim_id ? ` (${hypothesis.claim_id})` : ""}: ${hypothesis.statement}`,
  );
  lines.push(
    "",
    `Expected: ${hypothesis.expected} for ${hypothesis.treatment_arm} versus ${hypothesis.control_arm} on ${experiment.metrics.primary}. Falsifier: ${hypothesis.falsifier}`,
    "",
  );

  lines.push("## Composition", "");
  lines.push(
    `Suite ${suite.suite_id} revision ${suite.revision} (digest ${input.suiteDigest}) with ${tasks.length} selected tasks of ${suite.tasks.length}.`,
    "",
  );
  lines.push("| task_id | title | difficulty | tags | repository | checks | seeded defects |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const task of tasks)
    lines.push(
      `| ${cell(task.task_id)} | ${cell(task.title)} | ${cell(task.difficulty ?? "")} | ${cell((task.tags ?? []).join(", "))} | ${cell(task.repository)} | ${task.acceptance.checks.length} | ${(task.seeded_defects ?? []).length} |`,
    );
  lines.push("");

  lines.push("## Collection process", "");
  lines.push("| arm_id | label | run options |", "| --- | --- | --- |");
  for (const arm of experiment.arms)
    lines.push(`| ${cell(arm.arm_id)} | ${cell(arm.label)} | ${cell(describeRun(arm.run))} |`);
  lines.push("");
  lines.push(
    `Design: ${design.repetitions} repetitions, order ${design.order ?? "interleaved"}, seed ${design.seed}, paired ${design.paired !== false}.`,
    "",
  );
  lines.push(
    `Records: ${records.length} (${["completed", "launch-failed", "collect-failed", "skipped"].map((status) => `${status} ${statusCounts.get(status) ?? 0}`).join(", ")}).`,
    "",
  );

  lines.push("## Analysis bundle", "");
  lines.push(
    "The all-format export includes analysis.json (report v2), tasks.csv (arm/task/metric denominators and means), records.jsonl (full trial records), experiment.json, suite.json and experiment.lock.json.",
    "",
  );
  lines.push(
    "Reproduce offline with `npm run rae -- experiment analyze --bundle <export-directory>`. This validates content digests and needs the same RAE implementation but no provider or original input directories. It does not archive repositories, worktree evidence, logs or provider implementations. Preserve the RAE source revision and runtime version separately.",
    "",
  );
  lines.push(
    `Analysis unit: ${experiment.analysis.unit ?? "task"}. Task mode weights task means equally; the flat trial table is trial-weighted if pooled directly. Missing primary outcomes withhold the confirmatory verdict; complete-case results remain exploratory.`,
    "",
  );
  lines.push("## Preprocessing", "");
  lines.push("- One row per trial record of any status, sorted by sequence.");
  lines.push(
    "- Missing or not applicable values are null in JSONL and empty in CSV; they are never imputed.",
  );
  lines.push(
    "- Booleans are true/false; failure_layer_labels is a JSON string of the label array.",
  );
  lines.push(
    "- total_tokens is input_tokens + output_tokens only when token measurement is complete, otherwise null.",
  );
  lines.push(
    "- estimated_cost is null unless the arm declares pricing and token measurement is complete.",
    "",
  );

  lines.push("## Uses", "");
  lines.push("- Intended: comparing the arms of this experiment on this frozen suite.");
  lines.push("- Not intended: ranking general capability of models or agents.", "");

  lines.push("## Distribution", "");
  lines.push(`- License: ${suite.provenance.license}`);
  lines.push(`- Contamination note: ${suite.provenance.contamination_note}`);
  lines.push(`- Authors: ${suite.provenance.authors.join(", ")}`);
  lines.push(`- Sources: ${(suite.provenance.sources ?? []).join(", ") || "none listed"}`, "");

  lines.push("## Maintenance", "");
  lines.push(`- Experiment ${experiment.experiment_id} revision ${experiment.revision}`);
  lines.push(`- Experiment digest: ${input.experimentDigest}`);
  lines.push(`- Suite digest: ${input.suiteDigest}`, "");

  lines.push("## Column dictionary", "");
  for (const [column, description] of COLUMN_DICTIONARY)
    lines.push(`- \`${column}\`: ${description}`);
  lines.push("");
  return lines.join("\n");
}

/** One row per arm/task/metric, including tasks with no observed outcomes. */
export function exportTaskResults(report: ExperimentsExperimentReportV2): string {
  const columns = ["arm_id", "task_id", "metric", "planned", "observed", "mean"] as const;
  return `${columns.join(",")}\n${report.task_results.map((row) => columns.map((key) => csvField(row[key])).join(",")).join("\n")}\n`;
}
