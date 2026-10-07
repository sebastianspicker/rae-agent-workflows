---
status: stable
owner: science
last_reviewed: 2026-10-07
source_of_truth: ../supplementary/formal-model.md
evidence_links: ../../reference/claims/dossiers/clm-014-staged-separation.md
---

# Workflow State Formalization

## Purpose

This companion gives the science layer a compact workflow-state model so the
main articles stay readable.

## State space

Let the workflow be a labeled transition system:

$$
\mathcal{W} = (\mathcal{S}, \Sigma, T, s_0)
$$

where $\mathcal{S}$ is the set of states, $\Sigma$ the transition labels, $T$ the
allowed transitions, and $s_0$ the entry state.

This is a coarse abstraction of the workflow DAG in the
[Formal Model](../supplementary/formal-model.md), not a separate model. Its six
states are regions of the default graph workflow:

$$
\mathcal{S} = (\text{intake}, \text{design}, \text{plan}, \text{build}, \text{verify}, \text{release})
$$

| State | DAG region (default workflow) |
| --- | --- |
| intake | `requirements` |
| design | `design`, the design critics, `design-collection`, `design-adjudication` |
| plan | `plan` (ownership plan), `alignment-a`, `alignment-b`, `alignment-gate` |
| build | `mutation-checkpoint`, `build` |
| verify | `repair-loop` members (critics, `diagnose`, `repair`) and `verification` |
| release | `release-checkpoint`, `complete`; RAE itself never publishes |

The legacy ten-phase pipeline is a different refinement of the same six states
and is documented in the Formal Model as legacy.

## Gate-mediated progression

Progression is allowed only when the outgoing artifact satisfies the local gate:

$$
(s_k \rightarrow s_{k+1}) \in T
\iff
G_k(A_k) \text{ is accepting}
$$

An accepting outcome is `passed` in graph mode and `pass` or `warn` in the
legacy pipeline (see
[Gate outcomes](../supplementary/formal-model.md#gate-outcomes)). This
formalizes the distinction between doing work and being allowed to advance.

## Why the model matters

- it makes stage separation explicit
- it exposes where self-certification can occur
- it creates a home for artifact, gate, and evidence traceability

## Related dossiers

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)

## Interpretation limits

- real workflows loop (the verify region can send control back to its critics), branch, and pause more than this simplified model

## Source note

- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
