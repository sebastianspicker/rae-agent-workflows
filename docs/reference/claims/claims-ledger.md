---
status: stable
owner: core
last_reviewed: 2026-10-07
source_of_truth: editorial
evidence_links: evidence-index.md
---

# Claims Ledger

## Claim classes

- `formal`
  Follows from a stated system model or contract.
- `engineering_heuristic`
  Strong operational guidance grounded in design or operational reasoning.
- `governance_rule`
  Normative publication or release policy.
- `implementation_reference`
  A claim whose behavioral truth is owned primarily by code, schema, or command
  surface rather than by external literature.

## Ledger

| Claim ID | Claim | Type | Status | Evidence | Dossier |
| --- | --- | --- | --- | --- | --- |
| CLM-002 | Documentation remains more maintainable when tutorial, how-to, reference, and explanation surfaces are kept distinct. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-002) | [Dossier](dossiers/clm-002-diataxis-separation.md) |
| CLM-005 | Narrow utilities belong outside the core runtime architecture when their job is explicit maintenance rather than task orchestration. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-005) | [Dossier](dossiers/clm-005-utility-placement.md) |
| CLM-007 | Increasing context length without increasing task-relevant information can reduce effective signal density and impair long-context performance. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-007) | [Dossier](dossiers/clm-007-information-density.md) |
| CLM-008 | Coordination overhead depends on communication topology; hub-and-spoke orchestration scales more favorably than unconstrained all-to-all collaboration. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-008) | [Dossier](dossiers/clm-008-coordination-topology.md) |
| CLM-014 | Separating planning, production, and verification reduces correlated error and self-certification risk compared with a single blended loop. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-014) | [Dossier](dossiers/clm-014-staged-separation.md) |
| CLM-016 | Reasoning budget, autonomy, and review intensity should be tiered by ambiguity, consequence of error, and checkability rather than maximized uniformly. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-016) | [Dossier](dossiers/clm-016-cognitive-tiering.md) |
| CLM-017 | Documentation quality affects operator behavior and therefore belongs inside the reliability model rather than outside it. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-017) | [Dossier](dossiers/clm-017-documentation-reliability.md) |
| CLM-020 | Failure analysis is more diagnostic when representation, inference, coordination, and governance failures are separated instead of collapsed into one label. | engineering_heuristic | provisional | [Evidence Index](evidence-index.md#clm-020) | [Dossier](dossiers/clm-020-layered-failure-model.md) |
| CLM-024 | Workflow 2.1 remains provider-neutral while execution profile 3.0 resolves explicit Codex and OpenCode routes locally; OpenCode mutation requires an isolated worktree, an exact denied-by-default tool surface, and the macOS containment backend. | implementation_reference | provisional | `packages/contracts/v1/schemas/workflows/execution-profile-v3.schema.json`, `packages/engine/src/agents/opencode-adapter.ts` | [Execution Profile 3.0](../contracts/execution-profile-v3.md) |
| CLM-025 | In the 2026-09-08 macOS Node 26 fixtures, catalog pages and shared event replay preserved reference results while bounding repeated parsing work. | implementation_reference | provisional | [Evidence mapping](evidence-index.md#clm-025) | [Measurements and limitations](../performance-measurements.md) |

## Metrics for provisional claims

No claim below has a retained measurement yet. Each stays `provisional` until
the named measurement is run and recorded in the
[Evidence Index](evidence-index.md). Each sentence states the observation that
would count against the claim.

| Claim ID | Falsifiable metric |
| --- | --- |
| CLM-002 | Over two releases, count drift corrections per page in `docs/`; the claim fails if pages that mix tutorial, how-to, reference, and explanation content need no more corrections per page than single-category pages. |
| CLM-005 | Over one release, count commits that change `tools/` or `profiles/`; the claim fails if more than 10 percent of them also require a change under `packages/engine/src/`. |
| CLM-007 | Run one frozen task set with `--context-mode legacy` and `--context-mode bounded`; the claim fails if the longer legacy context does not lower the gate pass rate by more than the run-to-run spread. |
| CLM-008 | For 2, 3, and 4 parallel reviewers on one frozen task set, the claim fails if a fully connected review topology does not use more provider attempts and wall-clock time per accepted result than the hub-and-spoke default. |
| CLM-014 | On a frozen task set with seeded defects, the claim fails if the default workflow does not let fewer seeded defects reach `implemented-awaiting-human-release-review` than a single-node workflow that plans, builds, and verifies its own work. |
| CLM-016 | On one frozen task set, the claim fails if a tiered execution profile does not lower provider cost per passed task compared with running every node at the `judgment` tier, or if it lowers the pass rate by more than the run-to-run spread. |
| CLM-017 | Over two releases, count support issues and failed operator actions traced to a documentation page; the claim fails if correcting those pages does not reduce the count for the corrected surface. |
| CLM-020 | Two reviewers label a sample of blocked runs by the four failure layers; the claim fails if their agreement (Cohen's kappa) is below 0.6 or if the layered label changes the chosen remediation in no more cases than a single "agent failed" label. |

## Status meanings

- `adopted`
  Current repo policy or accepted modeling stance.
- `provisional`
  Plausible and useful, but without a retained measurement. A provisional
  claim names the metric that would test it.
- `rejected`
  Found not to hold under current evidence.

## Source note

- [Diataxis](bibliography.md#src-diataxis)
- [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- [Model Cards](bibliography.md#src-model-cards)
- [Datasheets](bibliography.md#src-datasheets)
- [IEEE 1012](bibliography.md#src-ieee-1012)
- [Brooks no silver bullet](bibliography.md#src-brooks-no-silver-bullet)
- [Amdahl 1967](bibliography.md#src-amdahl-1967)
