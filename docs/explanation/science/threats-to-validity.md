---
status: stable
owner: science
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: ../../reference/claims/evidence-index.md
---

# Threats to Validity

A reliability claim means little without the validity threats that could distort
it. Read every such claim together with the threats below.

## Benchmark threats

- contamination from public tasks or solutions
- narrow tests that reject correct solutions
- wide tests that require unspecified behavior
- dev-set overfitting disguised as general capability

## Judge threats

- rubric ambiguity
- model judge drift across versions
- silent changes in provider instructions or calibration
- weak agreement against stronger references

## Documentation threats

- reference pages becoming opinion pages
- explanation pages inheriting false authority
- implementation drift outrunning documentation review

## Model and workflow threats

- context-selection heuristics may not transfer across task families
- coordination benefits can reverse when the merge surface is weak
- stage boundaries can add delay or bureaucracy without measurable gain

## Sampling threats

- imported source repos may not represent the full design space
- benchmark families can overweight tasks that match the current architecture

## Experiment threats

These apply to results produced by the [experiment layer](experimental-method.md).

- order and drift effects: provider load, model updates and rate limits change
  over time, and interleaving spreads them across arms without removing them
- acceptance-check validity: a task-specific check can reject a correct
  solution or accept an incomplete one, and a seeded-defect detector measures
  only the defect it was written for
- small n and wide intervals: a smoke-sized experiment has few matched pairs,
  so intervals are wide and an `inconclusive` verdict is the expected outcome
  for a modest effect
- multiple comparisons: every secondary metric and every extra arm adds
  chances for a false positive; report v2 applies Holm across the report, but
  optional stopping and unreported analyses remain uncontrolled
- operator-supplied prices: estimated cost is only as accurate as the prices
  the operator entered, and it excludes trials with partial token measurement
- attrition and retry bias: resume now retains failures; deleting records or
  selecting a successful rerun can still bias results. Incomplete primary
  coverage withholds the verdict, while complete-case estimates remain
  potentially biased
- task dependence: task-level inference groups repetitions, but correlated
  tasks from one repository are not independent; use a justified sampling unit
- fixture repositories that are too small to exercise the workflow: a
  dependency-free project with a few files does not stress context selection,
  repair loops or critic separation, so differences between arms may be
  understated

## Interpretation rule

A publishable claim should identify at least:

- what was sampled
- what was not sampled
- which measurement surfaces might have drifted
- where contamination or rubric weakness could distort interpretation

Any strong claim about reliability should be read together with this page and
[Limitations](limitations.md).

## Source note

- [OpenAI on SWE-bench contamination](../../reference/claims/bibliography.md#src-openai-swebench-verified)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [G-Eval](../../reference/claims/bibliography.md#src-g-eval)
- [Artstein and Poesio](../../reference/claims/bibliography.md#src-artstein-poesio)
- [Chen et al., Evaluating Large Language Models Trained on Code](../../reference/claims/bibliography.md#src-chen-codex-pass-at-k)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
