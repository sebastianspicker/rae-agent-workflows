# RAE contracts

This package owns RAE's immutable, versioned JSON Schemas. Existing schema
files are compatibility protocols: change semantics by adding a new schema
version, not by silently repurposing a published version.

Workflow schemas 2.0.0 and 2.1.0 gained the optional run-level budgets
`budgets.max_wall_clock_seconds` (integer, at least 60) and
`budgets.max_provider_attempts` (integer, at least 1). The change is additive:
no field was removed or tightened, `additionalProperties: false` still applies,
and no new schema version was added. Stricter authoring rules (marker
placement, finding items, named artifact edges) live in the engine's
`validateWorkflow` authoring mode, not in these schemas, so stored workflows
remain valid against them.

The engine resolves these files through its contract catalog. Applications
must not duplicate or patch them.

Experiment report v2 adds independent analysis units, per-arm coverage,
per-task results and exact-record/input digests. Report v1 remains immutable
for historical artifacts. The design v1 schema gains optional `analysis.unit`;
report v2 defaults it to `task`. See the [experiment contracts](../../docs/reference/contracts/experiments-v1.md)
for migration and inference semantics.

## TypeScript contracts

The package root exports generated structural types, canonical schema digests
and `parseContract(schemaName, value)`. External values remain `unknown` until
`parseContract` validates them with the corresponding authoritative schema.
Numeric bounds, patterns and other runtime constraints are enforced by the
schema validator even when TypeScript cannot represent them structurally.

Build the compiled runtime and check generated types from the repository root:

```text
npm --workspace @rae/contracts run build
npm --workspace @rae/contracts run build:generator
npm --workspace @rae/contracts run check:generated
```

After adding a schema version, regenerate with `npm --workspace @rae/contracts
run generate:types`. Existing schema paths and identifiers remain unchanged.
Generation and freshness checks use the repository's pinned Biome formatter,
so install the root workspace before running either command. Generated files
must be reproduced through the generator.

Experiment execution also has additive `trial-execution-v1` and
`evidence-manifest-v1` contracts for durable lifecycle receipts and private
retained file hashes. Execution lock v3 requires journal receipts; existing
v1/v2 locks are analysis-only. See [DR-003](../../docs/reference/decisions/dr-003-durable-experiment-execution.md).
