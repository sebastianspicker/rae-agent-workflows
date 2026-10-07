---
status: stable
owner: core
last_reviewed: 2026-10-07
source_of_truth: packages/engine
evidence_links: ../reference/claims/evidence-index.md
---

# Operate the Workflow Engine

This runbook covers local engine preflight, run control, recovery, and the
low-level staged interface. Use the engine guide (`packages/engine/README.md` at the repository root)
for concepts and configuration.

## Preflight

From the repository root:

```bash
npm run rae -- doctor
npm run rae -- agent doctor
```

The first command checks Node.js 24+, Git, the native filesystem bridge,
and compiled entrypoints. The second checks the selected provider
boundary. Codex is the default. Diagnose an explicit OpenCode route with
`--provider opencode --model <provider/model>`.

## Start an autonomous run

```bash
npm run rae -- agent run \
  --project-root /path/to/target-repository \
  --task "Implement the change, test it, and update its documentation"
```

The target must be a committed Git repository with usable `HEAD` and
current-branch reflogs. By default RAE creates `pipeline/<run-id>` in an
isolated worktree under `.git/rae-worktrees/<run-id>` in the target's Git
metadata. Record the printed run ID, worktree, and report path.

Useful controls:

- `--through plan` stops before a writer node.
- `--checkpoint-policy before-mutation` (the CLI default) pauses before the
  first writer; `none` disables pauses.
- `--checkpoint-policy before-mutation-and-ship` also pauses at the graph
  `release-checkpoint` node, before the final release decision.
- `--workflow <path>` selects a validated workflow for a new run.
- `--execution-profile <path>` selects operator-owned provider routes.
- `--graph-memory read|read-write` enables optional local graph context.
- `--in-place` is explicit and requires a clean target checkout.

`--task-file` accepts only a relative, regular, non-symlink `.md` or `.txt`
file below the canonical project root. Credential-like paths, traversal,
invalid UTF-8, empty files, files larger than 128 KiB, and files that change
during the read are rejected.

## Inspect and control a run

```bash
npm run rae -- agent status \
  --project-root /path/from/the/run-output \
  --run-id <run-id>

npm run rae -- agent events \
  --project-root /path/from/the/run-output \
  --run-id <run-id>

npm run rae -- agent stop \
  --project-root /path/from/the/run-output \
  --run-id <run-id>
```

Use `resolve-checkpoint` only with the opaque checkpoint and decision values
reported by the run. Use `signal` only for an experimental workflow 2.2 wait
node. Run `npm run rae -- agent --help` for the required arguments.

The loopback operator exposes the same bounded control model for explicitly
allowlisted local repositories:

```bash
npm run rae -- operator serve --project /canonical/path/to/repository
```

## Resume and recover

After correcting a reported blocker:

```bash
npm run rae -- agent resume \
  --project-root /path/from/the/run-output \
  --run-id <run-id>
```

Resume uses the recorded workflow snapshot and ordinary runtime settings unless
an allowed override is explicit. It never restores unsafe command-provider
authorization from run state; that test integration requires fresh provider,
command, argument, and unsafe-authorization flags.

Each run holds an autonomous lock across execution and gates. Before a writable
provider phase, the engine stores protected `.pipeline` evidence under
runner-owned state outside the workspace and provider-writable temporary roots.
After a crash, resume atomically claims that guard, restores and verifies the
protected state, and then removes a stale workflow lock. Status and control
operations also refuse or reconcile an active guard before reading run state.

Git state is compared in three scopes. The initial run preflight (`full`)
compares every ref except other runs' `refs/heads/pipeline/*` branches, and the
whole local and worktree configuration. Each phase (`phase`) compares HEAD, the
run branch reflog, the index, the sensitive refs (local branches other than the
run branch and `refs/heads/pipeline/*`, tags, replace, bisect, rewritten and
worktree refs), the worktree-private config and every local config key except
benign tracking keys; `branch.<name>.remote` and `.pushremote` are benign only
when they name a configured remote. Resume preflight (`resume`) is `phase`
without the refs comparison, because the agent was not running during the
pause and your own branch or tag activity is legitimate; resume then
re-baselines the refs and the benign config. A run branch that moved, a changed
index or a changed safety-relevant config key still blocks resume.

`RAE_STATE_HOME`, when set, must be an absolute path outside the workspace,
not containing it, and outside every provider-writable root (including the
temporary directories); otherwise the run fails instead of falling back. Each
directory from it down to `rae/pipeline-guards` must belong to the current
user, not be a symlink, and not be group or world writable.

Do not manually delete a lock or guard. If the recorded owner, claimant, or
repository identity may still be active, recovery fails closed. Inspect the
named process and repository, preserve the reported evidence, and retry only
after ownership is unambiguous. A detached descendant created by the unsafe
command provider has no equivalent containment guarantee.

## Read the evidence

Run evidence is under `.pipeline/runs/<run-id>/`:

- `request.json` and the immutable workflow snapshot identify the request
- `workflow/attempts/` contains provider and deterministic-node envelopes
- `workflow/attempts/<node>/` holds each node's envelope and gate outcome; the
  `gates/` directory is written only by legacy-linear runs and
  `orchestrate` stages
- `trace.jsonl` and projected events record ordered execution
- checkpoint and control files record human decisions
- `run-report.md` is the bounded human-readable summary

Use raw artifacts and gates for decisions; graph projections and memory are
advisory context.

## Low-level staged worktrees

The compatibility staged interface has a separate worktree lifecycle:

```bash
node packages/engine/dist/scripts/pipeline-init.js . --use-worktree
```

Its default checkout is `<git-root>/.worktrees/<run-id>`, not the autonomous
worktree directory. Change to the exact `workspace_root` printed by the
command, then inspect the available operations:

```bash
npm run rae -- orchestrate --help
```

Cleanup is explicit and accepts only a clean pipeline-owned worktree:

```bash
node packages/engine/dist/scripts/pipeline-init.js \
  --cleanup-worktree <git-root>/.worktrees/<run-id>
```

## Troubleshooting

- Runtime mismatch: run `npm run rae -- doctor` and use the supported
  versions reported in the root README.
- Provider capability failure: update the selected CLI until its diagnostic
  satisfies the required sandbox, structured-output, event, and session
  contract.
- Gate failure: inspect the named gate and `run-report.md`, correct the target
  or missing tool, then resume from the printed worktree.
- Uncertain interruption: inspect the workspace and provider activity before
  starting another run.
- Verification failure: use `npm run verify --` from a prepared checkout;
  do not generalize a partial result to the complete repository.
