---
status: experimental
owner: orchestration
last_reviewed: 2026-10-07
source_of_truth: packages/engine/src/cli
evidence_links: ../claims/evidence-index.md
---

# Orchestration CLI

The workflow engine has three command surfaces:

| Surface | Entrypoint | Use |
| --- | --- | --- |
| Autonomous workflow | `npm run rae -- agent ...` | Repository planning, changes, checks, and handoff |
| Stage runner | `npm run rae -- orchestrate ...` | Explicit pipeline state, stages, artifacts, gates, and summaries |
| Worktree lifecycle | `npm run rae -- worktree ...` | Isolated run creation, state summaries, review-state records, and cleanup |

## Autonomous workflow

```bash
npm run rae -- agent doctor
npm run rae -- agent run \
  --project-root /path/to/target-repository \
  --task "Implement the change and verify it"
```

The default run uses `.git/rae-worktrees/<run-id>`. `--through plan` stops
before mutation. The default `--checkpoint-policy before-mutation` pauses
before the first writable stage; `before-mutation-and-ship` also pauses, in
graph mode, at the `release-checkpoint` node before `complete`; `none` never
pauses. `--timeout-seconds` sets the provider timeout per node. See
[Workflow 2.0 and 2.1 Contract](../contracts/workflow-v2.md) for checkpoint,
gate, and loop semantics.

Run `npm run rae -- agent --help` for run, resume, status, stop, signal,
checkpoint, and event options.

## Stage runner

```bash
npm run rae -- orchestrate init
npm run rae -- orchestrate run-stage --run-id <run-id> --phase arm
npm run rae -- orchestrate summarize-run --run-id <run-id> --format markdown
```

`orchestrate init` with no argument initialises `.pipeline` in the directory it
was invoked from. Pass a path or `--project-root <path>` to initialise another
directory. The other stage commands also run in the invoking directory and
receive it as `--project-root` unless you pass one.

`run-stage` is a low-level artifact and gate interface. Without an input
artifact it produces deterministic fixtures; it does not modify application
code.

The stage order below is the legacy ten-phase pipeline; graph runs follow the
workflow DAG instead.

```text
arm
design
adversarial-review
plan
pmatch
build
quality-static
quality-tests
post-build
release-readiness
```

### record-gate

`orchestrate record-gate --run-id <id> --phase <phase> --status <pass|warn|fail>`
is an operator assertion, not an evaluation. It writes the phase gate file with
`metadata.source` set to `record-gate` and overwrites a gate file the engine
already evaluated. Treat the result as a human decision, not as proof that the
phase's checks ran. The statuses are the legacy `pass`, `warn` and `fail`;
graph runs record `passed` or `failed` envelopes under `workflow/attempts/`.

## Worktree lifecycle

```bash
npm run rae -- worktree --help
```

`worktree` provides `init`, `summary`, `review-state` and `cleanup`; it has no
`resume` subcommand (use `agent resume` for autonomous runs). Worktree mode owns the `pipeline/<run-id>` branch, isolated checkout, run
state, and cleanup checks. Cleanup is explicit and refuses uncertain or active
state.

## Package references

- [Package README](https://github.com/sebastianspicker/rae-agent-workflows/blob/main/packages/engine/README.md)
- [Runbook](https://github.com/sebastianspicker/rae-agent-workflows/blob/main/docs/how-to/engine-runbook.md)
- [Platform support](../engine/adapter-platforms.md)
- [Repository map](../repo-map.md)

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
