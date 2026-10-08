/**
 * Aggregates trial records into a reproducible experiment report and benchmark card.
 *
 * Every function here is pure: no filesystem, no clock beyond the optional `generatedAt` default,
 * and every random stream is derived from the preregistered seed, so the same records and seed
 * always yield the same report (except `generated_at`).
 */
import { createHash } from "node:crypto";
import type {
  ExperimentsExperimentReportV2,
  ExperimentsExperimentReportV2DefsArmSummary,
  ExperimentsExperimentReportV2DefsComparison,
  ExperimentsExperimentReportV2DefsInterval,
  ExperimentsExperimentReportV2DefsMetricName,
  ExperimentsExperimentReportV2DefsProportion,
  ExperimentsExperimentV1,
  ExperimentsTaskSuiteV1,
  ExperimentsTaskSuiteV1DefsTask,
  ExperimentsTrialRecordV1,
} from "@rae/contracts";
import { planTrials } from "./experiment-plan.js";
import { canonicalJson } from "../workflow/workflow-contract.js";
import {
  bootstrapDifferenceInterval,
  bootstrapMeanInterval,
  cliffsDelta,
  cohensKappa,
  createSeededRandom,
  deriveSeed,
  holmBonferroni,
  mcnemarExactTest,
  mean,
  median,
  pairedPermutationTest,
  passAtK,
  standardDeviation,
  unpairedPermutationTest,
  wilsonInterval,
} from "./experiment-statistics.js";

/** Bump when estimators, missingness policy or multiplicity semantics change. */
export const EXPERIMENT_ANALYSIS_IMPLEMENTATION = "rae-experiment-analysis/2.0.0";

export interface AggregateInput {
  experiment: ExperimentsExperimentV1;
  experimentDigest: string;
  suite: ExperimentsTaskSuiteV1;
  suiteDigest: string;
  records: readonly ExperimentsTrialRecordV1[];
  plannedTrialIds: readonly string[];
  /** ISO-8601 UTC timestamp; defaults to now. */
  generatedAt?: string;
  /** Fingerprint of the locked repository and arm inputs; null for legacy locks. */
  inputDigest?: string | null;
  /** Experiment file path as shown in the reproduction commands (caller makes it repo-relative). */
  experimentPath?: string;
  /** Output directory as shown in the reproduction commands. */
  outputPath?: string;
}

export type MetricName = ExperimentsExperimentReportV2DefsMetricName;
type Comparison = ExperimentsExperimentReportV2DefsComparison;
type TrialRecord = ExperimentsTrialRecordV1;

export interface ContinuousSummary {
  n: number;
  mean: number | null;
  median: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
  ci_low: number | null;
  ci_high: number | null;
  method: "bootstrap-percentile";
}

export interface ComparisonSettings {
  alpha: number;
  bootstrapSamples: number;
  permutationSamples: number;
  seed: number;
  paired: boolean;
  unit?: "task" | "trial";
}

export const PROPORTION_METRICS: readonly MetricName[] = [
  "pass_rate",
  "ship_rate",
  "acceptance_rate",
];

export function isProportionMetric(metric: MetricName): boolean {
  return PROPORTION_METRICS.includes(metric);
}

function flag(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

/** Numeric value of a metric for one trial (booleans as 0/1); null when not evaluable. */
export function trialMetricValue(record: TrialRecord, metric: MetricName): number | null {
  const { outcome, measurements, run } = record;
  switch (metric) {
    case "pass_rate":
      return flag(outcome.pass);
    case "ship_rate":
      return flag(outcome.reached_ship_state);
    case "acceptance_rate":
      return flag(outcome.acceptance_pass);
    case "wall_clock_ms":
      return run.wall_clock_ms;
    case "provider_attempts":
      return measurements.provider_attempts;
    case "repair_rounds":
      return measurements.repair_rounds;
    case "changed_paths":
      return measurements.changed_paths;
    case "total_tokens": {
      const tokens = measurements.tokens;
      if (tokens.measurement_status !== "complete") return null;
      return (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0);
    }
    case "output_tokens":
      return measurements.tokens.measurement_status === "complete"
        ? (measurements.tokens.output_tokens ?? null)
        : null;
    case "estimated_cost":
      return measurements.estimated_cost?.value ?? null;
    case "seeded_defects_shipped":
      return outcome.seeded_defects_shipped;
  }
}

/** Tasks the experiment actually uses, in suite order (task_ids and tags both narrow). */
export function selectedTasks(
  experiment: ExperimentsExperimentV1,
  suite: ExperimentsTaskSuiteV1,
): ExperimentsTaskSuiteV1DefsTask[] {
  const { task_ids: taskIds, tags } = experiment.suite;
  return suite.tasks.filter(
    (task) =>
      (taskIds === undefined || taskIds.includes(task.task_id)) &&
      (tags === undefined || (task.tags ?? []).some((tag) => tags.includes(tag))),
  );
}

function summarize(
  values: readonly number[],
  seedLabel: string,
  settings: ComparisonSettings,
): ContinuousSummary {
  const interval = bootstrapMeanInterval(values, {
    samples: settings.bootstrapSamples,
    alpha: settings.alpha,
    random: createSeededRandom(deriveSeed(settings.seed, seedLabel)),
  });
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    sd: standardDeviation(values),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
    ci_low: interval.ci_low,
    ci_high: interval.ci_high,
    method: "bootstrap-percentile",
  };
}

