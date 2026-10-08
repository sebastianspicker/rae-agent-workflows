# Experiments

Repository-owned data for the preregistered experiment runner. Everything here is data, not code. The runner lives in `packages/engine` and is documented in [the experiments contract](../docs/reference/contracts/experiments-v1.md) and [Run an experiment](../docs/how-to/run-an-experiment.md).

## Layout

| Path | Holds |
| --- | --- |
| `suites/<suite-id>/suite.json` | A frozen task suite (`experiments/task-suite-v1.schema.json`) |
| `suites/<suite-id>/repositories/` | Target repositories of the suite, copied into a fresh Git repository for every trial |
| `workflows/` | Workflow definitions used as experiment arms |
| `profiles/` | Execution profiles used as experiment arms |
| `*.experiment.json` | Preregistered designs (`experiments/experiment-v1.schema.json`) |

## Immutability

Suites and experiment files change only by a new `revision`. An experiment pins the suite with `suite.digest`, the SHA-256 of the suite's canonical JSON. That pin is the preregistration. If the suite changes, the experiment refuses to run until a new revision pins the new digest. Never edit a suite's repository fixture after a retained report used it.

## Run

```bash
npm run rae -- experiment validate --experiment experiments/clm-007-context-mode.experiment.json
npm run rae -- experiment plan     --experiment experiments/clm-007-context-mode.experiment.json
npm run rae -- experiment run      --experiment experiments/clm-007-context-mode.experiment.json
npm run rae -- experiment report   --experiment experiments/clm-007-context-mode.experiment.json
npm run rae -- experiment export   --experiment experiments/clm-007-context-mode.experiment.json
```

Output goes to `.pipeline/experiments/<experiment-id>/` unless `--output` names another directory.

## Analysis and reproducibility

Report v2 defaults to equally weighted task means; repetitions stay grouped
within tasks. Missing primary outcomes withhold the confirmatory verdict.
Execution locks fingerprint local fixture contents and arm files, and resume
preserves failed records. Do not edit a pinned recipe to change analysis
settings: create a new revision. Historical report-v1 schemas remain available.

After `export --format all`, run `rae experiment analyze --bundle <export-dir>`
to reproduce the analysis without provider calls or original input directories.
This bundle includes full records and per-task CSV, but does not archive the
repositories or provider implementation. See [DR-002](../docs/reference/decisions/dr-002-research-integrity.md).

## Contents

- `suites/rae-smoke-v1`: four small tasks on the dependency-free `tiny-service` project. A tooling check for the runner, not a capability benchmark.
- `clm-007-context-mode`: legacy versus bounded context mode.
- `clm-014-staged-separation`: the default staged graph versus `workflows/single-writer-baseline.workflow.json`, counted in seeded defects shipped.
- `clm-016-cognitive-tiering`: `profiles/tiered.execution-profile.json` versus `profiles/uniform-judgment.execution-profile.json`.

## Placeholders

The model name `gpt-5.6-terra` in the profiles is the placeholder used by the repository documentation. Replace it with the model under study before a real run, and bump the experiment `revision`. The prices in the `clm-016` arms are placeholders as well. Replace them with the published prices that apply on the day of the run.

New output directories use v3 execution locks with durable start and finish
receipts. Interrupted slots retain unknown outcomes and require
`--acknowledge-interrupted` before missing trials can launch. Existing v1/v2
outputs remain reportable but cannot resume. `experiment verify-evidence`
checks private retained archives; verified cleanup preserves raw run evidence
and evaluated source outside the worktree. Archives are excluded from analysis
exports. See [DR-003](../docs/reference/decisions/dr-003-durable-experiment-execution.md)
for lifecycle, budget and migration details.
