---
status: stable
owner: science
last_reviewed: 2026-10-07
source_of_truth: editorial
evidence_links: ../../reference/claims/claims-ledger.md
---

# Formal Model

The repository's scientific layer uses a modest formal model: enough structure
to reason about failure propagation, coordination, and evidence quality, without
pretending the full socio-technical system is analytically solved.

## Problem statement

The aim is to explain why RAE prefers staged progression, explicit gates,
bounded parallelism, and evidence-linked publication rather than one blended
agent loop.

## Definitions

- $A_k$
  Artifact produced at phase or node $k$.
- $G_k(A_k)$
  Gate decision over artifact $A_k$.
- $\pi_j$
  Probability that a harmful defect is introduced at phase $j$.
- $r_k$
  Probability that a defect already present is preserved (not repaired or
  dropped) through phase $k$.
- $q_k$
  Probability that gate $k$ detects a harmful defect already present. It is $0$
  for a phase without a gate.
- $K$
  Number of phases on the path considered.
- $B(n)$
  Benefit from using $n$ active contributors.
- $C_{\text{infer}}(n)$
  Inference or runtime cost induced by $n$ contributors.
- $C_{\text{coord}}(n)$
  Coordination cost induced by the chosen topology.
- $\lambda$, $\mu$
  Non-negative weights converting inference and coordination cost into units of
  benefit.

## Gate outcomes

One outcome set per execution path:

- Legacy ten-phase pipeline (`--legacy-linear`): $G_k \in \{\text{pass},
  \text{warn}, \text{fail}\}$. `warn` always advances; only `fail` blocks.
- Graph workflow (default): a gate or node envelope is $\text{passed}$ or
  $\text{failed}$. A gate fails when any input envelope status is not
  $\text{passed}$.

`orchestrate record-gate` is an operator assertion, not an evaluation; see the
[Orchestration CLI](../../reference/cli/orchestration.md#record-gate).

## Assumptions

- The default orchestrated system is a workflow DAG; the legacy pipeline is a
  finite ordered sequence of ten phases.
- Gate outputs are coarse but meaningful progression decisions.
- Defect events across phases are not perfectly independent, so the survival
  model below is heuristic rather than calibrated.
- Publication rules are governance constraints, not theorems about truth.

## Proposition 1: progression is gated rather than implicit

Treat the orchestrated system as a workflow DAG
$W = (V, E, v_{\text{entry}}, v_{\text{term}})$ whose nodes may carry the
marks $\text{own}$ (ownership plan), $\text{mut}$ (mutation checkpoint), and
$\text{ver}$ (verification gate). Let $V_w \subseteq V$ be the nodes with write
access. The workflow validator
(`packages/engine/src/workflow/workflow-contract.ts`) accepts $W$ only if:

1. every writer is dominated by an ownership plan and by a mutation checkpoint:
   $\forall w \in V_w\ \exists o, m:\ \text{own}(o) \land \text{mut}(m) \land
   o\ \operatorname{dom}\ w \land m\ \operatorname{dom}\ w$
2. every path to the terminal passes a verification gate:
   $\exists g:\ \text{ver}(g) \land g\ \operatorname{dom}\ v_{\text{term}}$
3. writers are serialised: for distinct $w, w' \in V_w$, one reaches the other
   (loop-back edges included).

A node runs once its incoming edges are satisfied, and a gate node advances only
on $\text{passed}$:

$$
\operatorname{advance}(g \rightarrow v)
\iff
\forall e \in \operatorname{in}(g):\ \operatorname{status}(e) = \text{passed}
$$

The formal claim is that a writer cannot run, and the terminal cannot be
reached, except through an explicit decision surface. This is a structural
guarantee of the contract, not a statement about gate quality. A mutation
checkpoint only pauses for a human under a checkpoint policy that requests it;
under `before-mutation-and-ship` a second checkpoint (`release-checkpoint`,
`mutation_checkpoint: false`) also pauses before `complete`.

### Legacy ten-phase model

The `--legacy-linear` engine instead runs the sequence

$$
\mathcal{P}_{\text{legacy}} =
(\text{arm},
\text{design},
\text{adversarial-review},
\text{plan},
\text{pmatch},
\text{build},
\text{quality-static},
\text{quality-tests},
\text{post-build},
\text{release-readiness})
$$

with the progression rule

$$
\operatorname{advance}(k \rightarrow k + 1)
\iff
G_k(A_k) \in \{\text{pass}, \text{warn}\}
$$

## Proposition 2: staged interception multiplies defect-detection opportunities

Let a defect be introduced at phase $j$ with probability $\pi_j$ and be preserved
through each later phase $k$ with probability $r_k$ unless gate $k$ detects it
with probability $q_k$. An approximate end-to-end defect survival probability
is:

$$
P_{\text{survive}} = \sum_{j=1}^{K} \pi_j \prod_{k > j} r_k (1 - q_k)
$$

When preservation is certain ($r_k = 1$), a defect introduced at phase $j$
survives with probability $\prod_{k > j}(1 - q_k)$ (use $k \ge j$ if gate $j$
also examines its own output). With all $q_k = 0$ the product reduces to
$\prod_{k>j} r_k$, which does not depend on how many gated phases exist: adding
stages without gates does not lower survival. Survival falls only through
factors $q_k > 0$, so gates, not phases, are what reduce it.

This is not a calibrated estimator. It formalizes an engineering intuition:
separate gates create repeated interception opportunities, while a single loop
often compresses them into one weak detection surface. Correlated gate misses
make the product optimistic.

## Proposition 3: scale-out is justified only when it beats inference and coordination cost

The coordination decision can be written as:

$$
\Delta(n) = B(n) - \lambda C_{\text{infer}}(n) - \mu C_{\text{coord}}(n)
$$

Increase $n$ only when the expected quality or throughput benefit dominates both
inference and coordination cost. This links directly to
[Coordination Cost](../science/coordination-cost.md).

## Proposition 4: publication requires more than implementation prose

Let $c$ be a public claim, $a_i$ an internal anchor, and $e_j$ an external
anchor or benchmark artifact. The governance publication rule is:

$$
\operatorname{publishable}(c)
\iff
(\exists a_i) \land (\exists e_j)
$$

for a claim-bearing artifact $c$, subject to the provenance rules in
[Provenance Requirements](../../reference/invariants/provenance-requirements.md).
A local policy may decide whether a non-claim-bearing artifact (for example a
how-to page) is published, but it never replaces an external anchor for a claim.

This prevents a common category error: treating explanatory implementation prose
as if it were empirical evidence.

## Companion and dossier links

- [CLM-007 information density](../../reference/claims/dossiers/clm-007-information-density.md)
- [CLM-008 coordination topology](../../reference/claims/dossiers/clm-008-coordination-topology.md)
- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [Workflow State Formalization](../companion/workflow-state-formalization.md)

## Interpretation limits

- $\pi_j$, $r_k$, $q_k$, $\lambda$, and $\mu$ are heuristic coefficients unless a
  benchmark family calibrates them explicitly.
- The model is explanatory and governance-oriented, not a proof that every RAE
  release achieves a given reliability level.
- Read this page together with
  [Threats to Validity](../science/threats-to-validity.md),
  [Limitations](../science/limitations.md), and
  [Contracts and Gates](../science/contracts-and-gates.md).

## Source note

- [Shannon 1948](../../reference/claims/bibliography.md#src-shannon-1948)
- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