function evaluable(
  records: readonly TrialRecord[],
  metric: MetricName,
  unit: "task" | "trial" = "trial",
): number[] {
  if (unit === "task") return taskMeans(records, metric);
  const values: number[] = [];
  for (const record of records) {
    const value = trialMetricValue(record, metric);
    if (value !== null) values.push(value);
  }
  return values;
}

/** Equal task weights prevent repeated attempts on one task from masquerading as new tasks. */
function taskMeans(records: readonly TrialRecord[], metric: MetricName): number[] {
  const groups = new Map<string, number[]>();
  for (const record of records) {
    const value = trialMetricValue(record, metric);
    if (value === null) continue;
    const group = groups.get(record.task_id) ?? [];
    group.push(value);
    groups.set(record.task_id, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, values]) => mean(values) as number);
}

function proportionOf(
  records: readonly TrialRecord[],
  metric: MetricName,
  settings: ComparisonSettings,
  label: string,
): ExperimentsExperimentReportV2DefsProportion {
  const values = evaluable(records, metric);
  const successes = values.filter((value) => value === 1).length;
  const units = evaluable(records, metric, settings.unit);
  const interval =
    settings.unit === "task"
      ? bootstrapMeanInterval(units, {
          samples: settings.bootstrapSamples,
          alpha: settings.alpha,
          random: createSeededRandom(deriveSeed(settings.seed, label)),
        })
      : wilsonInterval(successes, values.length, settings.alpha);
  return {
    successes,
    trials: values.length,
    estimate: interval.estimate,
    ci_low: interval.ci_low,
    ci_high: interval.ci_high,
    method: settings.unit === "task" ? "task-bootstrap-percentile" : "wilson",
    units: units.length,
  };
}

function bySequence(left: TrialRecord, right: TrialRecord): number {
  return left.sequence - right.sequence || left.trial_id.localeCompare(right.trial_id);
}

function pairKey(record: TrialRecord): string {
  return `${record.task_id}#${record.repetition}`;
}

function byPairKey(left: TrialRecord, right: TrialRecord): number {
  return (
    left.task_id.localeCompare(right.task_id) ||
    left.repetition - right.repetition ||
    left.trial_id.localeCompare(right.trial_id)
  );
}

function noComparison(
  armId: string,
  controlId: string,
  metric: MetricName,
  paired: boolean,
  n: number,
  coverage: Pick<Comparison, "arm_observed" | "control_observed" | "matched_trials" | "unit">,
): Comparison {
  return {
    ...coverage,
    arm: armId,
    control: controlId,
    metric,
    paired,
    n,
    difference: { estimate: null, ci_low: null, ci_high: null, method: "bootstrap-percentile" },
    test: "none",
    p_value: null,
    p_value_adjusted: null,
    effect_size: {
      name: isProportionMetric(metric) ? "risk-difference" : "cliffs-delta",
      value: null,
    },
    significant: false,
  };
}

/**
 * Compares one arm against the control on one metric. `p_value_adjusted` equals `p_value` and
 * `significant` is false here; `aggregateExperiment` applies the multiplicity correction.
 */
