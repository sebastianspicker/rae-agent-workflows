---
status: stable
owner: core
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: ../contracts/experiments-v1.md
---

# DR-003: Durable experiment execution and evidence

Date: 2026-10-08

## Context

DR-002 preserved terminal outcomes but a crash before record creation could
leave an apparently missing trial that was silently attempted again. Cleanup
could also remove the only execution evidence. Resumed wall budgets forgot
prior execution time, and missing cost measurements could authorize further
spending. These behaviors undermine attrition accounting and inspection of
AI-generated changes.

## Decision

This supersedes DR-002's execution lock version and its worktree-evidence
retention limitation. Its statistical decisions and analysis bundle remain.

- New execution locks are v3 and declare an execution journal. An immutable
  start receipt is written before materialization or launch. An immutable
  completion receipt binds the terminal outcome and end-to-end elapsed time.
  Outcome labels remain editable; all other outcome fields are bound.
- A start without a terminal outcome becomes `collect-failed` with unknown
  measurements on recovery. No slot is retried automatically. Recovery stops
  dispatch, persistently, until the operator confirms old children have
  stopped with `--acknowledge-interrupted`. Uncertain cleanup also requires
  acknowledgment. It permits only still-missing trials, never replacement of
  an observed or interrupted slot. Unknown budget usage remains blocking.
- Materialization, launch and evaluation share the remaining wall allowance.
  Across invocations, elapsed time is summed from durable receipts; idle
  gaps do not count. Missing elapsed time blocks a configured wall budget.
  Cost is a soft threshold between trials and can overshoot by one trial;
  missing cost stops cost-budgeted dispatch. Synchronous filesystem work and
  cleanup can overrun wall deadlines.
- Infrastructure failures do not become model failures. An unavailable or
  interrupted evaluator leaves acceptance unknown; a valid evaluator's
  nonexpected exit is a measured failed check. A nonzero autonomous exit with
  valid terminal evidence can still be a completed trial with `pass: false`.
  Collection failures preserve usage already observed.
- Before deleting a completed workspace, retain and verify private raw run
  evidence, committed source blobs, a tracked binary patch, nonignored new
  files and repository HEAD. Read blobs directly so Git export attributes
  cannot silently omit or rewrite the baseline. The manifest records exact
  hashes, sizes, executable bits and trial/input identities and is written
  last. The archive is bounded to 128 MiB and 20,000 files, rejects unsupported
  entries, and never enters the ordinary analysis export.
- Reporting/exporting v3 outcomes requires start and completion receipts and
  verifies the outcome digest. Analysis remains possible while dispatch is
  blocked, preserving visibility of interrupted outcomes. Offline analysis
  bundles reproduce inference, not process containment or raw byte retention.

## Migration

V1/v2 locks remain reportable/exportable but cannot be executed by the v3
runner. Retain them and plan a new output directory. Do not retrofit receipts
or copy outcomes into the new run. Suite, design and trial record versions
are unchanged. The additive journal and manifest schemas are v1; report v2
and its analysis implementation identifier are unchanged.

## Limits

Receipts and manifests provide integrity checks, not authenticity against an
operator who can rewrite every local artifact. Acknowledgment is an operator
assertion, not proof that a process tree was terminated after a crash. The
raw archive is private and may contain sensitive repository/provider data.
It retains source evidence, not ignored dependencies/caches, Git history,
atomic input snapshots or the provider runtime. Preserve the RAE revision and
execution environment for research reproduction. Filesystem hard-link support
is needed for atomic publication; the existing exclusive-write fallback can
leave a partial file after interruption, which parsing rejects.

The smoke suite and synthetic lifecycle tests establish implementation
behavior, not model superiority or benchmark representativeness.
