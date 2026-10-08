---
status: stable
owner: science
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: ../../reference/contracts/experiments-v1.md
---

# Experimental Method

The claims ledger lists provisional claims with falsifiable metrics. The
experiment layer is the procedure that measures them. This page explains the
design choices behind it. The fields are specified in
[Experiments 1.0 contracts](../../reference/contracts/experiments-v1.md), and
the commands are in [Run an experiment](../../how-to/run-an-experiment.md).

## A frozen suite and a preregistered design

A comparison is only as good as the tasks it uses. If tasks change between
arms or after the results are known, any difference can be explained away or
manufactured. RAE therefore freezes two documents before a run:

- the task suite, with its repositories, prompts and acceptance checks;
- the experiment, with its arms, hypothesis, falsifier, metrics, repetitions,
  seed and analysis settings.

The experiment pins the suite by digest, the SHA-256 of the suite's canonical
JSON. The runner copies the experiment digest and the suite digest into the
lock file, every trial record and the report. The digest is a commitment: a
reader can check that the suite used for the report is the suite the authors
named before running. It does not prove when the file was written. Publishing
the experiment file in version control before the run supplies the timestamp.

A change to a task, a fixture or a design setting is a new revision with a new
digest. An old report stays attached to the digest it was produced with.

## Arms and matched pairs

An arm is one run configuration: a workflow, an execution profile, a context
mode, a model. An experiment varies the configuration between arms and holds
everything else fixed: the suite, the prompts, the repository fixtures, the
provider and the checkpoint policy.

Every arm runs every selected task in every repetition. Report v2 defaults
to `analysis.unit: task`: match (task, repetition) outcomes, average the
matched repetitions within each task, and give tasks equal weight. Bootstrap
resampling and sign flips operate on tasks. Adding identical repetitions
therefore cannot manufacture more independent evidence. The task comparison
requires `design.paired` to be true. The explicit `analysis.unit: trial`
option retains legacy inference on trial pairs, including unpaired analysis
when `design.paired` is false; it assumes independent trials.

Task-level inference assumes independent, exchangeable task clusters and
exchangeability of arm labels under the null. Related tasks from the same
repository, shared provider state, or shared models can violate these
assumptions. The default estimates variation across observed task means, not
a nested bootstrap of both task selection and repeated executions. Few tasks
and constant outcomes can produce degenerate bootstrap intervals; a narrow
interval alone is not strong evidence. Choose the independent unit and the
population of interest before collection.

## Interleaved ordering

Provider latency, rate limits and model behaviour drift over hours and days. If
one arm ran first and the other later, time would be confounded with the arm.
With `order: interleaved` (the default) the plan shuffles the task order inside
each repetition from the design seed and rotates the arm order from task to
task. Both arms then sample the same stretches of time. The plan is a pure
function of the experiment file, so a resumed run continues the same order.

Interleaving spreads drift across arms; it does not remove it. Provider
changes during a long experiment remain a threat. The report lists the
provider, model and runtime identities seen in the trials so that a change is
visible.

## Estimators

The report uses simple, standard estimators, each seeded so that the same
records and the same seed give the same report.

| Quantity | Method | Why |
| --- | --- | --- |
| Task-level rates and continuous means (default) | Percentile bootstrap over per-task means | Gives tasks equal weight and keeps repetitions within their task |
| Trial-level proportions (explicit legacy mode) | Wilson score interval | Assumes independent binary observations |
| Mean of a continuous metric | Percentile bootstrap | Avoids a normality model but still requires representative, independent sampling units |
| Paired binary outcome in trial mode | Exact McNemar test on the discordant pairs | Only pairs where the arms disagree carry information; the exact test needs no large-sample approximation |
| Paired task means or continuous trial outcomes | Sign-flip permutation test on the paired differences | It tests the null that the arm label does not matter, with no normality assumption |
| Unpaired outcomes | Label permutation test and unpaired bootstrap | The fallback when pairing is switched off |
| Several arms against one control | Holm step-down correction across all arm/metric comparisons | It controls the family-wise error rate and is never less powerful than Bonferroni |
| Repeated attempts | Unbiased pass@k estimator (Chen et al. 2021) | It estimates the chance that at least one of k attempts passes from n >= k attempts without resampling bias |
| Effect size | Risk difference for proportions, Cliff's delta for continuous metrics | Both are on a bounded, interpretable scale and do not depend on a distribution |
| Rater agreement on failure layers | Cohen's kappa | It corrects observed agreement for chance |

pass@k is computed per task and averaged over tasks. Tasks with fewer than k
completed trials in an arm are excluded from that k, and the report states how
many tasks entered each estimate.

A comparison with fewer than two evaluable units reports test `none` and no
interval. A single-unit summary retains its estimate but has null interval bounds. The report never fills in a number it cannot compute.

## What the verdict means

The verdict compares the treatment arm with the control arm on the primary
metric:

- `supported`: the adjusted p-value is below alpha and the difference has the
  direction the design predicted;
