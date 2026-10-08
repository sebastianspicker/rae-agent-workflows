---
status: experimental
owner: core
last_reviewed: 2026-10-08
source_of_truth: packages/contracts/v1/schemas/experiments/experiment-v1.schema.json
evidence_links: ../claims/evidence-index.md
---

# Experiment Contracts

The experiment layer turns a claim into a controlled comparison. The primary
versioned contracts describe a frozen task suite, a preregistered
experiment design, one trial record per executed trial, and an aggregated
report. The schemas live in
`packages/contracts/v1/schemas/experiments/`. The schemas are authoritative;
this page summarizes them. The method behind the fields is explained in
[Experimental method](../../explanation/science/experimental-method.md). The
commands are in [Run an experiment](../../how-to/run-an-experiment.md).

Suite, design and trial contracts use `schema_version` `1.0.0`. New reports
use `2.0.0`; report v1 is retained for historical artifacts. The runtime validates
untrusted input with `parseContract("experiments/<name>.schema.json", value)`
from `@rae/contracts`.

## Task suite

Schema: `task-suite-v1.schema.json`. A suite is a frozen, model-agnostic set of
repository tasks with machine-checkable acceptance.

| Field | Type | Meaning |
| --- | --- | --- |
| `suite_id` | string | Lowercase identifier, for example `rae-smoke-v1` |
| `revision` | integer | Increases with every change to tasks or fixtures |
| `title`, `description` | string | Human-readable summary |
| `provenance` | object | `authors`, `license`, `contamination_note` (required), plus `created` and `sources` |
| `repositories` | object | Target repositories keyed by identifier. `kind: directory` has a `path` relative to the suite file. `kind: git` has a `url` and a 40-character `commit` |
| `tasks[]` | array | Tasks; see below |

Each task has:

| Field | Type | Meaning |
| --- | --- | --- |
| `task_id` | string | Identifier, unique in the suite |
| `title`, `prompt` | string | The work request given verbatim to the run |
| `repository` | string | Key in `repositories` |
| `tags`, `difficulty` | array, enum | Selection labels; difficulty is `trivial`, `easy`, `medium` or `hard` |
| `acceptance.checks[]` | array | Checks evaluated in the run's worktree after the run |
| `acceptance.require_all` | boolean | All checks must pass (default) or at least one |
| `seeded_defects[]` | array | Known defects with a `defect_id`, a `description` and a `detector` check that passes while the defect is still present |
| `reference_note` | string | Optional note on a correct solution; never sent to the run |

A check has a `check_id` and one of five kinds. `command` runs an argument
vector without a shell and passes when the exit code equals `expected_exit_code`
(default 0), with an optional `timeout_seconds`. `path-exists` and
`path-absent` test a path inside the worktree. `file-contains` and
`file-lacks` test a JavaScript regular expression (`pattern`, compiled with the
`u` flag) against a file.

## Experiment

Schema: `experiment-v1.schema.json`. An experiment is a preregistered design
over one suite.

| Field | Type | Meaning |
| --- | --- | --- |
| `experiment_id`, `revision`, `title` | string, integer, string | Identity of the design |
| `hypothesis` | object | `statement`, `treatment_arm`, `control_arm`, `expected` (`treatment-greater` or `treatment-less`), `falsifier`, and an optional `claim_id` |
| `suite` | object | `path` to the suite file, the pinned `digest`, and optional `task_ids` and `tags` filters |
| `arms[]` | array | Two to sixteen arms; see below |
| `design` | object | `repetitions`, `seed`, and optional `order` (`interleaved` default or `sequential`), `paired` (default true) and `max_trial_wall_clock_seconds` (default 7200) |
| `metrics` | object | `primary`, optional `secondary` list and `pass_at_k` list |
| `analysis` | object | `alpha` and optional `bootstrap_samples`, `permutation_samples` (both default 10000), `correction` (`holm` default or `none`), `unit` (`task` default in report v2 or `trial`) and `minimum_detectable_effect` |
| `budgets` | object | Optional `max_trials`, `max_wall_clock_seconds` and `max_estimated_cost` |

An arm has an `arm_id`, a `label`, a `run` object and an optional `pricing`
object. `run` forwards options to `rae agent run`: `workflow`,
`execution_profile`, `policy` (paths relative to the experiment file),
`context_mode`, `provider`, `model`, `reasoning_effort`, `variant`,
`graph_memory`, `max_concurrency`, `max_repair_rounds`, `timeout_seconds`,
`agent_command`, `agent_args` and `allow_unsafe_command_provider`. Experiments
always run with checkpoint policy `none` in an isolated worktree. `pricing`
holds the `currency` and per-million-token prices (`input_per_million`,
`output_per_million`, and optionally `cached_input_per_million` and
`reasoning_output_per_million`). The operator supplies them; RAE ships none.

