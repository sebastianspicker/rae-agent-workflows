---
status: stable
owner: core
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: ../contracts/experiments-v1.md
---

# DR-002: Research integrity and report v2

Date: 2026-10-08

Execution locks and evidence retention are further superseded by
[DR-003](dr-003-durable-experiment-execution.md).

## Context

DR-001 introduced experiments but left three validity gaps: JSON digests did
not bind local fixture/configuration contents; resume replaced failed trials;
and repeated attempts were treated as independent observations while missing
outcomes could disappear from the confirmatory verdict.

## Decision

This decision supersedes DR-001's report inference, resume and lock behavior.
Trial and suite v1 contracts remain unchanged. The design v1 contract gains
an optional `analysis.unit` field. Newly generated reports use the new
`experiment-report-v2.schema.json`; the original report-v1 schema is retained.

- Task-level inference is the report-v2 default. Match repetitions, average
  within task, then bootstrap and permute task units with equal weights.
  `analysis.unit: trial` explicitly selects the legacy independent-trial
  assumption. Task analysis requires pairing because both arms share tasks.
- All arm/metric comparisons form one Holm family. Intervals are pointwise.
  Too few units, unknown primary outcomes in any arm, or a truncated full
  design withhold the confirmatory verdict. Complete-case comparisons remain
  visible as exploratory evidence. Pass bounds expose the range permitted by
  unknown planned outcomes without claiming those bounds are confidence
  intervals.
- V2 locks fingerprint selected directory trees, Git identities, workflow,
  profile and policy files, including implicit defaults. Execution checks for
  drift before and after trials. Drift after launch retains a failed record.
  This is drift detection, not an atomic snapshot or a provider-version pin.
- Resume preserves every existing trial record, including infrastructure
  failures. `--max-trials` limits newly executed trials. A process lock prevents
  concurrent runners from replacing each other's records. A deliberately new
  revision/repetition is required to investigate retries.
- Reports carry input and exact-record digests, explicit coverage and per-task
  results. Analysis bundles retain schema-valid records, design, suite,
  schedule and report. `experiment analyze --bundle` reproduces the analysis
  without original fixture/configuration files or a provider call.

## Migration

Retain existing report-v1 artifacts as historical evidence. Reporting an old
design now produces a visibly versioned report-v2 analysis; its default
task-level inference and global multiplicity correction can change verdicts.
For historical numerical reproduction use the original implementation and
design, rather than silently rewriting a pinned design to add `unit: trial`.

V1 execution locks remain readable for report/export, with a null input
digest. They cannot be resumed because no fixture/configuration fingerprint
was retained. Start a new output directory and retain the old one. Existing
pinned suites and experiment recipes are not rewritten by this migration.

## Limits

Task clustering does not remove dependence among related tasks or establish
representativeness. The task bootstrap estimates variation over observed task
means; it is not a hierarchical or fixed-suite stratified bootstrap. Small
samples and all-equal outcomes can have degenerate bootstrap intervals.
Optional stopping, benchmark contamination, evaluator validity, environment
drift and provider nondeterminism still need a research protocol.

An analysis bundle is not an execution archive. DR-003 adds separate private
archives that survive verified workspace cleanup for new executions. To reproduce execution, retain source
inputs, the RAE revision, runtime/tool versions and provider details
separately. Reports identify the analysis implementation; offline replay
rejects an incompatible identifier. No new capability or workflow superiority claim follows from
these implementation changes or their synthetic regression tests.

See [Experimental method](../../explanation/science/experimental-method.md)
for estimands, assumptions and primary research references.
