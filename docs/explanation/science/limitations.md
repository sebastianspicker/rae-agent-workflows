---
status: stable
owner: science
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: ../../reference/claims/assumptions-register.md
---

# Limitations

RAE is a public reference system with explicit scope boundaries. Read it as
evidence-bearing engineering guidance, not as proof that agents are reliable in
general.

## Current limits

- the public profile payload is intentionally generic; it is a safe baseline,
  not a full operator-specific environment
- a four-task smoke suite and three preregistered experiment designs exist
  under `experiments/`, but no results are retained yet; the smoke suite is a
  tooling check for the runner, not a capability benchmark, and any future
  suite would still not be a universal measure of all agent performance (see
  ASM-003 and ASM-006 in the [assumptions register](../../reference/claims/assumptions-register.md)
  and the [experimental method](experimental-method.md))
- the only tracked measurements are the local performance fixtures in
  [Local performance measurements](../../reference/performance-measurements.md),
  which are partly not reproducible from a clone
- contamination-aware interpretation still matters whenever results are used for
  broader capability claims

## Science-layer limits

- several equations in the science layer are explanatory rather than benchmark
  calibrated
- dossier coverage now exists for the core science claims, but not yet for the
  entire repository corpus
- the seven-source rule is locked, yet much of the operational corpus still
  needs its companion source packets in later tranches

## Practical implication

You can use the repo for public release, local verification, and operator
workflows backed by tests and the local performance fixtures; no retained
experiment result backs them yet. You should not treat it as a complete proof that one single
architecture dominates every agent-engineering setting.

## Source note

- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [OpenAI on SWE-bench contamination](../../reference/claims/bibliography.md#src-openai-swebench-verified)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Lost in the Middle](../../reference/claims/bibliography.md#src-lost-in-the-middle)
