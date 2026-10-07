---
status: experimental
owner: orchestration
last_reviewed: 2026-10-07
source_of_truth: packages/contracts/v1/schemas/workflows/workflow-v2.1.schema.json
evidence_links: ../claims/claims-ledger.md
---

# Workflow 2.0 and 2.1 Contract

Workflow 2.0 and 2.1 are the graph-native workflow contracts that
`agent run` executes by default. The default workflow,
`workflows/graph-native-default.workflow.json`, uses 2.0; the recipes under
`workflows/recipes/` use 2.1. The experimental wait-and-signal contract is
described separately in [Workflow 2.2](workflow-v2.2.md).

The schemas are `packages/contracts/v1/schemas/workflows/workflow-v2.schema.json`
and `workflow-v2.1.schema.json`. The engine validates a workflow against its
schema and then checks topology, markers, and payload contracts in
`packages/engine/src/workflow/workflow-contract.ts`. This page describes the
resulting semantics; the schema and the validator are authoritative.

## Versions and validation modes

| `schema_version` | Status |
| --- | --- |
| `2.0.0` | Accepted for new workflows, existing snapshots and activated revisions |
| `2.1.0` | Accepted; adds maps, transforms, streams, quorum joins, failure collection, and `until-dry` loops |

The rules below are not versioned separately: a tightened rule does not create
a new schema version. The engine validates a workflow in one of two modes
(`validateWorkflow(workflow, { mode })` in
`packages/engine/src/workflow/workflow-contract.ts`).

| Mode | Used by | Enforces |
| --- | --- | --- |
| `authoring` (default) | Registry draft, validate and activate, new runs, designer output, proposals | Structure and topology, plus the marker, finding-schema, artifact-name, and ownership-plan rules in this page |
| `snapshot` | Resume and the schedulers | Structure and topology only |

Both modes check the JSON Schema, payload contracts (size, local references,
no recursion, no forbidden keys), unknown references, graph shape (one entry,
one terminal, no unbounded cycle, no unreachable node, loop-backs inside one
loop), join and quorum configuration, and the dominance rules for writers and
verification. Authoring additionally rejects:

- `verification: true` on a node that is not a `gate`;
- `mutation_checkpoint` (either value) on a node that is not a `checkpoint`;
- an ownership-plan node whose payload contract does not require
  `file_ownership`;
