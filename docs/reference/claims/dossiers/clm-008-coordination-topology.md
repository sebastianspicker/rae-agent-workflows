---
status: stable
owner: science
last_reviewed: 2026-10-07
source_of_truth: docs/reference/claims/claims-ledger.md
evidence_links: ../evidence-index.md#clm-008
---

# CLM-008 Coordination Topology

## Claim statement

Coordination overhead depends on communication topology; hub-and-spoke
orchestration scales more favorably than unconstrained all-to-all
collaboration.

## Claim class

`engineering_heuristic`

## Proof mode

Graph-based scaling argument supported by socio-technical coordination
literature.

## Assumptions

- coordination cost rises with active communication edges and merge burden
- not all contributors need direct pairwise coordination
- quality gain from more contributors can saturate before merge cost does

## Internal anchors

- `docs/explanation/science/coordination-cost.md`
- `docs/reference/engine/orchestration-policy.md`

## External anchors

- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [Conway 1968](../bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../bibliography.md#src-cataldo-congruence)
- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)

## Benchmark artifacts

No frozen umbrella benchmark currently fits a topology-ablation estimate.

## Counterarguments

- small all-to-all review can outperform centralized routing on short, ambiguous
  work
- serial bottlenecks can appear if the coordinator becomes overloaded

## Validity threats

- edge count is an explanatory proxy rather than a calibrated cost model
- communication quality matters alongside topology

## Review status

Provisional as an analytical design argument. Only the edge counts are
formal; the cost comparison assumes uniform per-edge cost and uncalibrated
coefficients.
No retained measurement supports it yet; the
[claims ledger](../claims-ledger.md#metrics-for-provisional-claims) names the
metric that would test it.

## Source note

- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [Conway 1968](../bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../bibliography.md#src-cataldo-congruence)
- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
