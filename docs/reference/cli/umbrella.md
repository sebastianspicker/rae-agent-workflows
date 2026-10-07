---
status: stable
owner: core
last_reviewed: 2026-10-07
source_of_truth: scripts/src/rae.ts
evidence_links: ../claims/evidence-index.md
---

# Umbrella CLI

`npm run rae --` is the repository entrypoint. It validates the runtime
before dispatching to the package that owns each command.

## Command ownership

| Command | Owner | Purpose |
| --- | --- | --- |
| `verify` | `scripts/src/verify.ts` | Run repository verification |
| `doctor` | `scripts/src/rae.ts` | Check the Node runtime, Git, the native bridge, and compiled entrypoints |
| `agent` (alias `autonomous`) | orchestration autonomous CLI | Run, inspect, stop, or resume an autonomous workflow |
| `graph` | orchestration graph CLI | Build and query local projections or manage cross-run memory |
| `operator serve` (alias `console serve`) | orchestration operator console | Serve the loopback console for allowlisted repositories |
| `orchestrate` (alias `orchestration`) | orchestration stage runner | Manage pipeline stages, artifacts, gates, and summaries |
| `worktree` | orchestration worktree CLI | Create, summarize, record review state for, or clean isolated runs |
| `ralph` | Ralph package | Run audit, linting, or story-scoped fixing |
| `hygiene` | repository hygiene tools | Run an explicitly selected maintenance utility |
| `profile` | `profiles/agent-environments` | Install or uninstall a public agent profile transactionally |
| `workflow` (alias `workflows`) | umbrella aliases | Use task-oriented aliases for the same package commands |

The aliases in parentheses dispatch to exactly the same runtime as the primary
name. `hygiene` also accepts `coauthor-trailer-cleaner` as the tool name.

Run:

```bash
npm run rae -- --help
```

Subcommand options are owned by the selected runtime:

```bash
npm run rae -- agent --help
npm run rae -- graph --help
npm run rae -- orchestrate --help
npm run rae -- ralph --help
```

## Diagnostics

```bash
npm run rae -- doctor
```

The command prints the repository root and the invoking directory, then one
`OK` or `FAIL` line per check:

- `node`: the running Node.js is version 24 or newer
- `git`: `git --version` succeeds
- `native-filesystem`: the compiled `@rae/fs-bridge` module opens the
  repository root
- `autonomousEntrypoint`, `graphCliEntrypoint`, `stagedEntrypoint`, and
  `pipelineInitEntrypoint`: `@rae/engine` exports the entrypoint and its
  compiled file exists
- `operator`, `ralph`, `profiles`, and `history`: the compiled entrypoints of
  the operator, Ralph, the profile installer, and the coauthor trailer cleaner
  exist

It ends with `VERDICT: PASS` (exit 0) or `VERDICT: FAIL` (exit 1). It does not
check the Codex or OpenCode CLIs, provider authentication, or the experimental
platform.

Provider-backed autonomous work has a separate diagnostic:

```bash
npm run rae -- agent doctor
```

Without provider options, the command checks Codex authentication, workspace
sandboxing, JSON-schema output, event streaming, and ephemeral sessions. Use
`agent doctor --provider opencode --model <provider/model>` to check the exact
OpenCode binary, merged permission configuration, credential-store presence,
and macOS containment backend.

## Autonomous run

```bash
npm run rae -- agent run \
  --project-root /path/to/target-repository \
  --task "Implement the change, add regression tests, and update the documentation"
```

The default run creates `pipeline/<run-id>` under
`.git/rae-worktrees/<run-id>`. It prints the worktree and run-report paths.
Use `--through plan` to stop before mutation. `--checkpoint-policy` selects the
human pauses: `before-mutation` (the CLI default) pauses before the first
writer, `before-mutation-and-ship` also pauses at the release checkpoint, and
`none` never pauses. `--timeout-seconds <n>` sets the provider timeout per
node (default 1800).

Resume after correcting an environmental failure:

```bash
npm run rae -- agent resume \
  --project-root /path/from/the-run-output \
  --run-id <run-id>
```

RAE does not expose commit, push, publish, or deploy actions. Supported runs
reject protected Git-state changes.

Graph retrieval is disabled by default. Enable current, trusted local retrieval
for one run with `--graph-memory read`, or admit verified outcomes and
quarantine model-proposed candidates with `--graph-memory read-write`. The mode
is immutable on resume.

Use an operator-owned execution profile when workflow nodes declare logical
tiers:

```bash
npm run rae -- agent run \
  --project-root /path/to/target-repository \
  --execution-profile /absolute/path/to/execution-profile.json \
  --task "Implement and verify the requested change"
```

`--execution-profile` is mutually exclusive with `--provider`, `--model`,
`--reasoning-effort`, and `--variant`. Execution profile 3.0 resolves logical
tiers and optional per-node overrides to named Codex or OpenCode routes. The
validated profile, canonical digest, resolved node routes, models, and exact
executor versions are stored in the run request and remain immutable on
resume.

OpenCode is explicit:

```bash
npm run rae -- agent doctor \
  --provider opencode \
  --model opencode/example-model

npm run rae -- agent run \
  --project-root /path/to/target-repository \
  --provider opencode \
  --model openrouter/example-model \
  --task "Implement and verify the requested change"
```

