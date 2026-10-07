---
status: stable
owner: science
last_reviewed: 2026-10-07
source_of_truth: ../science/drift-and-self-certification.md
evidence_links: ../../reference/claims/dossiers/clm-020-layered-failure-model.md
---

# Drift and Error Propagation

## Purpose

This companion expands the science-layer intuition that defects propagate when
they survive several stages without interception.

## Approximate survival model

Let $\pi_j$ be the probability that a harmful defect is introduced at phase $j$,
$r_k$ the probability that phase $k$ preserves a defect already present, and
$q_k$ the probability that gate $k$ detects it ($q_k = 0$ without a gate). An
approximate survival probability is:

$$
P_{\text{survive}} = \sum_{j=1}^{K} \pi_j \prod_{k>j} r_k (1 - q_k)
$$

When preservation is certain this reduces, for a defect introduced at phase $j$,
to $\prod_{k>j}(1 - q_k)$. With every $q_k = 0$ survival does not shrink with
the number of phases; it shrinks only through detecting gates. The expression
is heuristic, but it shows why repeated gates, not repeated stages, lower the
chance that one mistake survives to publication.

## Drift accumulation

Let $u \in \{D, P, \mathrm{Rep}\}$ range over upstream artifacts: design $D$,
plan $P$, and reporting or release doctrine $\mathrm{Rep}$. Define $C(u)$ as the
set of checkable constraints that artifact $u$ imposes (design constraints, plan
commitments such as owned paths and verification requirements, doctrine rules),
and let $\operatorname{Drift}(u, X) \in [0, 1]$ be the fraction of $C(u)$ that
the realized state $X$ violates. Drift against all sources at one moment is a
weighted sum with normalised weights:

$$
\operatorname{Drift}_{\text{total}}(X)
=
\sum_{u} \beta_u \operatorname{Drift}(u, X),
\qquad \beta_u \ge 0,\ \sum_u \beta_u = 1
$$

so $\operatorname{Drift}_{\text{total}} \in [0, 1]$. This is a static snapshot.
Accumulation across stages is a recurrence: with $d_k$ the total drift after
stage $k$, $\delta_k$ the drift newly introduced by stage $k$, and $q_k$ the
fraction of existing drift that gate $k$ detects and corrects,

$$
d_k = \min\bigl(1,\ (1 - q_k)\, d_{k-1} + \delta_k\bigr), \qquad d_0 = 0
$$

Unresolved drift therefore persists across stages unless a gate removes it.

## Related dossiers

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-020 layered failure model](../../reference/claims/dossiers/clm-020-layered-failure-model.md)

## Interpretation limits

- the coefficients are not benchmark-calibrated
- phase errors are not truly independent
- $\beta_u$, $\delta_k$, and the violation fractions are not measured

## Source note

- [Shannon 1948](../../reference/claims/bibliography.md#src-shannon-1948)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