- `refuted`: the adjusted p-value is below alpha and the difference has the
  opposite direction;
- `inconclusive`: the difference is not significant;
- `not-evaluated`: there are too few independent units, an incomplete primary
  outcome in any arm, or a truncated full design.

Coverage is reported by arm, task and metric. Failed or missing outcomes are
not silently imputed; the report shows complete-case estimates and bounds on
pass rate over all planned trials. These bounds are not confidence intervals.
When coverage is incomplete, comparisons are exploratory and the
confirmatory verdict is withheld. Global Holm correction covers the listed
hypotheses (unevaluable comparisons remain in the family at p=1 for adjustment),
not repeated inspection, optional stopping or unreported analyses.
Confidence intervals are pointwise, not simultaneous. The existing field
`minimum_detectable_effect` is a practical threshold supplied by the author;
it is not a computed power analysis, and crossing it is not proof of a
practically meaningful population effect.

The verdict is a statement about the frozen suite, the arms as configured, the
models and runtime named in the provenance, and the days of the run. It is not
a statement that the claim holds for other repositories, other models or real
maintenance work. `inconclusive` is not evidence of no effect; with few trials
it is the expected outcome for a real but modest effect. When the design sets a
`minimum_detectable_effect`, the rationale says whether the estimate reaches
it, so that a significant but negligible difference is visible as such.

A claim's metric in the ledger can be broader than the primary metric that
encodes it. For example, CLM-016 speaks of cost per passed task, while the
experiment tests mean estimated cost per trial and reports the pass rate as a
secondary metric. Read the rationale together with the secondary comparisons.

## Cost estimation

RAE does not ship prices. An arm may carry a `pricing` block with prices the
operator supplies. The estimated cost of a trial is the measured tokens times
those prices, and it is computed only when the token measurement of the trial
is `complete`. Otherwise the cost is null, and the trial is left out of cost
comparisons.

Treat cost figures with care:

- prices change and differ by contract, so the figure is an estimate on the
  stated basis, not an invoice;
- Codex reports cached input tokens as a subset of input tokens; the cached
  share is charged once, at the cached price when one is given and at the
  input price otherwise, never in addition to the input price;
- reasoning tokens are charged separately only when
  `reasoning_output_per_million` is set. Codex output tokens may already
  include reasoning tokens, and charging both would count them twice;
- partial or unavailable token measurements shrink the sample used for cost.
  The report counts them per arm under `tokens_measurement`.

## Power and the minimum detectable effect

Small experiments have little power, and the design should say so up front.
With n matched pairs, the exact McNemar test uses only the discordant pairs. If
there are d of them, the smallest possible two-sided p-value is 2 x 0.5^d. At
d = 5 that is 0.0625, so no outcome can reach alpha = 0.05; at d = 6 it is
0.031. In practice the test has little power below roughly 10 discordant pairs.
How many pairs are discordant depends on how often the arms disagree, so a
small true effect needs many more pairs than a large one. The same bound
applies to the sign-flip permutation test: with m non-zero differences the
smallest p-value is 2 x 0.5^m.

The smoke designs under `experiments/` have 12 matched pairs (four tasks and
three repetitions) or 6 (two tasks and three repetitions). They check that the
machinery works. They are not sized to detect a modest effect. For a real
question, set `minimum_detectable_effect` to the smallest difference that would
matter, estimate the discordant rate from a pilot, and raise repetitions or
add tasks before the preregistered run. Adding repetitions of the same tasks
reduces run-to-run noise but not task sampling noise; only more tasks widen
what the result can say.

## Failure-layer labels

Trial records can carry labels from the four-layer failure model:
representation, inference, coordination and governance, plus `none`. Two raters
label independently, and the report gives Cohen's kappa for the two raters with
the most labelled trials, aligned on the trials both labelled. A low kappa
means the layer definitions do not yet separate failures reliably, and the
layer counts should not be used. CLM-020 names kappa below 0.6 as its
falsifying threshold.

## Source note

- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [Chen et al., Evaluating Large Language Models Trained on Code](../../reference/claims/bibliography.md#src-chen-codex-pass-at-k)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../../reference/claims/bibliography.md#src-nosek-open-research)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)


## Method references

The distinction between repeated runs and comparisons across datasets follows
the concerns in [Demšar (2006), Statistical Comparisons of Classifiers over
Multiple Data Sets](https://www.jmlr.org/papers/v7/demsar06a.html). RAE uses a
task-level permutation procedure, not that paper's recommended rank tests.
[Agarwal et al. (2021), Deep Reinforcement Learning at the Edge of the
Statistical Precipice](https://proceedings.neurips.cc/paper/2021/hash/f514cec81cb148559cf475e7426eed5e-Abstract.html)
motivates reporting uncertainty in few-run evaluations. RAE's task bootstrap
is not an implementation of their fixed-task stratified bootstrap. Neither
reference establishes validity for a dependent or unrepresentative task suite.
See [DR-002](../../reference/decisions/dr-002-research-integrity.md) for the
version and migration decision.
