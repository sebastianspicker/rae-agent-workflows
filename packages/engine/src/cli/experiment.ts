#!/usr/bin/env node
/**
 * Preregistered experiment CLI: validate, plan, run, label, report and export trial evidence.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExperimentsExperimentReportV2,
  type ExperimentsTrialRecordV1,
  parseContract,
} from "@rae/contracts";
import { repositoryRoot } from "../primitives/installation-paths.js";
import { assertSupportedNodeRuntime } from "../primitives/node-runtime.js";
import { type LoadedExperiment, loadExperiment } from "../run/experiment-contract.js";
import { analyzeExperimentBundle } from "../run/experiment-bundle.js";
import { exportTaskResults, exportTrials, renderDatasheet } from "../run/experiment-export.js";
import { readTrialExecution, trialOutcomeDigest } from "../run/experiment-journal.js";
import { verifyTrialEvidence } from "../run/experiment-evidence.js";
import { planTrials } from "../run/experiment-plan.js";
import { aggregateExperiment, renderBenchmarkCard } from "../run/experiment-report.js";
import {
  assertExperimentLock,
  experimentOutputDirectory,
  runExperiment,
  readExperimentLock,
  TRIAL_ID_PATTERN,
  writeExperimentLock,
} from "../run/experiment-runner.js";
import { readJsonStrict, writeJson } from "../run/state.js";

assertSupportedNodeRuntime();

type FailureLayer = ExperimentsTrialRecordV1["failure_layer_labels"][number]["layer"];
const LAYERS: readonly FailureLayer[] = [
  "representation",
  "inference",
  "coordination",
  "governance",
  "none",
];

interface CliOptions {
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

function usage(): void {
  process.stdout.write(`RAE experiment runner

Usage:
  npm run rae -- experiment verify-evidence --experiment <file> [--output <dir>] [--json]
  npm run rae -- experiment analyze  --bundle <export-dir> [--json]
  npm run rae -- experiment validate --experiment <file> [--json]
  npm run rae -- experiment plan     --experiment <file> [--output <dir>] [--json]
  npm run rae -- experiment run      --experiment <file> [--output <dir>] [--max-trials <n>] [--dry-run] [--cleanup-work] [--acknowledge-interrupted] [--json]
  npm run rae -- experiment label    --experiment <file> [--output <dir>] --trial <id> --rater <name> --layer <representation|inference|coordination|governance|none> [--note <text>]
  npm run rae -- experiment report   --experiment <file> [--output <dir>] [--json]
  npm run rae -- experiment export   --experiment <file> [--output <dir>] [--format jsonl|csv|all]
`);
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = { _: [] };
  const booleanFlags = new Set([
    "json",
    "help",
    "dry-run",
    "cleanup-work",
    "acknowledge-interrupted",
  ]);
  const valueFlags = new Set([
    "experiment",
    "bundle",
    "format",
    "layer",
    "max-trials",
    "note",
    "output",
    "rater",
    "trial",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!booleanFlags.has(key) && !valueFlags.has(key)) {
      throw new Error(`unknown option --${key}`);
    }
    if (booleanFlags.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || (value.startsWith("--") && key !== "note")) {
      throw new Error(`missing value for --${key}`);
    }
    index++;
    options[key] = value;
  }
  return options;
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function requiredOption(options: CliOptions, key: string): string {
  const value = stringOption(options, key);
  if (value === undefined) throw new Error(`missing required option --${key}`);
  return value;
}

function loadFromOptions(options: CliOptions): LoadedExperiment {
  return loadExperiment(resolve(process.cwd(), requiredOption(options, "experiment")));
}

function outputDirectory(options: CliOptions, loaded: LoadedExperiment): string {
  return experimentOutputDirectory(
    process.cwd(),
    loaded.experiment.experiment_id,
    stringOption(options, "output"),
  );
}

function existingOutputDirectory(options: CliOptions, loaded: LoadedExperiment): string {
  const outputDir = outputDirectory(options, loaded);
  if (!existsSync(outputDir) || !readExperimentLock(outputDir))
    throw new Error(`planned experiment output directory not found: ${outputDir}`);
  assertExperimentLock(outputDir, loaded, false);
  return outputDir;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function validateCommand(options: CliOptions): void {
  const loaded = loadFromOptions(options);
  const summary = {
    experiment_id: loaded.experiment.experiment_id,
    experiment_digest: loaded.digest,
    suite_id: loaded.suite.suite.suite_id,
    suite_digest: loaded.suite.digest,
    tasks: loaded.tasks.length,
    arms: loaded.experiment.arms.length,
    planned_trials: planTrials(loaded).length,
  };
  if (options.json === true) {
    print(JSON.stringify(summary, null, 2));
    return;
  }
  print(`experiment ${summary.experiment_id} ${summary.experiment_digest}`);
  print(`suite ${summary.suite_id} ${summary.suite_digest}`);
  print(`tasks ${summary.tasks}`);
  print(`arms ${summary.arms}`);
  print(`planned trials ${summary.planned_trials}`);
}

function planCommand(options: CliOptions): void {
  const loaded = loadFromOptions(options);
  const outputDir = outputDirectory(options, loaded);
  const trials = planTrials(loaded);
  const lock = writeExperimentLock(outputDir, loaded, trials);
  if (options.json === true) {
    print(JSON.stringify({ output: outputDir, lock }, null, 2));
    return;
  }
  print(`output ${outputDir}`);
  print("sequence\ttrial_id\tarm\ttask");
  for (const trial of lock.trials)
    print(`${trial.sequence}\t${trial.trial_id}\t${trial.arm_id}\t${trial.task_id}`);
}

function parseMaxTrials(options: CliOptions): number | undefined {
  const value = stringOption(options, "max-trials");
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("--max-trials must be a positive integer");
  return parsed;
}

async function runCommand(options: CliOptions): Promise<void> {
  const loaded = loadFromOptions(options);
  const outputDir = outputDirectory(options, loaded);
  const dryRun = options["dry-run"] === true;
  const maxTrials = parseMaxTrials(options);
  const json = options.json === true;
  if (dryRun) assertExperimentLock(outputDir, loaded);
  else writeExperimentLock(outputDir, loaded, planTrials(loaded));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const summary = await runExperiment(loaded, {
      outputDir,
      dryRun,
      cleanupWork: options["cleanup-work"] === true,
      acknowledgeInterrupted: options["acknowledge-interrupted"] === true,
      signal: controller.signal,
      ...(maxTrials === undefined ? {} : { maxTrials }),
      log: (line) => (json ? process.stderr : process.stdout).write(`${line}\n`),
    });
    if (json) print(JSON.stringify({ output: outputDir, ...summary }, null, 2));
    if (summary.failed.length > 0 || summary.stop_reason !== null) process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function trialRecordFile(outputDir: string, trialId: string): string {
  if (!TRIAL_ID_PATTERN.test(trialId)) throw new Error(`invalid trial id ${trialId}`);
  return join(outputDir, "trials", `${trialId}.json`);
}

function labelCommand(options: CliOptions): void {
  const loaded = loadFromOptions(options);
  const outputDir = existingOutputDirectory(options, loaded);
  const path = trialRecordFile(outputDir, requiredOption(options, "trial"));
  const rater = requiredOption(options, "rater");
  const layer = requiredOption(options, "layer");
  if (!LAYERS.includes(layer as FailureLayer))
    throw new Error(`--layer must be one of ${LAYERS.join(", ")}`);
  const note = stringOption(options, "note");
  const record = parseContract("experiments/trial-record-v1.schema.json", readJsonStrict(path));
  const label: ExperimentsTrialRecordV1["failure_layer_labels"][number] = {
    rater,
    layer: layer as FailureLayer,
    ...(note === undefined ? {} : { note }),
    labeled_at: new Date().toISOString(),
  };
  const updated: ExperimentsTrialRecordV1 = {
    ...record,
    failure_layer_labels: [
      ...record.failure_layer_labels.filter((existing) => existing.rater !== rater),
      label,
    ],
  };
  writeJson(path, parseContract("experiments/trial-record-v1.schema.json", updated));
  print(`labelled ${record.trial_id} rater=${rater} layer=${layer}`);
}

/** Every record must carry this experiment's digests and name a planned trial; foreign files abort. */
function readTrialRecords(outputDir: string, loaded: LoadedExperiment): ExperimentsTrialRecordV1[] {
  const directory = join(outputDir, "trials");
  if (!existsSync(directory)) return [];
  const planned = new Map(planTrials(loaded).map((trial) => [trial.trial_id, trial]));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      let record: ExperimentsTrialRecordV1;
      try {
        record = parseContract("experiments/trial-record-v1.schema.json", readJsonStrict(path));
      } catch (error) {
        throw new Error(
          `invalid trial record ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const trial = planned.get(record.trial_id);
      if (
        record.experiment_digest !== loaded.digest ||
        record.suite_digest !== loaded.suite.digest ||
        name !== `${record.trial_id}.json` ||
        !trial ||
        trial.arm_id !== record.arm_id ||
        trial.task_id !== record.task_id ||
        trial.repetition !== record.repetition ||
        trial.sequence !== record.sequence ||
        record.experiment_id !== loaded.experiment.experiment_id
      )
        throw new Error(`trial record ${path} does not belong to this experiment's plan`);
      const lock = readExperimentLock(outputDir);
      const inputs = lock?.inputs;
      if (inputs) {
        const start = readTrialExecution(outputDir, loaded, trial, inputs.digest, "started");
        const finish = readTrialExecution(outputDir, loaded, trial, inputs.digest, "finished");
        if (lock?.schema_version === "3.0.0" && (!start || !finish))
          throw new Error(
            `trial execution receipt missing: ${record.trial_id}; run recovery before reporting`,
          );
        if (finish && finish.record_digest !== trialOutcomeDigest(record))
          throw new Error(
            `retained outcome differs from its execution receipt: ${record.trial_id}`,
          );
      }
      return record;
    });
}