The metric names are `pass_rate`, `ship_rate`, `acceptance_rate`,
`wall_clock_ms`, `provider_attempts`, `repair_rounds`, `total_tokens`,
`output_tokens`, `estimated_cost`, `seeded_defects_shipped` and
`changed_paths`.

## Trial record

Schema: `trial-record-v1.schema.json`. The runner writes one record per
executed trial to `trials/<trial_id>.json`. A record is immutable except for
appended failure-layer labels.

| Field | Type | Meaning |
| --- | --- | --- |
| `experiment_id`, `experiment_digest`, `suite_digest` | string | Preregistration identity of the trial |
| `trial_id`, `arm_id`, `task_id`, `repetition`, `sequence` | string, integer | Position in the plan; the trial id is `<arm>.<task>.r<repetition>` |
| `status` | enum | `completed`, `launch-failed`, `collect-failed` or `skipped` |
| `run` | object | Run id and status, workspace and report paths, workflow, policy and execution-profile digests, provider, model, reasoning effort, runtime identity, timestamps and `wall_clock_ms` of the launch |
| `outcome` | object | `pass`, `reached_ship_state`, `acceptance_pass`, per-check `acceptance` results, `seeded_defects_shipped` and per-defect `seeded_defects` results |
| `measurements` | object | `provider_attempts`, node status counts, `repair_rounds`, `changed_paths`, `tokens` (with `measurement_status`) and `estimated_cost` |
| `failure_layer_labels[]` | array | Rater labels: `representation`, `inference`, `coordination`, `governance` or `none` |
| `evidence_refs[]` | array | Paths to the retained manifest, execution receipt and logs (legacy records may reference worktrees) |
| `error` | string | Present when the trial did not complete |

`pass` is true when the run reached a ship state and the acceptance checks
passed. It is null when acceptance could not be evaluated. Token fields appear
only when at least one provider attempt reported them, and `estimated_cost` is
null unless the arm has pricing and the token measurement is complete.

## Execution journal and evidence manifest

`trial-execution-v1.schema.json` binds immutable `started`, `finished` and
`acknowledged` receipts to the design, suite, input digest and full trial
identity. A start precedes materialization. A finish records end-to-end
`elapsed_ms` (null after interrupted recovery), `recovered`,
`requires_acknowledgment` and `record_digest`. That digest excludes mutable
`failure_layer_labels`; all other outcome fields are immutable. Report/export
require matching start/finish receipts for v3 outputs. A missing terminal
outcome is recovered as a v1 `collect-failed` record, never silently rerun.
Acknowledgment records an operator assertion that prior child processes have
stopped; it does not prove termination or repair unknown measurements.

