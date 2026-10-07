---
status: experimental
owner: orchestration
last_reviewed: 2026-10-07
source_of_truth: packages/contracts/v1/schemas
evidence_links: ../claims/evidence-index.md
---

# Artifact Schemas

Artifact schemas live under `packages/contracts/v1/schemas/`.

Public rule:

- contracts must define structure
- gates must define acceptance logic
- reporting artifacts must carry provenance when they support public claims

Current imported schema set includes:

- brief
- design document
- review report
- review loop
- execution plan
- drift report
- progress summary
- quality report
- release readiness
- execution trace
- graph manifest, node, edge, context bundle, and memory decision
- graph-native workflow 2.0 and immutable node-result envelope 2.0
- graph-native workflow and node-instance envelope 2.1
- workflow finding: the shared `severity` (`blocking`, `major`, `minor`, or
  `info`), `blocking`, `evidence_ref`, and `summary` shape. It is not a schema
  file: the engine exports it as `FINDING_SCHEMA`, workflow JSON inlines it as
  the `items` of every `findings` property, and workflow authoring validation
  requires it (see [Workflow 2.0 and 2.1 Contract](workflow-v2.md#findings))
- operator-owned execution profile with economy, standard, and judgment tiers
- graph-native workflow and immutable node-result envelope 2.2
- build report: output of the `/build` phase, a summary of coordinated build execution
- context manifest gate: gate artifact for the context manifest
- operator checkpoint: checkpoint state recorded by the operator
- operator control: operator control state
- traceability check: normalized gate input for traceability checks
- skill manifest: manifest describing a packaged skill or tool (`manifest.yaml`)
- tool definition: definition of a callable tool
- run result: standard result envelope emitted by tools (`success`, `data`, `error`, `metadata`)
- permissions: sandbox permissions for a tool image
- quality gate: reusable gate that validates an artifact against criteria and blocks progression on failure
- autonomous policy: structural schema for the narrow experimental autonomous policy surface

Versions 2.0 and 2.1 accept the optional run-level budgets
`max_wall_clock_seconds` and `max_provider_attempts`; they were added without a
new schema version.

Version 2.1 adds bounded maps, item streams, allowlisted transforms, threshold
joins, typed failure collection, until-dry convergence, and immutable instance
identity. Version 2.0 remains a separate accepted contract for existing run
snapshots and locally activated revisions. RAE does not rewrite private
registries or stored runs on disk. See
[Workflow 2.0 and 2.1 Contract](workflow-v2.md) for node, edge, gate, loop, and
budget semantics.

Run artifacts created before the contract package was versioned may contain a
`contracts/...` schema reference. The engine maps only those known schema
paths to `packages/contracts/v1/schemas/...`; arbitrary repository-local
schema references retain their original meaning.

Version 2.2 adds local durable wait nodes, typed signal contracts, bounded
context manifests, and immutable references for predecessor records that do
not fit inline. It is experimental and does not connect the local scheduler to
the hosted platform. See [Workflow 2.2 Contract](workflow-v2.2.md).

## Interpretation limits

- schema validity can still coexist with weak or misleading content

## Source note

- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Diataxis](../claims/bibliography.md#src-diataxis)
- [Brooks no silver bullet](../claims/bibliography.md#src-brooks-no-silver-bullet)
- [Amdahl 1967](../claims/bibliography.md#src-amdahl-1967)