function selectedSuite(loaded: LoadedExperiment): LoadedExperiment["suite"]["suite"] {
  return { ...loaded.suite.suite, tasks: loaded.tasks };
}

/** Repository-relative when the path lies inside the RAE checkout; otherwise unchanged. */
function displayPath(path: string): string {
  const relation = relative(repositoryRoot, path);
  return relation && !relation.startsWith("..") && !isAbsolute(relation) ? relation : path;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function printReport(report: ExperimentsExperimentReportV2): void {
  print(`VERDICT: ${report.verdict.status} — ${report.verdict.rationale}`);
  print(
    `arm\tcompleted trials\tpass rate\t${(1 - report.analysis.alpha) * 100}% CI (${report.analysis.unit} units)`,
  );
  for (const arm of report.arms) {
    const pass = arm.proportions.pass_rate;
    print(
      `${arm.arm_id}\t${arm.n}\t${percent(pass.estimate)} (${pass.successes}/${pass.trials})\t[${percent(pass.ci_low)}, ${percent(pass.ci_high)}]`,
    );
  }
}

function buildReport(
  loaded: LoadedExperiment,
  outputDir: string,
  records: ExperimentsTrialRecordV1[],
): ExperimentsExperimentReportV2 {
  return aggregateExperiment({
    experiment: loaded.experiment,
    experimentDigest: loaded.digest,
    suite: selectedSuite(loaded),
    suiteDigest: loaded.suite.digest,
    records,
    inputDigest: readExperimentLock(outputDir)?.inputs?.digest ?? null,
    plannedTrialIds: planTrials(loaded).map((trial) => trial.trial_id),
    experimentPath: displayPath(loaded.source),
    outputPath: displayPath(outputDir),
  });
}

function reportCommand(options: CliOptions): void {
  const loaded = loadFromOptions(options);
  const outputDir = existingOutputDirectory(options, loaded);
  const report = buildReport(loaded, outputDir, readTrialRecords(outputDir, loaded));
  writeJson(
    join(outputDir, "report.json"),
    parseContract("experiments/experiment-report-v2.schema.json", report),
  );
  writeFileSync(join(outputDir, "report.md"), renderBenchmarkCard(report), "utf8");
  if (options.json === true) {
    print(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report);
}

function exportCommand(options: CliOptions): void {
  const loaded = loadFromOptions(options);
  const outputDir = existingOutputDirectory(options, loaded);
  const format = stringOption(options, "format") ?? "all";
  if (!["jsonl", "csv", "all"].includes(format))
    throw new Error("--format must be jsonl, csv or all");
  const records = readTrialRecords(outputDir, loaded);
  const directory = join(outputDir, "export");
  mkdirSync(directory, { recursive: true });
  const written: string[] = [];
  const write = (name: string, content: string): void => {
    const path = join(directory, name);
    writeFileSync(path, content, "utf8");
    written.push(path);
  };
  if (format === "jsonl" || format === "all") write("trials.jsonl", exportTrials(records, "jsonl"));
  if (format === "csv" || format === "all") write("trials.csv", exportTrials(records, "csv"));
  if (format === "all") {
    const report = parseContract(
      "experiments/experiment-report-v2.schema.json",
      buildReport(loaded, outputDir, records),
    );
    write("analysis.json", `${JSON.stringify(report, null, 2)}\n`);
    write("tasks.csv", exportTaskResults(report));
    write("records.jsonl", records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    write("experiment.json", `${JSON.stringify(loaded.experiment, null, 2)}\n`);
    write("suite.json", `${JSON.stringify(loaded.suite.suite, null, 2)}\n`);
    write("experiment.lock.json", `${JSON.stringify(readExperimentLock(outputDir), null, 2)}\n`);
    write(
      "DATASHEET.md",
      renderDatasheet({
        experiment: loaded.experiment,
        experimentDigest: loaded.digest,
        suite: selectedSuite(loaded),
        suiteDigest: loaded.suite.digest,
        records,
      }),
    );
  }
  for (const path of written) print(`wrote ${path}`);
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (["help", "--help", "-h"].includes(command) || options.help === true) return usage();
  if (options._.length > 0) throw new Error(`unexpected argument ${options._[0]}`);
  switch (command) {
    case "verify-evidence": {
      const loaded = loadFromOptions(options);
      const output = existingOutputDirectory(options, loaded);
      const records = readTrialRecords(output, loaded);
      const results = records.map((record) => ({
        trial_id: record.trial_id,
        ...verifyTrialEvidence(output, record, readExperimentLock(output)?.inputs?.digest),
      }));
      const summary = {
        verified_trials: results.filter((entry) => entry.manifests > 0).length,
        without_archive: results.filter((entry) => entry.manifests === 0).length,
        trials: results,
      };
      if (options.json === true) print(JSON.stringify(summary, null, 2));
      else
        print(
          `Verified evidence for ${summary.verified_trials} trials; ${summary.without_archive} trials have no archive.`,
        );
      if (summary.without_archive > 0 || summary.verified_trials === 0) process.exitCode = 2;
      return;
    }
    case "analyze": {
      const directory = resolve(requiredOption(options, "bundle"));
      const report = analyzeExperimentBundle(directory);
      writeJson(join(directory, "report.json"), report);
      writeFileSync(join(directory, "report.md"), renderBenchmarkCard(report), "utf8");
      if (options.json === true) print(JSON.stringify(report, null, 2));
      else printReport(report);
      return;
    }
    case "validate":
      return validateCommand(options);
    case "plan":
      return planCommand(options);
    case "run":
      return runCommand(options);
    case "label":
      return labelCommand(options);
    case "report":
      return reportCommand(options);
    case "export":
      return exportCommand(options);
    default:
      throw new Error(`unknown experiment command: ${command}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
