---
status: stable
owner: core
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: claims/claims-ledger.md
---

# Terminology

- `artifact`
  Structured output emitted by a stage, loop, or evaluation run.
- `gate`
  A decision record stating whether progression is acceptable.
- `claim`
  A statement that must be either evidenced, explicitly limited, or marked as
  provisional.
- `assumption`
  A condition accepted for now but expected to be re-checked when scope,
  implementation, or benchmarks change.
- `benchmark`
  A versioned task family with defined splits, scoring, and result reporting.
- `benchmark card`
  Metadata record for a benchmark family and its publication constraints.
- `run card`
  Metadata record for one benchmark execution.
- `judge`
  The scoring mechanism, human or model-assisted, used to evaluate outputs.
- `contamination`
  Leakage from benchmark tasks or solutions into model training or evaluation input
  conditions that inflates scores.
- `deterministic loop`
  A runner whose state transitions and story selection rules are explicit and
  reproducible.
- `orchestration`
  A staged workflow that separates intake, design, build, and verification into
  bounded phases.
- `Codex subagent`
  A delegated collaborator inside one native Codex task. It is distinct from a
  RAE node, which starts a fresh durable `codex exec` session.
- `node instance`
  One immutable execution of a logical workflow node, optionally bound to a
  stable mapped-item key.
- `execution tier`
  A workflow-owned logical request for economy, standard, or judgment work. An
  operator-owned execution profile resolves it to a named Codex or OpenCode
  route without placing provider configuration in the workflow.
- `execution route`
  An operator-owned executor and model mapping selected by a logical tier or a
  node-specific override. Routes are stored in execution profile 3.0, not in
  workflow revisions.
- `task suite`
  A frozen, model-agnostic set of repository tasks with acceptance checks,
  identified by `suite_id` and `revision` and pinned by digest.
- `experiment`
  A preregistered comparison of arms over one task suite, with a hypothesis, a
  falsifier, metrics and analysis settings.
- `arm`
  One run configuration in an experiment: a workflow, execution profile,
  context mode or model, with all other options held fixed.
- `trial`
  One execution of one task under one arm in one repetition.
- `trial record`
  The immutable JSON outcome of a trial: run identity, outcome, measurements
  and evidence references. Failure-layer labels may be appended.
- `benchmark card`
  The generated report of an experiment: suite, hypothesis, arms, estimates,
  provenance, limitations and reproduction commands. It is derived from trial
  records.
- `preregistration digest`
  The SHA-256 of a suite's or experiment's canonical JSON. An experiment pins the
  suite digest before any trial runs.
- `failure layer label`
  A rater's assignment of a failed trial to `representation`, `inference`,
  `coordination`, `governance` or `none`.

## Thesis validation

Terms are part of the control surface. Stable vocabulary keeps runtime behavior,
benchmark interpretation, and governance claims from drifting apart.

## Related dossiers

- [CLM-017 documentation reliability](claims/dossiers/clm-017-documentation-reliability.md)

## Interpretation limits

- terminology improves auditability, but strong definitions do not replace
  evidence

## Source note

- [Diataxis](claims/bibliography.md#src-diataxis)
- [Shannon 1948](claims/bibliography.md#src-shannon-1948)
- [NIST GenAI Profile](claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](claims/bibliography.md#src-ieee-1012)
- [OpenAI evals guidance](claims/bibliography.md#src-openai-evals)
