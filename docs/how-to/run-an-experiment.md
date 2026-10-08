---
status: experimental
owner: core
last_reviewed: 2026-10-08
source_of_truth: packages/engine/src/cli/experiment.ts
evidence_links: ../reference/contracts/experiments-v1.md
---

# Run an Experiment

Use this guide to compare two or more run configurations (arms) on a frozen
task suite and to turn the result into a claim decision. The contracts are in
[Experiment contracts](../reference/contracts/experiments-v1.md). The
reasoning is in [Experimental method](../explanation/science/experimental-method.md).

## Prerequisites

- a built checkout: `npm ci --ignore-scripts` and `npm run build`
- the Codex CLI, installed and authenticated, for provider-backed arms
- a passing provider diagnostic:

```bash
npm run rae -- doctor
npm run rae -- agent doctor
```

A real run sends each task prompt and repository content to the provider, and
it takes minutes per trial. Start with `--dry-run` and `--max-trials`.

## Write or pick a suite

Use `experiments/suites/rae-smoke-v1/suite.json` to check the tooling. It has
four small tasks on a dependency-free project and is not a capability
benchmark. For a real question, write a new suite:

1. Put each target repository under `repositories/` next to `suite.json`
   (`kind: directory`) or name a Git URL and a full commit (`kind: git`).
   Directory fixtures must not contain symlinks.
2. Write each task as a work request. Name the files and the check command.
3. Give every task acceptance checks that fail on the unchanged repository and
   pass on a correct solution. Prefer argument-vector `command` checks.
4. Add `seeded_defects` when the experiment counts defects that ship. A
   detector passes while the defect is still present.
5. Fill in `provenance`, including an honest `contamination_note`.

## Write the experiment file

Copy one of the `experiments/*.experiment.json` files and change the
hypothesis, arms, design and metrics. State the falsifier before you run
anything. Pin the suite digest: compute it, or run `validate` and copy the suite
digest it prints.

```bash
npm run rae -- experiment validate --experiment experiments/my-design.experiment.json
```

Use `analysis.unit: "task"` (the report-v2 default) and keep `design.paired`
true. Repetitions estimate each task's outcome; they are not additional
independent tasks. Use `analysis.unit: "trial"` only for an explicitly
conditional trial-level analysis. For a meaningful research study, select
several independent repositories and tasks, define inclusion criteria in
advance, and report the scope of generalization. Related tasks can remain
dependent even with task-level analysis.

Once a digest is pinned, the suite and the experiment file are frozen. Change
them by adding a `revision`.

## Validate

```bash
npm run rae -- experiment validate --experiment experiments/clm-007-context-mode.experiment.json
```

`validate` prints the experiment id and digest, the suite id and digest, and the
number of selected tasks, arms and planned trials. Add `--json` for machine
output. Contract errors exit 1 with an `ERROR:` line on stderr, for example a
`suite digest mismatch`.

## Plan

```bash
npm run rae -- experiment plan --experiment experiments/clm-007-context-mode.experiment.json
```

`plan` writes `.rae-experiment` and `experiment.lock.json` to the output
directory and prints the trial table: sequence, trial id, arm and task. Arms
are interleaved within each task, and the task order is shuffled per repetition
from the design seed, so the table is the same every time. `--output <dir>`
selects another directory. The v3 lock also fingerprints every selected local
repository tree (paths, contents, executable bits) and every arm's workflow,
policy and execution profile, including default workflow/policy files. Git
repositories retain their full commit pin. Planning rejects symlinks and
non-regular fixture entries, trees over 20,000 entries or 256 MiB. Only `.git`
metadata is excluded; caches and ignored files are inputs too. Keep fixtures
minimal.

Execution rechecks these fingerprints before each trial and after it. An
input change stops execution; a post-launch change retains a `collect-failed`
record before stopping. This detects drift; it is not an atomic filesystem
snapshot. Avoid editing inputs while experiments run. V1 and v2 locks can still be
reported/exported, but cannot be resumed because they lack the current execution
journal guarantees; start a new output directory. Do not copy old records into the new run.

## Run

```bash
npm run rae -- experiment run --experiment experiments/clm-007-context-mode.experiment.json --dry-run
npm run rae -- experiment run --experiment experiments/clm-007-context-mode.experiment.json --max-trials 2
npm run rae -- experiment run --experiment experiments/clm-007-context-mode.experiment.json
```

For each planned trial the runner:

1. durably writes `execution/<trial_id>/started.json` before materializing
   the task repository as a fresh Git repository under
   `work/<trial_id>/repository`;
2. starts `agent run` there with the arm's options, the task prompt and
   `--checkpoint-policy none`, bounded by `max_trial_wall_clock_seconds`;
3. reads the run evidence (request, workflow snapshot, node envelopes) from the
   run's worktree;
4. evaluates the acceptance checks and the seeded-defect detectors in that
   worktree;
5. retains exact private evidence under `evidence/<trial_id>/`, writes
   `trials/<trial_id>.json`, logs, and a completion receipt binding the outcome.