export function compareArms(
  armId: string,
  armRecords: readonly TrialRecord[],
  controlId: string,
  controlRecords: readonly TrialRecord[],
  metric: MetricName,
  settings: ComparisonSettings,
): Comparison {
  const proportion = isProportionMetric(metric);
  const withValue = (records: readonly TrialRecord[]) =>
    records
      .filter((record) => trialMetricValue(record, metric) !== null)
      .sort(settings.paired ? byPairKey : bySequence);
  const armEvaluable = withValue(armRecords);
  const controlEvaluable = withValue(controlRecords);
  const metricValue = (record: TrialRecord) => trialMetricValue(record, metric) as number;

  let armValues: number[];
  let controlValues: number[];
  let matchedTrials = 0;
  if (settings.paired) {
    const controlByKey = new Map(controlEvaluable.map((record) => [pairKey(record), record]));
    const pairs = armEvaluable.flatMap((record) => {
      const match = controlByKey.get(pairKey(record));
      return match ? [[record, match] as const] : [];
    });
    matchedTrials = pairs.length;
    armValues =
      settings.unit === "task"
        ? taskMeans(
            pairs.map(([record]) => record),
            metric,
          )
        : pairs.map(([record]) => metricValue(record));
    controlValues =
      settings.unit === "task"
        ? taskMeans(
            pairs.map(([, record]) => record),
            metric,
          )
        : pairs.map(([, match]) => metricValue(match));
  } else {
    armValues = evaluable(armEvaluable, metric, settings.unit);
    controlValues = evaluable(controlEvaluable, metric, settings.unit);
  }
  const n = settings.paired ? armValues.length : Math.min(armValues.length, controlValues.length);
  const coverage = {
    arm_observed: armEvaluable.length,
    control_observed: controlEvaluable.length,
    matched_trials: matchedTrials,
    unit: settings.unit ?? "trial",
  };
  if (n < 2) return noComparison(armId, controlId, metric, settings.paired, n, coverage);

  const label = `${armId}:${controlId}:${metric}`;
  const testRandom = createSeededRandom(deriveSeed(settings.seed, `${label}:test`));
  const ciRandom = createSeededRandom(deriveSeed(settings.seed, `${label}:ci`));
  const interval = bootstrapDifferenceInterval(armValues, controlValues, {
    samples: settings.bootstrapSamples,
    alpha: settings.alpha,
    random: ciRandom,
    paired: settings.paired,
  });
  const difference: ExperimentsExperimentReportV2DefsInterval = {
    ...interval,
    method: "bootstrap-percentile",
  };
  const effect = proportion
    ? { name: "risk-difference" as const, value: interval.estimate }
    : { name: "cliffs-delta" as const, value: cliffsDelta(armValues, controlValues) };

  let test: Comparison["test"];
  let pValue: number | null;
  let discordant: Comparison["discordant"];
  if (settings.paired && proportion && settings.unit !== "task") {
    let armOnly = 0;
    let controlOnly = 0;
    armValues.forEach((value, index) => {
      if (value === 1 && controlValues[index] === 0) armOnly++;
      if (value === 0 && controlValues[index] === 1) controlOnly++;
    });
    test = "mcnemar-exact";
    pValue = mcnemarExactTest(armOnly, controlOnly).p_value;
    discordant = { arm_only: armOnly, control_only: controlOnly };
  } else if (settings.paired) {
    test = "paired-permutation";
    pValue = pairedPermutationTest(
      armValues.map((value, index) => value - controlValues[index]),
      { samples: settings.permutationSamples, random: testRandom },
    ).p_value;
  } else {
    test = "unpaired-permutation";
    pValue = unpairedPermutationTest(armValues, controlValues, {
      samples: settings.permutationSamples,
      random: testRandom,
    }).p_value;
  }
  return {
    ...coverage,
    arm: armId,
    control: controlId,
    metric,
    paired: settings.paired,
    n,
    difference,
    test,
    p_value: pValue,
    p_value_adjusted: pValue,
    effect_size: effect,
    ...(discordant ? { discordant } : {}),
    significant: false,
  };
}

function signed(value: number): string {
  const text = value.toFixed(3);
  return value > 0 ? `+${text}` : text;
}

