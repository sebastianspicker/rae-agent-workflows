---
status: stable
owner: core
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: claims-ledger.md
---

# Assumptions Register

| ID | Assumption | Scope | Review Trigger | Current Risk |
| --- | --- | --- | --- | --- |
| ASM-001 | Docs-first unification is lower-risk than immediate cross-module runtime rewriting. | repository architecture | first integrated release candidate | medium |
| ASM-002 | Public profile material can be sanitized from private source repos without undermining operator usefulness. | profile publication | first public profile import | medium |
| ASM-003 | Benchmark metadata can remain model-agnostic even if scenario execution uses different runners. | evals | first populated benchmark family (fired 2026-10-08: `rae-smoke-v1`; trial records name provider, model and runtime and are model-agnostic) | low |
| ASM-004 | Package-local docs can continue to act as command truth while umbrella docs act as scientific and governance truth. | documentation architecture | first major CLI surface change | low |
| ASM-005 | Current imported modules are representative enough to anchor a public reference architecture, even before additional task families are added. | external validity | first public benchmark report | high |
| ASM-006 | The four-task smoke suite exercises the runner but is not representative of real maintenance work. | external validity | first suite with at least 20 tasks | high |

## Use rule

An assumption is not a hidden fact. It is a tracked dependency that should be
revisited when the corresponding trigger fires.

## Thesis validation

The register keeps publication honest: it separates accepted scope dependencies
from claims that are already supported well enough to adopt without a caveat.

## Interpretation limits

- assumptions reduce hidden uncertainty but do not resolve it
- some assumptions will remain provisional until broader benchmark coverage
  exists

## Source note

- [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- [Model Cards](bibliography.md#src-model-cards)
- [Datasheets](bibliography.md#src-datasheets)
- [OpenAI evals guidance](bibliography.md#src-openai-evals)
- [PaperBench](bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](bibliography.md#src-nosek-open-research)