Each trial prints one line: `trial <id> <status> pass=<true|false|null>
<wall_clock_ms>ms`. The command exits 2 if it encounters any retained or newly executed failed
trial or stops for interruption/budget limits, and 0 otherwise; contract or
input-drift errors exit 1. A measured task failure with valid evidence is a
completed trial with `pass: false`. Missing or interrupted evaluators produce
`collect-failed` with unknown acceptance, preserving any measured usage.

Things to know:

- **Resume.** Run the same command again. Trials with records of
  any status are retained and skipped, including launch and collection failures.
  Resume executes only missing trials. To study retries, preregister another
  repetition or a new experiment revision/output; never replace the first
  outcome. Only one runner may own an output directory at a time.
- **`--max-trials <n>`** limits how many trials this invocation executes.
  Completed and failed retained records do not consume this invocation limit.
  The design's `budgets.max_trials` truncates the plan itself; a truncated full
  factorial design cannot receive a confirmatory verdict.
- **`--dry-run`** prints each trial with its `agent run` arguments and creates
  nothing.
- **`--cleanup-work`** deletes `work/<trial_id>` after a completed trial. The
  runner deletes only directories directly below `work/` of an output
  directory that holds the `.rae-experiment` marker. Without the flag, the
  worktrees stay for inspection. Cleanup first verifies the retained archive;
  failed or incomplete archives preserve the workspace.
- **Budgets.** `max_wall_clock_seconds` counts durable end-to-end execution
  time across invocations, excluding idle time between them. The remaining
  allowance also caps materialization commands, provider execution and
  evaluators. Synchronous filesystem work and process cleanup may overrun the
  deadline. Unknown elapsed time after a crash blocks a configured wall budget.
  `max_estimated_cost` is a soft threshold checked between trials; one trial
  can overshoot it. Missing usage blocks further cost-budgeted dispatch rather
  than being counted as zero. Stopping leaves the remaining slots missing.
- **Interruptions.** SIGINT/SIGTERM cancel the active subprocess and retain its
  outcome. On restart, a durable start without an outcome becomes a retained
  `collect-failed` record with unknown measurements, and that invocation stops.
  No interrupted slot is automatically repeated. Inspect its workspace and
  confirm previous child processes have stopped, then resume with
  `--acknowledge-interrupted`. This writes an acknowledgment and allows only
  still-missing slots to run. Uncertain process cleanup requires the same
  acknowledgment. The flag does not turn unknown cost/duration into zero or
  override budgets. Reports remain available while dispatch is blocked.

## What runs where

Each trial's agent runs inside RAE's usual provider sandbox in an isolated
worktree. The acceptance checks and seeded-defect detectors then run in that
worktree as ordinary processes with a sealed environment: no provider key, no
proxy and no certificate variables reach them, because they import code the
agent just wrote. Failure excerpts in trial records and the captured logs are
passed through the provider redaction filter, and the log files are created
owner-readable only. Keep `logs/`, `work/`, `execution/` and `evidence/` local.
The evidence archive preserves raw exact bytes, including run requests and
provider evidence; it is private and is deliberately excluded from ordinary
analysis exports. Review free text and paths in `export/` before sharing.

## Verify retained execution evidence

```bash
npm run rae -- experiment verify-evidence --experiment experiments/my-design.experiment.json --json
```

This checks each referenced manifest and the hash and size of every archived
file. Exit 0 means all recorded trials have valid archives; exit 2 means an
archive is absent (including no recorded trials), and corrupt evidence exits
1. The CLI loads the design and suite but does not need the original trial
worktrees. `verifyTrialEvidence` is also available from `@rae/engine` for
record/output-directory verification.

Each archive contains `run/` (raw run evidence), `baseline/` (committed file
bytes read directly from Git objects), `changes.patch` (binary-capable tracked
changes), `untracked/` (nonignored new files), `repository.json` (HEAD), and a
content-addressed manifest recording paths, executable bits, sizes and SHA-256
hashes. Baseline plus patch and untracked files retain the evaluated source;
ignored dependencies/caches, Git history and the external provider runtime
are not included. Restore executable bits from the manifest. This is source
evidence, not a hermetic rerun environment. Submodules, symlinks and special
entries are unsupported. A 128 MiB / 20,000-file limit bounds each archive;
exceeding it fails collection and preserves the original workspace. A manifest
is written only after all archived bytes are durable.

## Label failures

Failed trials can be labelled by layer so that the report can show rater
agreement (CLM-020). Two raters label independently:

```bash
npm run rae -- experiment label --experiment experiments/clm-007-context-mode.experiment.json \
  --trial legacy-context.fix-median.r1 --rater alice --layer inference \
  --note "Averaged the wrong pair of elements"
```

The layer is `representation`, `inference`, `coordination`, `governance` or
`none`. A second label by the same rater replaces the first. Read the run
report and the logs referenced in the record's `evidence_refs` before you
label.