/** Applies the preregistered direction to the treatment-vs-control comparison of the primary metric. */
export function decideVerdict(
  experiment: ExperimentsExperimentV1,
  comparisons: readonly Comparison[],
  alpha: number,
): ExperimentsExperimentReportV2["verdict"] {
  const { hypothesis, metrics } = experiment;
  const base = {
    primary_metric: metrics.primary,
    treatment_arm: hypothesis.treatment_arm,
    control_arm: hypothesis.control_arm,
    expected: hypothesis.expected,
  };
  const comparison = comparisons.find(
    (entry) => entry.arm === hypothesis.treatment_arm && entry.metric === metrics.primary,
  );
  if (!comparison || comparison.test === "none" || comparison.difference.estimate === null) {
    const n = comparison?.n ?? 0;
    return {
      status: "not-evaluated",
      ...base,
      rationale: `Primary metric ${metrics.primary} could not be evaluated for ${hypothesis.treatment_arm} versus ${hypothesis.control_arm}: n=${n} ${comparison?.unit ?? "task"} units (at least 2 are required).`,
    };
  }
  const estimate = comparison.difference.estimate;
  const expectedSign = hypothesis.expected === "treatment-greater" ? 1 : -1;
  const sign = Math.sign(estimate);
  let status: "supported" | "refuted" | "inconclusive" = "inconclusive";
  if (comparison.significant && sign === expectedSign) status = "supported";
  else if (comparison.significant && sign === -expectedSign) status = "refuted";
  const interval =
    comparison.difference.ci_low === null || comparison.difference.ci_high === null
      ? "n/a"
      : `[${comparison.difference.ci_low.toFixed(3)}, ${comparison.difference.ci_high.toFixed(3)}]`;
  const adjusted = comparison.p_value_adjusted?.toFixed(3) ?? "n/a";
  const mde = experiment.analysis.minimum_detectable_effect;
  const mdeText =
    mde === undefined
      ? ""
      : ` The absolute estimate ${Math.abs(estimate) >= mde ? "reaches" : "does not reach"} the minimum detectable effect of ${mde}.`;
  const outcome =
    status === "supported"
      ? "significant in the expected direction"
      : status === "refuted"
        ? "significant in the opposite direction"
        : "not significant";
  return {
    status,
    ...base,
    rationale: `${hypothesis.treatment_arm} minus ${hypothesis.control_arm} on ${metrics.primary} (${hypothesis.expected} expected) is ${outcome}: n=${comparison.n}, estimate ${signed(estimate)}, CI ${interval} (bootstrap, alpha=${alpha}), adjusted p=${adjusted}.${mdeText}`,
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function agreementOf(records: readonly TrialRecord[]): ExperimentsExperimentReportV2["agreement"] {
  const byRater = new Map<string, Map<string, string>>();
  for (const record of records)
    for (const label of record.failure_layer_labels) {
      const labels = byRater.get(label.rater) ?? new Map<string, string>();
      labels.set(record.trial_id, label.layer);
      byRater.set(label.rater, labels);
    }
  if (byRater.size < 2) return null;
  const [first, second] = [...byRater.entries()].sort(
    (left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]),
  );
  const common = [...first[1].keys()].filter((id) => second[1].has(id)).sort();
  const result = cohensKappa(
    common.map((id) => first[1].get(id) as string),
    common.map((id) => second[1].get(id) as string),
  );
  return {
    raters: [first[0], second[0]],
    n: result.n,
    cohens_kappa: result.kappa,
    observed_agreement: result.observed_agreement,
  };
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function aggregateExperiment(input: AggregateInput): ExperimentsExperimentReportV2 {
  const { experiment, suite, records } = input;
  const alpha = experiment.analysis.alpha;
  const settings: ComparisonSettings = {
    alpha,
    bootstrapSamples: experiment.analysis.bootstrap_samples ?? 10000,
    permutationSamples: experiment.analysis.permutation_samples ?? 10000,
    seed: experiment.design.seed,
    paired: experiment.design.paired !== false,
    unit: experiment.analysis.unit ?? "task",
  };
  if (settings.unit === "task" && !settings.paired)
    throw new Error("task-level analysis requires paired tasks");
  const correction = experiment.analysis.correction ?? "holm";
  const { primary } = experiment.metrics;
  const secondary = experiment.metrics.secondary ?? [];
  const passAtKs = experiment.metrics.pass_at_k ?? [];
  const control = experiment.hypothesis.control_arm;

  const seenIds = new Set<string>();
  const seenPairs = new Set<string>();
  const plannedIds = new Set(input.plannedTrialIds);
  const designTrials = new Map(
    planTrials({ experiment, tasks: selectedTasks(experiment, suite) }).map((trial) => [
      trial.trial_id,
      trial,
    ]),
  );
  for (const id of plannedIds)
    if (!designTrials.has(id)) throw new Error(`foreign planned trial: ${id}`);
  if (plannedIds.size !== input.plannedTrialIds.length)
    throw new Error("duplicate planned trial ID");
  for (const record of records) {
    const expected = designTrials.get(record.trial_id);
    if (
      !expected ||
      expected.arm_id !== record.arm_id ||
      expected.task_id !== record.task_id ||
      expected.repetition !== record.repetition ||
      record.experiment_id !== experiment.experiment_id
    )
      throw new Error(`trial identity mismatch: ${record.trial_id}`);
    const key = `${record.arm_id}:${pairKey(record)}`;
    if (seenIds.has(record.trial_id) || seenPairs.has(key))
      throw new Error(`duplicate trial evidence: ${record.trial_id}`);
    if (
      !plannedIds.has(record.trial_id) ||
      record.experiment_digest !== input.experimentDigest ||
      record.suite_digest !== input.suiteDigest
    )
      throw new Error(`foreign trial evidence: ${record.trial_id}`);
    seenIds.add(record.trial_id);
    seenPairs.add(key);
  }
  const completed = records.filter((record) => record.status === "completed").sort(bySequence);
  const recordIds = new Set(records.map((record) => record.trial_id));
  const count = (status: TrialRecord["status"]) =>
    records.filter((record) => record.status === status).length;
  const trials = {
    planned: input.plannedTrialIds.length,
    completed: count("completed"),
    launch_failed: count("launch-failed"),
    collect_failed: count("collect-failed"),
    skipped: count("skipped"),
    missing: input.plannedTrialIds.filter((id) => !recordIds.has(id)).length,
  };
  const completedByArm = (armId: string) => completed.filter((record) => record.arm_id === armId);

  const summaryMetrics = [
    ...new Set<MetricName>([
      primary,
      ...secondary,
      "wall_clock_ms",
      "provider_attempts",
      "total_tokens",
    ]),
  ].filter((metric) => !isProportionMetric(metric));

  const arms: ExperimentsExperimentReportV2DefsArmSummary[] = experiment.arms.map((arm) => {
    const own = completedByArm(arm.arm_id);
    const metrics: Record<string, ContinuousSummary> = {};
    for (const metric of summaryMetrics)
      metrics[metric] = summarize(
        evaluable(own, metric, settings.unit),
        `${arm.arm_id}:${metric}`,
        settings,
      );
    const perTask = new Map<string, { n: number; c: number }>();
    for (const record of own) {
      if (typeof record.outcome.pass !== "boolean") continue;
      const tally = perTask.get(record.task_id) ?? { n: 0, c: 0 };
      tally.n++;
      if (record.outcome.pass) tally.c++;
      perTask.set(record.task_id, tally);
    }
    const tokenStatus = (status: string) =>
      own.filter((record) => record.measurements.tokens.measurement_status === status).length;
    const planned = input.plannedTrialIds.filter((id) => id.startsWith(`${arm.arm_id}.`)).length;
    const all = records.filter((record) => record.arm_id === arm.arm_id);
    const passValues = evaluable(own, "pass_rate");
    const successes = passValues.reduce((total, value) => total + value, 0);
    const unknown = planned - passValues.length;
    return {
      arm_id: arm.arm_id,
      label: arm.label,
      coverage: {
        planned,
        completed: own.length,
        launch_failed: all.filter((record) => record.status === "launch-failed").length,
        collect_failed: all.filter((record) => record.status === "collect-failed").length,
        skipped: all.filter((record) => record.status === "skipped").length,
        missing: planned - all.length,
        pass_observed: passValues.length,
        pass_unknown: unknown,
        pass_rate_lower: planned ? successes / planned : null,
        pass_rate_upper: planned ? (successes + unknown) / planned : null,
      },
      n: own.length,
      proportions: {
        pass_rate: proportionOf(own, "pass_rate", settings, `${arm.arm_id}:pass_rate`),
        ship_rate: proportionOf(own, "ship_rate", settings, `${arm.arm_id}:ship_rate`),
        acceptance_rate: proportionOf(
          own,
          "acceptance_rate",
          settings,
          `${arm.arm_id}:acceptance_rate`,
        ),
      },
      metrics,
      pass_at_k: passAtKs.map((k) => {
        const estimates: number[] = [];
        for (const { n, c } of perTask.values()) {
          if (n < k) continue;
          const estimate = passAtK(n, c, k);
          if (estimate !== null) estimates.push(estimate);
        }
        return { k, estimate: mean(estimates), tasks: estimates.length };
      }),
      tokens_measurement: {
        complete: tokenStatus("complete"),
        partial: tokenStatus("partial"),
        unavailable: tokenStatus("unavailable"),
      },
    };
  });

  let comparisons: Comparison[] = [];
  for (const metric of new Set<MetricName>([primary, ...secondary])) {
    const family = experiment.arms
      .filter((arm) => arm.arm_id !== control)
      .map((arm) =>
        compareArms(
          arm.arm_id,
          completedByArm(arm.arm_id),
          control,
          completedByArm(control),
          metric,
          settings,
        ),
      );
    comparisons.push(...family);
  }
  const adjusted =
    correction === "holm"
      ? holmBonferroni(comparisons.map((entry) => entry.p_value ?? 1))
      : comparisons.map((entry) => entry.p_value);
  comparisons = comparisons.map((entry, index) => ({
    ...entry,
    p_value_adjusted: entry.p_value === null ? null : adjusted[index],
    significant: entry.p_value !== null && adjusted[index] !== null && adjusted[index] < alpha,
  }));

  const tasks = selectedTasks(experiment, suite);
  const taskResults: ExperimentsExperimentReportV2["task_results"] = [];
  for (const arm of experiment.arms)
    for (const task of tasks)
      for (const metric of new Set<MetricName>([primary, ...secondary])) {
        const own = completedByArm(arm.arm_id).filter((record) => record.task_id === task.task_id);
        const values = evaluable(own, metric);
        const planned = Array.from(
          { length: experiment.design.repetitions },
          (_, index) => `${arm.arm_id}.${task.task_id}.r${index + 1}`,
        ).filter((id) => plannedIds.has(id)).length;
        taskResults.push({
          arm_id: arm.arm_id,
          task_id: task.task_id,
          metric,
          planned,
          observed: values.length,
          mean: mean(values),
        });
      }
  const verdict = decideVerdict(experiment, comparisons, alpha);
  const primaryRows = taskResults.filter((row) => row.metric === primary);
  if (
    input.plannedTrialIds.length !==
      tasks.length * experiment.arms.length * experiment.design.repetitions ||
    primaryRows.some((row) => row.observed !== row.planned)
  ) {
    verdict.status = "not-evaluated";
    verdict.rationale =
      "Confirmatory verdict withheld: the full design has missing, failed or unevaluable primary outcomes, or a truncated trial plan. Comparisons are exploratory complete-case estimates; inspect coverage and missing-outcome bounds.";
  }

  const unmeasured = completed.filter(
    (record) => record.measurements.tokens.measurement_status !== "complete",
  ).length;
  const armCounts = arms.map((arm) => arm.n);
  const smallest = Math.min(...armCounts);
  const largest = Math.max(...armCounts);
  const limitations: string[] = [
    settings.unit === "task"
      ? "Inference averages repetitions within each task and weights observed tasks equally. Task bootstrap and task-level sign flips assume independent, exchangeable tasks; related tasks from one repository may still be dependent. Intervals are pointwise, not simultaneous."
      : "Legacy trial-level inference treats repeated attempts as independent; uncertainty may be understated when repetitions share tasks. Intervals are pointwise, not simultaneous.",
    "Unknown-outcome bounds are identification bounds over planned trials, not confidence intervals. Complete-case estimates may be biased by selective failures.",
    "Repeated inspection or data-dependent stopping is not controlled by these fixed-design tests. A significant effect does not establish practical value or equivalence.",
  ];
  if (smallest < 30)
    limitations.push(
      `Sample size: ${smallest === largest ? smallest : `${smallest} to ${largest}`} trials per arm; intervals are wide below 30.`,
    );
  if (unmeasured > 0)
    limitations.push(
      `Token measurements were partial or unavailable for ${unmeasured} trials; cost figures exclude them.`,
    );
  limitations.push(
    "Trials ran sequentially on one host; wall-clock figures include provider latency variance.",
    "Acceptance checks are task-specific and can reject correct solutions or accept incomplete ones (see threats to validity).",
    "Results describe the frozen suite and arms above; they do not establish general capability.",
  );

  const runs = completed.map((record) => record.run);
  const defined = (values: (string | null | undefined)[]) =>
    sortedUnique(values.filter((value): value is string => typeof value === "string"));
  const identities = new Map<string, { [key: string]: unknown }>();
  for (const run of runs)
    if (run.runtime_identity)
      identities.set(canonicalJson(run.runtime_identity), run.runtime_identity);
  const experimentPath = shellWord(input.experimentPath ?? `${experiment.experiment_id}.json`);
  const outputPath = shellWord(
    input.outputPath ?? `.pipeline/experiments/${experiment.experiment_id}`,
  );

  return {
    schema_version: "2.0.0",
    experiment_id: experiment.experiment_id,
    experiment_digest: input.experimentDigest,
    suite_digest: input.suiteDigest,
    input_digest: input.inputDigest ?? null,
    records_digest: createHash("sha256")
      .update(canonicalJson([...records].sort(bySequence)))
      .digest("hex"),
    generated_at: input.generatedAt ?? new Date().toISOString(),
    analysis: {
      implementation: EXPERIMENT_ANALYSIS_IMPLEMENTATION,
      alpha,
      bootstrap_samples: settings.bootstrapSamples,
      permutation_samples: settings.permutationSamples,
      correction,
      seed: settings.seed,
      paired: settings.paired,
      primary_metric: primary,
      unit: settings.unit ?? "task",
      multiplicity_family: "all-arm-metric-comparisons",
      ...(experiment.analysis.minimum_detectable_effect === undefined
        ? {}
        : { minimum_detectable_effect: experiment.analysis.minimum_detectable_effect }),
    },
    trials,
    arms,
    comparisons,
    agreement: agreementOf(records),
    verdict,
    task_results: taskResults,
    card: {
      title: experiment.title,
      suite: {
        suite_id: suite.suite_id,
        revision: suite.revision,
        task_count: selectedTasks(experiment, suite).length,
        contamination_note: suite.provenance.contamination_note,
        license: suite.provenance.license,
      },
      hypothesis: { ...experiment.hypothesis },
      arms: experiment.arms.map((arm) => ({
        arm_id: arm.arm_id,
        label: arm.label,
        run: { ...arm.run },
      })),
      provenance: {
        workflow_digests: defined(runs.map((run) => run.workflow_digest)),
        policy_digests: defined(runs.map((run) => run.policy_digest)),
        execution_profile_digests: defined(runs.map((run) => run.execution_profile_digest)),
        providers: defined(runs.map((run) => run.provider)),
        models: defined(runs.map((run) => run.model)),
        runtime_identities: [...identities.entries()]
          .sort((left, right) => left[0].localeCompare(right[0]))
          .map(([, identity]) => identity),
      },
      limitations,
      reproduction: {
        commands: [
          `npm run rae -- experiment run --experiment ${experimentPath} --output ${outputPath}`,
          `npm run rae -- experiment report --experiment ${experimentPath} --output ${outputPath}`,
        ],
      },
    },
  };
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function proportionCell(proportion: ExperimentsExperimentReportV2DefsProportion): string {
  if (proportion.estimate === null) return "n/a";
  return `${percent(proportion.estimate)} [${percent(proportion.ci_low)}, ${percent(proportion.ci_high)}] (raw successes ${proportion.successes}/${proportion.trials}; ${proportion.units} units)`;
}

function plain(value: number | null, digits: number, scale = 1): string {
  return value === null ? "n/a" : (value / scale).toFixed(digits);
}

function pCell(value: number | null): string {
  if (value === null) return "n/a";
  return value < 0.001 ? "<0.001" : value.toFixed(3);
}

function metricOf(
  arm: ExperimentsExperimentReportV2DefsArmSummary,
  metric: MetricName,
): ContinuousSummary | undefined {
  return arm.metrics[metric] as ContinuousSummary | undefined;
}

function differenceCell(comparison: Comparison): string {
  const { estimate, ci_low: low, ci_high: high } = comparison.difference;
  if (estimate === null) return "n/a";
  const render = (value: number | null): string => {
    if (value === null) return "n/a";
    if (isProportionMetric(comparison.metric)) return `${(value * 100).toFixed(1)} pp`;
    if (comparison.metric === "wall_clock_ms") return `${(value / 1000).toFixed(1)} s`;
    return value.toFixed(2);
  };
  return `${render(estimate)} [${render(low)}, ${render(high)}]`;
}

export function renderBenchmarkCard(report: ExperimentsExperimentReportV2): string {
  const { card, verdict, analysis } = report;
  const lines: string[] = [`# ${card.title}`, ""];
  lines.push("## Verdict", "");
  lines.push(`**${verdict.status}** — ${verdict.rationale}`, "");
  lines.push(
    `Hypothesis: ${String(card.hypothesis.statement ?? "")} (${verdict.treatment_arm} vs ${verdict.control_arm}, ${verdict.expected}, primary metric ${verdict.primary_metric}).`,
    "",
  );
  lines.push(
    `Suite ${card.suite.suite_id} revision ${card.suite.revision}: ${card.suite.task_count} tasks, license ${card.suite.license}. Trials: ${report.trials.completed} completed of ${report.trials.planned} planned (${report.trials.launch_failed} launch-failed, ${report.trials.collect_failed} collect-failed, ${report.trials.skipped} skipped, ${report.trials.missing} missing).`,
    "",
  );

  lines.push("## Coverage and missing outcomes", "");
  lines.push(
    "| Arm | Planned | Completed | Launch failed | Collect failed | Missing / skipped | Pass observed | Pass bounds |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const arm of report.arms) {
    const c = arm.coverage;
    lines.push(
      `| ${arm.arm_id} | ${c.planned} | ${c.completed} | ${c.launch_failed} | ${c.collect_failed} | ${c.missing} / ${c.skipped} | ${c.pass_observed} | [${percent(c.pass_rate_lower)}, ${percent(c.pass_rate_upper)}] |`,
    );
  }
  lines.push(
    "",
    "Bounds assign every unknown planned pass outcome first to failure, then to success; these are not confidence intervals.",
    "",
  );
  lines.push(
    "## Results",
    "",
    `Analysis unit: **${analysis.unit}**. All arm/metric comparisons share one ${analysis.correction} correction family.`,
    "",
  );
  lines.push(
    "| Arm | Completed trials | pass rate [CI] | ship rate [CI] | acceptance [CI] | mean wall-clock s | mean provider attempts | mean total tokens |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const arm of report.arms)
    lines.push(
      `| ${cell(arm.label)} (${arm.arm_id}) | ${arm.n} | ${proportionCell(arm.proportions.pass_rate)} | ${proportionCell(arm.proportions.ship_rate)} | ${proportionCell(arm.proportions.acceptance_rate)} | ${plain(metricOf(arm, "wall_clock_ms")?.mean ?? null, 1, 1000)} | ${plain(metricOf(arm, "provider_attempts")?.mean ?? null, 1)} | ${plain(metricOf(arm, "total_tokens")?.mean ?? null, 0)} |`,
    );
  lines.push("");

  if (report.arms.some((arm) => arm.pass_at_k.length > 0)) {
    lines.push("### pass@k", "");
    lines.push("| Arm | k | estimate | tasks |", "| --- | --- | --- | --- |");
    for (const arm of report.arms)
      for (const entry of arm.pass_at_k)
        lines.push(`| ${arm.arm_id} | ${entry.k} | ${percent(entry.estimate)} | ${entry.tasks} |`);
    lines.push("");
  }

  lines.push("## Comparisons vs control", "");
  if (report.comparisons.length === 0) lines.push("No comparisons.", "");
  else {
    lines.push(
      "| Arm | Metric | Units | Observed arm/control | Matched trials | Difference [CI] | Test | p | p adjusted | Effect size | Significant |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of report.comparisons)
      lines.push(
        `| ${entry.arm} | ${entry.metric} | ${entry.n} | ${entry.arm_observed}/${entry.control_observed} | ${entry.matched_trials} | ${differenceCell(entry)} | ${entry.test} | ${pCell(entry.p_value)} | ${pCell(entry.p_value_adjusted)} | ${entry.effect_size.name} ${plain(entry.effect_size.value, 2)} | ${entry.significant ? "yes" : "no"} |`,
      );
    lines.push("");
  }

  lines.push(
    "## Per-task results",
    "",
    "| Arm | Task | Metric | Observed / planned | Mean |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const row of report.task_results)
    lines.push(
      `| ${row.arm_id} | ${cell(row.task_id)} | ${row.metric} | ${row.observed}/${row.planned} | ${plain(row.mean, 3)} |`,
    );
  lines.push("");
  if (report.agreement) {
    const { agreement } = report;
    lines.push("## Agreement", "");
    lines.push(
      `Failure-layer labels by ${agreement.raters.join(" and ")} on ${agreement.n} commonly labelled trials: Cohen's kappa ${plain(agreement.cohens_kappa, 2)}, observed agreement ${percent(agreement.observed_agreement)}.`,
      "",
    );
  }

  const { provenance } = card;
  const short = (digests: string[]) =>
    digests.map((digest) => digest.slice(0, 12)).join(", ") || "none";
  lines.push("## Provenance", "");
  lines.push(`- Input manifest digest: ${report.input_digest ?? "unavailable (legacy lock)"}`);
  lines.push(`- Trial records digest: ${report.records_digest}`);
  lines.push(`- Workflow digests: ${short(provenance.workflow_digests)}`);
  lines.push(`- Policy digests: ${short(provenance.policy_digests)}`);
  lines.push(`- Execution profile digests: ${short(provenance.execution_profile_digests)}`);
  lines.push(`- Providers: ${provenance.providers.join(", ") || "none"}`);
  lines.push(`- Models: ${provenance.models.join(", ") || "none"}`);
  lines.push(`- Runtime identities: ${provenance.runtime_identities.length}`, "");

  lines.push("## Limitations", "");
  for (const limitation of card.limitations) lines.push(`- ${limitation}`);
  lines.push("");

  lines.push("## Reproduction", "", "```sh", ...card.reproduction.commands, "```", "");
  lines.push(
    "---",
    "",
    `Experiment digest ${report.experiment_digest.slice(0, 12)}, suite digest ${report.suite_digest.slice(0, 12)}, generated ${report.generated_at}. Analysis: ${analysis.implementation}, alpha ${analysis.alpha}, ${analysis.bootstrap_samples} bootstrap samples, ${analysis.permutation_samples} permutation samples, correction ${analysis.correction}, seed ${analysis.seed}, ${analysis.paired ? "paired" : "unpaired"}.`,
    "",
  );
  return lines.join("\n");
}
