---
status: stable
owner: core
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: ../contracts/experiments-v1.md
---

# DR-001: In-repository experiment layer

Date: 2026-10-08

Report inference, execution locks and resume behavior are superseded by
[DR-002: Research integrity and report v2](dr-002-research-integrity.md).

## Context

The [claims ledger](../claims/claims-ledger.md) names a falsifiable metric for
each provisional claim, and none has a retained measurement. The
[limitations page](../../explanation/science/limitations.md) stated that no
benchmark family or benchmark card was tracked. ASM-003 in the
[assumptions register](../claims/assumptions-register.md) assumed that
benchmark metadata could stay model-agnostic, with a review trigger at the
first populated benchmark family.

The engine already records what a measurement needs: request metadata, workflow
and policy digests, node envelopes with token usage, and a report per run. What
was missing was the procedure that turns many runs into a comparison: a frozen
task set, a design committed in advance, a runner that varies one thing, and an
analysis that can be reproduced from the records.

## Decision

Add an experiment layer inside the repository:

- four additive v1 contracts under `packages/contracts/v1/schemas/experiments/`:
  task suite, experiment, trial record and experiment report;
- the `rae experiment` command family: `validate`, `plan`, `run`, `label`,
  `report` and `export`;
- repository-owned data under `experiments/`: a smoke suite with its fixture
  repository, a single-writer baseline workflow, two execution profiles and
  three preregistered designs for CLM-007, CLM-014 and CLM-016;
- trial records as the unit of evidence. Reports, benchmark cards and exports
  are derived from them and can be regenerated from the records and the
  design seed.

The runner launches the ordinary `agent run` in an isolated worktree for every
trial with checkpoint policy `none`. It does not add a second execution path.

## Alternatives considered

- **An external harness in the style of SWE-bench runners.** These harnesses
  are built for large public datasets and a fixed task format. RAE needs to
  vary workflows, execution profiles and context modes, and to read RAE's own
  run evidence for attempts, tokens and node status. An external harness would
  need an adapter for each, and the digests that tie a result to a workflow
  revision would live outside the repository. Rejected.
- **Ad-hoc notebooks.** They are quick, but the task set, the arm
  configuration and the analysis settings are not frozen, and results cannot be
  reproduced from a clone. Rejected as the source of evidence. The export to
  JSON lines and CSV keeps notebooks available for exploration.
- **Operator-only dashboards.** The operator console shows single runs. A
  dashboard aggregates what happened without a preregistered question, which
  invites choosing metrics after the fact. Rejected as the evidence path. An
  operator view over finished reports may still follow.

## Consequences

- The runner owns `.pipeline/experiments/<experiment-id>/`. Trial records there
  are authoritative for that experiment. Reports are derived and can be
  regenerated.
- Suites and experiment files are immutable once a digest is pinned. Change
  them by adding a revision. A suite fixture must not change after a retained
  report used it.
- Destructive cleanup is limited to `work/<trial_id>` directories of an output
  directory that holds the `.rae-experiment` marker.
- Experiments call a real provider. They cost money and time, and nothing in
  the repository gate runs them. The committed data is checked for contract
  validity, digest agreement and authoring rules only.
- The statement that no benchmark family is tracked is superseded: a smoke
  suite and three designs exist, but no results are retained. The smoke suite
  is a tooling check, not a capability benchmark.
- The review trigger of ASM-003 fired with the first populated family. Trial
  records name the provider, model and runtime and carry no model-specific
  fields, which is consistent with the assumption. A new assumption, ASM-006,
  records that the smoke suite is not representative of real maintenance work.
- The ledger metrics for CLM-007, CLM-014 and CLM-016 are encoded as
  experiment files. The encoding approximates the ledger wording: the ledger
  speaks of provider cost per passed task, and the CLM-016 design compares mean
  estimated cost with the pass rate as a secondary metric.

## Open follow-ups

- An operator view of experiment reports.
- Suites with more tasks and several repositories, large enough for the
  intervals to be informative.
- Execution of experiments on the experimental platform.
- A retained first report for each of the three designs, linked from the
  [evidence index](../claims/evidence-index.md).

## Source note

- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../claims/bibliography.md#src-nosek-open-research)