## Report

```bash
npm run rae -- experiment report --experiment experiments/clm-007-context-mode.experiment.json
```

`report` reads every trial record (a malformed file is an error), writes
`report.json` and `report.md`, and prints the verdict line and a per-arm pass
rate table. Read the verdict line first:

```text
VERDICT: <supported|refuted|inconclusive|not-evaluated> — <rationale>
```

The rationale gives the number of matched independent units, the estimated difference with
its interval, the Holm-adjusted p-value, alpha, and, when the design sets a
minimum detectable effect, whether the estimate reaches it. `supported` and
`refuted` require a significant difference in the direction the design
predicted or the opposite one, plus complete primary coverage. A complete
experiment without a significant difference is `inconclusive`; insufficient
units or missing primary evidence is `not-evaluated`. A verdict does
not say the claim is true in general; see
[Experimental method](../explanation/science/experimental-method.md#what-the-verdict-means).

In the benchmark card (`report.md`), check these before you quote a number:
the trial counts (planned, completed, missing), the width of each interval, the
token measurement counts, the provenance digests and the limitations list.

## Export

```bash
npm run rae -- experiment export --experiment experiments/clm-007-context-mode.experiment.json --format all
```

`--format` is `jsonl`, `csv` or `all` (default). The command writes
`export/trials.jsonl`, `export/trials.csv` and `export/DATASHEET.md`. Load the
table in pandas:

```python
import pandas as pd

trials = pd.read_json(".pipeline/experiments/clm-007-context-mode/export/trials.jsonl", lines=True)
done = trials[trials["status"] == "completed"]
# Descriptive trial-pooled rates; not the task-weighted report estimate.
print(done.groupby("arm_id")["pass"].agg(["count", "mean"]))
tasks = pd.read_csv(".pipeline/experiments/clm-007-context-mode/export/tasks.csv")
print(tasks[tasks["metric"] == "pass_rate"].groupby("arm_id")["mean"].mean())
print(done.groupby("arm_id")["wall_clock_ms"].describe())
```

In R, `readr::read_csv("export/trials.csv")` reads the same rows.

## From verdict to claims ledger

A verdict changes a claim only through the evidence index and the ledger.

1. Keep the output directory, or archive `report.json`, `report.md` and
   `export/` with the experiment file and the suite at the pinned digests.
2. Link the report from the claim's entry in the
   [evidence index](../reference/claims/evidence-index.md).
3. If the verdict is `supported`, propose moving the claim from `provisional`
   to `adopted` in the [claims ledger](../reference/claims/claims-ledger.md)
   and name the limits that still apply. A reviewer decides.
4. If the verdict is `refuted`, add a note to the ledger row and consider
   `rejected` after review. Do not delete the experiment.
5. If the verdict is `inconclusive` or `not-evaluated`, keep the claim
   `provisional`, record what was run and why it could not decide, and plan
   more repetitions or tasks.

## Related documentation

- [Experiment contracts](../reference/contracts/experiments-v1.md)
- [Experimental method](../explanation/science/experimental-method.md)
- [Umbrella CLI](../reference/cli/umbrella.md)
- [Claims ledger](../reference/claims/claims-ledger.md)

## Source note

- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)


## Reproduce the analysis offline

The default `export --format all` also writes `analysis.json` (report v2),
`tasks.csv` (one arm/task/metric row, including missing outcomes), full
schema-valid `records.jsonl`, `experiment.json`, `suite.json`, and
`experiment.lock.json`. The flat `trials.csv`/`trials.jsonl` remain available
for notebooks. The full records digest ties the report to its exact evidence,
including annotations.

```bash
npm run rae -- experiment analyze --bundle .pipeline/experiments/my-experiment/export
```

This validates the design, suite, schedule, input manifest and record digests,
then writes `report.json` and `report.md` in the bundle. Add `--json` for the
report on stdout. It needs the same RAE implementation, but no provider,
credentials, original fixture directories or arm files. The historical
analysis timestamp and reproduction commands are preserved. The versioned `analysis.implementation` identifier must match for offline replay;
a mismatch requires the original implementation. Keep the RAE source revision
and Node version with published results.

This is an **analysis bundle**, not a complete execution archive: referenced
worktrees, logs, repository content and external provider implementations are
not included. Inspect record paths and free-text labels before sharing. To
rerun trials, retain the separately versioned suite repositories and arm
files, plus the input manifest.

Report v2 defaults to equally weighted task means and resamples tasks. Its
coverage table shows planned, completed, failed, missing and evaluable counts.
Pass bounds assign every unknown planned outcome to failure and then success;
they are identification bounds, not confidence intervals. Raw success counts
can differ from a task-weighted rate when observed repetition counts differ.
The verdict is withheld if any arm has unknown primary outcomes or the plan
truncates the full design. Partial comparisons remain exploratory. One shared
Holm family covers every reported arm/metric comparison; intervals are
pointwise. Do not stop collection when a displayed p-value first looks good.