- a node whose payload contract has a `findings` property without `items`
  matching the shared [finding schema](#findings);
- an `artifact` edge without an `artifact` name.

A run stores an immutable snapshot of its workflow and its canonical digest. A
resumed run validates that snapshot in `snapshot` mode, so a rule added to
authoring later cannot strand it. RAE does not rewrite stored runs or private
registries; a stored workflow that authoring would now reject keeps resuming
but cannot be re-drafted or re-activated unchanged.

## Workflow shape

A workflow declares `workflow_id`, `revision`, an optional `title`,
`entry_node`, `terminal_node`, 2 to 64 `nodes`, 1 to 256 `edges`, optional
named `payload_contracts` (JSON Schemas for node outputs), and optional
`budgets`. Every terminal path must pass through a verification gate, and every
writer must be preceded by an ownership plan and a mutation checkpoint (see
[Markers](#markers)).

## Node kinds

Every node has an `id`, a `kind`, an `access` mode (`read`, `write`, or
`control`), and `guidance` text. Agent and map nodes call a provider; all other
kinds are deterministic and call no model.

| Kind | Version | Behavior |
| --- | --- | --- |
| `agent` | 2.0 | One provider invocation with a fresh session. `read` agents must not change the repository; `write` agents may change only plan-owned paths. |
| `map` | 2.1 | One agent instance per item selected by `map.source_pointer`, keyed by `map.stable_key_pointer`, at most `map.max_items` (32). |
| `transform` | 2.1 | An allowlisted data operation: `select`, `flatten`, `deduplicate`, `sort`, `limit`, `group`, or `cartesian`. |
| `join` | 2.0 | Collects inputs. `all` waits for every enabled input, `any` proceeds with the first, and `quorum` (2.1) requires `quorum.threshold` inputs, optionally per group. A join needs at least two inputs. |
| `gate` | 2.0 | Evaluates its inputs; see [Gate evaluation](#gate-evaluation). |
| `checkpoint` | 2.0 | Pauses for a human decision when the run's checkpoint policy requires it. |
| `loop` | 2.0 | Declares a bounded loop over `loop.members`; see [Loops](#loops). |
| `terminal` | 2.0 | Completes the workflow. |

A node becomes ready when every non-loop-back predecessor has settled and at
least one incoming edge's condition matches. Writers run alone: the scheduler
drains running readers before starting a writer and starts no reader while a
writer runs. Nodes that share a `resource` label never run concurrently.

In 2.1, `failure_handling` on a map or join selects `fail-workflow` (default)
or `collect`, with optional `max_failures` and `minimum_successes`.

## Markers

Three boolean markers carry safety meaning. Authoring mode enforces where they
may appear.

### `ownership_plan`

`ownership_plan: true` marks the node whose output is the plan of owned
paths. Its `payload_contract` must require `file_ownership` (authoring). Every
writer must be dominated by an ownership-plan node, and writer changes outside
the plan fail.

### `mutation_checkpoint`

Valid only on `checkpoint` nodes (authoring). It has three states:

| Value | Meaning | Pauses under |
| --- | --- | --- |
| `true` | Mutation checkpoint. Every writer must be dominated by one. | `before-mutation`, `before-mutation-and-ship` |
| `false` | Release checkpoint, placed after verification and before completion. | `before-mutation-and-ship` |
| absent | Plain checkpoint. Does not satisfy writer dominance. | `before-mutation`, `before-mutation-and-ship` |

The default workflow and every recipe with a writer end with a
`release-checkpoint` of the `false` kind.

### `verification`

`verification: true` is valid only on `gate` nodes (authoring). The terminal
node must be dominated by at least one verification gate. The maintained
workflows name this gate `verification`. A gate may set `verification: false`
(the default workflow's `design-gate` does): it evaluates its inputs and
restarts its loop like any gate but does not satisfy terminal dominance.

## Edges and conditions

| Edge `type` | Meaning |
| --- | --- |
| `sequence` | Ordering only. |
| `artifact` | Passes the source envelope to the target; `artifact` names it, and authoring requires the name. |
| `stream` | 2.1. Passes items to a pipelined consumer; a chain of stream edges is at most `budgets.max_pipeline_depth` stages (default and maximum 4). |
| `condition` | Passes only when `condition` matches the source result. |
| `loop-back` | Restarts a loop after its gate fails. Not counted as a predecessor for readiness. |

`condition` values are evaluated against the source node's envelope, with the
semantics of the workflow's own schema version
(`conditionMatches` in `workflow-scheduler-common.ts`):

| `condition` | Matches when |
| --- | --- |
| none | 2.0.0: always. 2.1.0 and later: the envelope status is `passed` (the same as `success`) |
| `success` | the envelope status is `passed` |
| `failure` | the envelope status is `failed` or `blocked`; in 2.1.0 also `collected` |
| `blocking-findings` | any finding is blocking; in 2.0.0 also when the payload's `status` field is `failed` or `blocked` |
| `budget-available` | the payload does not set `budget_available` to `false` |

A finding is blocking when `blocking` is `true` or `severity` is `blocking`.

## Findings

Findings payloads use one shared finding schema, exported as `FINDING_SCHEMA`
from `workflow-contract.ts` and inlined in the workflow JSON files:

| Field | Type | Meaning |
| --- | --- | --- |
| `severity` | `blocking`, `major`, `minor`, or `info` (required) | Impact of the finding |
| `blocking` | boolean | Whether the finding stops a gate |
| `evidence_ref` | string, optional | Reference to the artifact, command evidence, or path that supports the finding |
| `summary` | string | Human-readable statement of the finding |

Further fields (for example `id`, used when no non-empty summary is available) are allowed.
In authoring mode, every node whose `payload_contract` has a `findings`
property must declare `findings.items` with `severity` required and the four
severities, a boolean `blocking`, a string `summary`, and a string
`evidence_ref` when declared. The ownership-plan contract is a findings
contract and carries the same items.

## Gate evaluation

A gate collects the findings of all its inputs and fails when:

- any input finding is blocking, or
- any input envelope did not pass.

A verification gate inside a loop also fails when one of its inputs comes from
a writer and the gate has a loop-back edge. This forces the loop members to
re-verify the tree the writer just changed; the failure carries a blocking
finding with id `writer-reverification`. A gate otherwise passes. A failed
gate inside a loop restarts the loop (see [Loops](#loops)); a failed gate
outside any loop blocks the run and the report names the failed gate.

In the default workflow the `verification` gate receives the critics' findings
through `repair-join` as well as the diagnostician's decision and the
repairer's output, so it judges the critics' blocking findings itself instead
of relying on the diagnostician to repeat them.

## Loops

A `loop` node lists its `members`, and a member gate carries the loop-back
edge. The scheduler finds the loop through membership: any gate that is a
member restarts it, whether or not the gate sets `verification`. When that gate
fails:

1. the scheduler checks whether the loop is exhausted;
2. if not, it clears the results and attempt counters of **every** loop
   member and starts the next iteration. The loop-back edge target does not
   narrow the restart: all members run again.

Bounded loops behave identically in 2.0.0 and 2.1.0; they share one
implementation (`decideBoundedRepeat` in `workflow-scheduler-common.ts`).
Until-dry loops (2.1) keep their own path, described below.

A loop is exhausted, and the run ends as `repair-exhausted` with a recorded
reason, in this order of checks:

1. `no-progress`: the failed gate's key was already seen on a failed
   evaluation of this loop (the key has now occurred twice);
2. `budget-exhausted`: the gate payload sets `budget_available` to `false`
   (the 2.0.0 scheduler records it from the node-attempt budget; the 2.1.0
   scheduler does not set it);
3. `rounds-exhausted`: a failure that consumes a repair round arrives when
   the rounds already consumed reach the repair limit, or the next iteration
   would exceed the loop's iteration limit.

The repair limit is `--max-repair-rounds`, else `budgets.max_repair_rounds`,
else 5, capped at 5; `N` allows at most `N` repairs after the first attempt.
The total iteration limit is `min(loop.max_iterations, N + 1)` (at most 5).
Writer re-verification consumes no repair round but still advances the
iteration, so it cannot bypass this total limit.

**No-progress key.** The key is the digest of the sorted, de-duplicated
identities of the gate's blocking findings, excluding the
`writer-reverification` finding. A finding's identity is its non-empty
`summary` together with its blocking flag, falling back to its `id` and
blocking flag, then its canonical JSON. When no substantive blocking finding
exists, the gate's output digest is the key.

**Writer-forced failures.** A failure whose only blocking finding is
`writer-reverification`, with every input passed, was forced by a fresh writer
and not by evidence. It consumes no repair round and is not recorded for
no-progress, but it still advances the iteration counter, which the envelope
schema caps at 5.

On resume, members from earlier iterations are discarded and the run continues
inside the newest iteration; repair rounds and no-progress keys are rebuilt
from the failed gates of earlier iterations.

### Design and plan loops

The default workflow bounds two earlier stages the same way. The `design-loop`
(`max_iterations` 3) contains `design`, the four design critics,
`design-collection`, `design-gate`, and `design-adjudication`.
`design-collection` feeds `design-gate`, a non-verifying gate. On success the
gate feeds `design-adjudication`, which then feeds planning; on failure the
loop-back restarts the whole design round. The `plan-loop` (`max_iterations`
3) contains `plan`, both alignment extractors, and `alignment-gate`; a failed
alignment gate restarts planning. An exhausted loop ends the run as
`repair-exhausted` before any writer runs, instead of failing with "workflow
cannot make progress".

### `until-dry` loops (2.1)

A loop with `mode: "until-dry"` repeats discovery until no new items appear.
It requires `source_pointer` and `stable_key_pointer`. After each round the
scheduler deduplicates the items at `source_pointer` by their stable key
against all keys seen so far. A round with no fresh keys is dry and ends the
loop. Otherwise the fresh items are passed along the loop-back edge to the next
round. Reaching `max_iterations` without a dry round fails the workflow.
`unknown-size-discovery` follows the loop with a `verification` gate over the
verifier's findings.

## Budgets

Workflow budgets bound the run. `--max-concurrency` and `--max-repair-rounds`
override the workflow value within the same ranges.

| Budget | Range | Version |
| --- | --- | --- |
| `max_concurrency` | 1 to 4 concurrent readers | 2.0 |
| `max_repair_rounds` | 0 to 5; read by bounded loops | 2.0 |
| `max_attempts_per_node` | 1 to 3 | 2.0 |
| `max_dynamic_instances` | 1 to 128 map instances | 2.1 |
| `max_pipeline_depth` | 1 to 4; bounds stream chains at validation | 2.1 |
| `max_map_items` | 1 to 32 | 2.1 |
| `max_wall_clock_seconds` | integer, at least 60; run-level | 2.0 and 2.1 |
| `max_provider_attempts` | integer, at least 1; run-level | 2.0 and 2.1 |

The two run-level budgets are optional and additive; the default workflow sets
14400 seconds and 96 provider attempts.

- The wall clock is measured from the start of each scheduling pass, so a
  resumed run starts a new clock. It is exceeded when more than the budgeted
  seconds have elapsed.
- A provider attempt is one invocation of an `agent` or `map` node, including
  retries. Attempts recorded in resumed envelopes count. Joins, gates,
  checkpoints, loops, and transforms use none. The budget stops further
  provider launches once that many attempts have started.

Exceeding either budget stops scheduling, lets running nodes finish, and
returns the `repair-exhausted` result with reason `wall-clock-exhausted` or
`provider-attempts-exhausted`; a retry that the budget forbids ends the same
way. `--timeout-seconds` sets the per-node provider timeout (default 1800).

## Checkpoint policies

The run's checkpoint policy decides which checkpoint nodes pause:

| Policy | Mutation and plain checkpoints | Release checkpoints |
| --- | --- | --- |
| `none` | pass through | pass through |
| `before-mutation` | pause | pass through |
| `before-mutation-and-ship` | pause | pause |

`agent run` defaults to `before-mutation`; runs started from the operator
console use `before-mutation-and-ship`. A paused run waits until the
checkpoint is resolved. `approved` lets the node pass; `rejected` and
`escalated` end the run, and the node is not retried.

## Related references

- [Workflow 2.2](workflow-v2.2.md)
- [Artifact schemas](artifact-schemas.md)
- [Execution profile 3.0](execution-profile-v3.md)
- [Graph engineering with RAE](../../tutorials/graph-engineering-with-rae.md)
- [Orchestration CLI](../cli/orchestration.md)

## Interpretation limits

- A passing gate shows that the recorded findings and statuses met the rules
  above. It does not show that the findings are complete or correct.
- Loop and budget bounds limit cost and repetition; they do not guarantee that
  a repair converges.