`evidence-manifest-v1.schema.json` binds a private archive to the trial, run
and input identities. Each entry names a relative path, SHA-256, byte count
and executable bit. The manifest filename contains its canonical JSON digest,
and the immutable trial outcome references that filename. Verification checks
identities, contained regular files and their exact bytes before cleanup.
Normal analysis bundles omit this raw archive. See
[retention and recovery](../../how-to/run-an-experiment.md#verify-retained-execution-evidence)
and [DR-003](../decisions/dr-003-durable-experiment-execution.md).

## Experiment report

Schema: `experiment-report-v2.schema.json` (historical: `experiment-report-v1.schema.json`). The report is derived from trial
records and the experiment file. It is reproducible from the records and the
design seed.

| Field | Type | Meaning |
| --- | --- | --- |
| `experiment_digest`, `suite_digest`, `generated_at` | string | Identity and time of the analysis |
| `analysis` | object | Alpha, sample counts, correction, seed, pairing, primary metric, independent `unit`, global `multiplicity_family` and versioned `implementation` |
| `records_digest`, `input_digest` | string, string or null | Exact canonical trial-record digest and input manifest identity (null for legacy locks) |
| `task_results[]` | array | One arm/task/metric row with planned and observed trial counts and the observed mean |
| `trials` | object | Counts of planned, completed, failed, skipped and missing trials |
| `arms[]` | array | Per arm: completed `n`, coverage, task-bootstrap proportions (Wilson in trial mode), metric summaries, `pass_at_k` and token measurement counts |
| `comparisons[]` | array | Every non-control arm against the control for the primary and secondary metrics: difference with interval, test, p-value, Holm-adjusted p-value, effect size, discordant pairs and `significant` |
| `agreement` | object or null | Cohen's kappa between the two raters with the most labels, or null |
| `verdict` | object | `status` (`supported`, `refuted`, `inconclusive` or `not-evaluated`) and a rationale |
| `card` | object | Content of the benchmark card: suite, hypothesis, arms, provenance, limitations and reproduction commands |

Comparison `n` counts matched tasks in task mode and trial pairs in trial
mode; `arm_observed`, `control_observed` and `matched_trials` always count
trial values. Proportion `units` counts independent units, while `successes`
and `trials` remain raw pooled counts. A task-weighted estimate need not equal
`successes / trials` when observations are unbalanced. One-unit bootstrap
summaries have null bounds. `coverage` separates each arm's planned,
completed, failed, skipped, missing and pass-observed counts, plus worst/best
planned-trial pass bounds. Those bounds are not confidence intervals.

The v2 default averages repetitions within task and gives tasks equal weight.
It requires paired tasks, applies Holm across all arm/metric hypotheses and
withholds the verdict for unknown primary outcomes or a truncated full design.
See [DR-002](../decisions/dr-002-research-integrity.md) for migration.

## Digests and preregistration

A digest is the SHA-256 of a document's canonical JSON: object keys sorted
recursively, arrays in order, no whitespace. The engine computes it with
`canonicalJson` in `packages/engine/src/workflow/workflow-contract.ts`.

- `suite.digest` in an experiment file pins the suite. A mismatch stops the
  experiment with `suite digest mismatch`.
- The experiment digest and the suite digest are written to
  `experiment.lock.json` by `plan` and `run` and copied into every trial
  record and report.
- Lock v3 fingerprints selected local repository trees and
  effective workflow/profile/policy contents. `run` refuses drift; report and
  export can inspect retained results even if those external contents changed.
  A different design or suite JSON still fails closed.
- V1/v2 locks remain readable for reporting, but execution requires a new v3
  lock with `execution_journal: "1.0.0"` in a new output directory. An input manifest is a content identity,
  not a retained snapshot; trees exclude only `.git` metadata.
- `records_digest` binds a report to its complete canonical records, sorted by
  sequence and trial ID. Changing annotations changes this digest too.

The pinned digest is the preregistration. It commits the authors to the tasks,
the arms, the metrics and the analysis before any trial runs.

## Directory layout

The default output directory is `.pipeline/experiments/<experiment-id>/`.
`--output <dir>` overrides it.

```text
.rae-experiment              marker file; its presence allows guarded cleanup
experiment.lock.json         document/input digests and the planned trial list
runner.lock                  temporary exclusive execution ownership
trials/<trial_id>.json       one trial record per executed trial
execution/<trial_id>/started.json
execution/<trial_id>/finished.json
execution/<trial_id>/acknowledged.json  only when recovery is acknowledged
evidence/<trial_id>/manifest-<sha256>.json
evidence/<trial_id>/run/      private raw run evidence
evidence/<trial_id>/baseline/ committed file bytes
evidence/<trial_id>/changes.patch
evidence/<trial_id>/untracked/
evidence/<trial_id>/repository.json
work/<trial_id>/repository  materialized repository for one trial
logs/<trial_id>.stdout.txt   captured run output
logs/<trial_id>.stderr.txt
report.json                  experiment report
report.md                    benchmark card
export/trials.jsonl          flat trial table
export/trials.csv
export/DATASHEET.md          datasheet for the trial table
export/tasks.csv             per-task/metric counts and means
export/analysis.json         report v2
export/records.jsonl          full schema-valid trial records
export/experiment.json        design
export/suite.json             complete suite document
export/experiment.lock.json   original schedule and fingerprints
```

The repository data lives in `experiments/`: suites under
`experiments/suites/<suite-id>/`, workflows under `experiments/workflows/`,
profiles under `experiments/profiles/`, and designs as
`experiments/*.experiment.json`.

## Versioning

The v1 schemas are immutable in meaning. New optional fields may be added
additively. A change in semantics, a removed field, a new required field or a
new enum value that changes how a record is read requires a new schema version.
Suites and experiments change only through a new `revision`; the digest pin
makes any other edit visible.

## Related documentation

- [Run an experiment](../../how-to/run-an-experiment.md)
- [Experimental method](../../explanation/science/experimental-method.md)
- [Decision record DR-001](../decisions/dr-001-experiment-layer.md)
- [Claims ledger](../claims/claims-ledger.md)

## Source note

- [Datasheets](../claims/bibliography.md#src-datasheets)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
