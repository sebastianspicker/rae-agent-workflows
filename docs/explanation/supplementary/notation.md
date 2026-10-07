---
status: stable
owner: science
last_reviewed: 2026-10-07
source_of_truth: editorial
evidence_links: ../../reference/claims/claims-ledger.md
---

# Notation

These are the symbols used across the science layer. Fixing them in one place
keeps the surrounding arguments precise.

## Editorial contract

- Inline formulas use `$...$` and display formulas use `$$...$$`.
- Symbols defined here are the default symbols for the surrounding science
  pages.
- Display equations are unnumbered by default; add numbering only when a page
  refers back to the same equation repeatedly.
- Where a symbol is reused on a page for a different purpose, the overload is
  listed in the table below.
- The notation is explanatory; it is not a claim that the full socio-technical
  system is exactly parameterized.

## Core variables

- $I$
  Human or organizational intent.
- $C$
  Context presented to a model or runtime.
- $S$
  Signal-bearing part of context.
- $N$
  Noise or weakly relevant part of context.
- $Y$
  Output emitted by a model, stage, or loop.
- $A_k$
  Artifact produced at phase `k`.
- $G_k$
  Gate predicate or gate result attached to phase `k`.
- $X$
  Realized implementation or repository state.
- $D$
  Design artifact.
- $P$
  Plan artifact.
- $n$
  Number of active contributors, workers, or reviewers.
- $K$
  Number of phases on the path considered.
- $\pi_j$
  Probability that a harmful defect is introduced at phase `j`.
- $\mathrm{Rep}$
  Reporting or release doctrine, as an upstream artifact for drift.

## Information-theoretic quantities

- $H(C)$
  Entropy or description length of context.
- $\mathcal{I}(I; C)$
  Mutual information between intent and provided context.
- $\rho(C) = \mathrm{SNR}_{\text{info}}$
  Informal signal-density proxy, defined as $\mathcal{I}(I; C) / H(C)$ with
  $H$ in bits. The two names denote one quantity.
- $K_{\text{noise}}$
  Number of additional weakly relevant or irrelevant tokens.
- $\Delta$
  Logit gap between relevant and irrelevant tokens.

## Reliability quantities

- $r_k$
  Probability that phase `k` preserves a defect that already exists.
- $q_k$
  Probability that gate `k` detects a defect that already exists.
- $P_{\text{survive}}$
  Probability that a defect survives to the end of the path.
- $\operatorname{Drift}(u, X)$
  Fraction of the constraint set $C(u)$ of upstream artifact
  $u \in \{D, P, \mathrm{Rep}\}$ violated by $X$, in $[0, 1]$.
- $\beta_u$
  Normalised weight ($\sum_u \beta_u = 1$) of source $u$ in
  $\operatorname{Drift}_{\text{total}}$.
- $d_k$, $\delta_k$
  Total drift after stage `k` and drift newly introduced at stage `k`.

## Coordination quantities

- $E_{\text{complete}}(n) = n(n-1)/2$
  Number of communication edges in a fully connected team.
- $E_{\text{star}}(n) = n-1$
  Number of edges in a hub-and-spoke topology.
- $C_{\text{coord}}(n)$
  Coordination cost under a chosen topology.
- $C_{\text{infer}}(n)$
  Inference or runtime cost induced by $n$ contributors.
- $B(n)$
  Benefit from using $n$ active contributors.
- $\lambda$, $\mu$
  Weights converting $C_{\text{infer}}$ and $C_{\text{coord}}$ into units of
  benefit in $\Delta(n) = B(n) - \lambda C_{\text{infer}}(n) - \mu C_{\text{coord}}(n)$.
- $\alpha$
  Average coordination cost per communication edge.

## Overloaded symbols

| Symbol | Default meaning | Other use | Page |
| --- | --- | --- | --- |
| $S$ | Signal-bearing context | State set, written $\mathcal{S}$ | Workflow State Formalization |
| $P$ | Plan artifact | Subscripted $P_{\text{survive}}$ is a probability | Formal Model, Drift and Error Propagation |
| $R$ | Reliability, $R = R_{\text{execution}} \cap \dots$ | Reporting doctrine is written $\mathrm{Rep}$ | Problem Statement, Drift and Error Propagation |
| $C$ | Context | $C(u)$ is the constraint set of artifact $u$; $C_{\text{infer}}$, $C_{\text{coord}}$ are costs | Drift and Error Propagation, Coordination Cost |
| $K$ | Number of phases | Noise-token count is written $K_{\text{noise}}$ | Information Theory |

## Interpretation note

Most of the formalism in this repo is explanatory modeling, not a claim that the
full engineering process is closed-form or exactly measurable. The mathematical
objects are there to sharpen reasoning, surface assumptions, and constrain
claims.

## Related dossiers

- [CLM-007 information density](../../reference/claims/dossiers/clm-007-information-density.md)
- [CLM-008 coordination topology](../../reference/claims/dossiers/clm-008-coordination-topology.md)

## Source note

- [Shannon 1948](../../reference/claims/bibliography.md#src-shannon-1948)
- [Cover and Thomas](../../reference/claims/bibliography.md#src-cover-thomas)
- [Transformer](../../reference/claims/bibliography.md#src-transformer)
- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [Conway 1968](../../reference/claims/bibliography.md#src-conway-1968)
- [Cohen kappa](../../reference/claims/bibliography.md#src-cohen-kappa)
- [Artstein and Poesio](../../reference/claims/bibliography.md#src-artstein-poesio)