OpenCode writes require the isolated macOS worktree backend and reject
`--in-place`. `auto` never selects OpenCode.

## Local graph and memory

```bash
npm run rae -- graph build --project-root /path/to/target-repository
npm run rae -- graph status --project-root /path/to/target-repository
npm run rae -- graph query --project-root /path/to/target-repository \
  --seed 'File:src/main.js'
```

The graph is local, rebuildable, and advisory. It cannot modify gates,
checkpoints, policies, evaluators, Git state, publication state, or plan
ownership. See the [graph and memory contract](../contracts/graph-memory.md).

Workflow revisions use the same graph command family:

```bash
npm run rae -- graph workflow list --project-root /path/to/target-repository
npm run rae -- graph workflow validate --project-root /path/to/target-repository \
  --workflow-file /absolute/path/to/workflow.json
npm run rae -- graph workflow analyze \
  --workflow-file /absolute/path/to/workflow.json \
  --execution-profile /absolute/path/to/execution-profile.json
npm run rae -- graph workflow propose --project-root /path/to/target-repository \
  --task "Design a bounded topology" --base-workflow graph-native-default \
  --actor "operator-name" --rationale "Draft for review" \
  --execution-profile /absolute/path/to/execution-profile.json --preview
```

`analyze` reports schema and topology errors, unreachable nodes, writer and
verification paths, bounded attempts and instances, concurrency, and resolved
routes. It reports monetary cost as unavailable when provider usage data is not
present.

`propose` starts one read-only, ephemeral structured-output session and permits
one correction after local validation. `--preview` returns a validated candidate
without saving it; omitting `--preview` stores a valid attributed draft. An
execution profile supplies the `judgment` route. Neither mode activates or
executes the result.

## Operator console

```bash
npm run rae -- operator serve \
  --project /canonical/path/to/target-repository \
  --execution-profile /absolute/path/to/execution-profile.json
```

Repeat `--project` for additional allowlisted roots. The server binds to
loopback and prints an ephemeral token in the URL fragment. The console starts
only isolated-worktree runs and does not expose arbitrary commands, environment
overrides, in-place execution, Git publication, or deployment.

## Stage runner

`orchestrate init`, `run-stage`, `summarize-run`, and the other stage
commands run in the directory you invoke them from and receive it as
`--project-root` unless you pass a root. Relative paths such as `--taskset`
resolve from that directory, and `.pipeline/` is created there.

```bash
npm run rae -- orchestrate init
npm run rae -- orchestrate run-stage --run-id <run-id> --phase arm \
  --config-id phased_default --taskset examples/minimal-pipeline/taskset.json
```

## Agent profiles

```bash
npm run rae -- profile install /canonical/target
npm run rae -- profile uninstall /canonical/target
```

See `profiles/agent-environments/README.md` for the manifest, rollback, and
recovery contract.

## Workflow aliases

- `workflow autonomous` (or `workflow agent`) forwards to `agent`
- `workflow repo-audit` forwards `bootstrap`, `check`, `doctor`, `status`,
  `list-stories`, and `validate-prd` to the matching Ralph flag; `run` passes
  explicit Ralph arguments
- `workflow long-horizon` forwards to staged orchestration
- `workflow hygiene` forwards to repository hygiene tools

Aliases do not define independent behavior. The package command remains the
source of truth.

## Repository scripts

The root `package.json` exposes the verification and maintenance scripts:

| Script | Purpose |
| --- | --- |
| `npm run build` | Build the root workspaces and the native bridge |
| `npm run build:platform` | Build the separately installed platform |
| `npm test` | Run private local suites sequentially in a maintainer checkout; skips an uninstalled platform |
| `npm run test:<suite>` | Run one private local suite: `engine`, `operator`, `platform`, `ralph`, `agent-profiles`, `coauthor-trailer-cleaner`, `repository-tools`, `dev-tools`, or `fs-bridge` |
| `npm run typecheck`, `npm run lint` | Type-check the workspaces and run Biome lint |
| `npm run format`, `npm run format:check` | Apply or check Biome formatting |
| `npm run check:architecture` | Check engine layering and application import boundaries |
| `npm run check:docs` | Check docs frontmatter keys, `source_of_truth` paths, and relative links |
| `npm run check:adapters` | Check that generated adapter content is current |
| `npm run verify -- --skip-install [--skip-build]` | Run the repository gate on a prepared checkout |
| `npm run verify -- --skip-install --skip-tests` | Check a public checkout without the private local test suites |

`verify` ends with `VERDICT: PASS`, `VERDICT: PARTIAL` (the platform is not
installed, `--skip-docs` was used, or private tests were omitted with
`--skip-tests`), or `VERDICT: FAIL`.
`--release-candidate` performs the full install and requires a clean Git
worktree.

## Exit behavior

`npm run rae --` rejects unknown command families and propagates the selected
runtime's exit status. A command that cannot establish its required safety
boundary fails closed.

## Related documentation

- [Orchestration CLI](orchestration.md)
- [Ralph CLI](ralph.md)
- [Repository hygiene CLI](repo-hygiene.md)
- [Orchestration package](https://github.com/sebastianspicker/rae-agent-workflows/blob/main/packages/engine/README.md)
- [Ralph package](https://github.com/sebastianspicker/rae-agent-workflows/blob/main/packages/ralph/README.md)

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
