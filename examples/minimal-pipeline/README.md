# Minimal Pipeline Example

This example is runnable from the umbrella harness.

## Goal

Create a minimal orchestration run, execute the intake stage, and summarize the
result.

## Commands

Run these from the repository root. The umbrella runs the stage commands in
the directory you invoke it from and passes that directory as
`--project-root`, so `.pipeline/` is created at
`<repository-root>/.pipeline/` and the taskset path resolves relative to it.

```bash
npm run rae -- orchestrate init
npm run rae -- orchestrate run-stage \
  --run-id <run_id> \
  --phase arm \
  --config-id phased_default \
  --taskset examples/minimal-pipeline/taskset.json
npm run rae -- orchestrate summarize-run --run-id <run_id> --format markdown
```

## Expected artifacts

- `.pipeline/pipeline-state.json`
- `.pipeline/runs/<run_id>/brief.json`
- `.pipeline/runs/<run_id>/gates/arm-gate.json`
- `.pipeline/runs/<run_id>/trace.jsonl`
