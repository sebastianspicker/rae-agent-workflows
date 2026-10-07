# Changelog

Notable public changes to the RAE umbrella are recorded here. Component
packages retain their own changelogs where applicable.

## [0.1.0-alpha.1] - Unreleased

### Added

- Autonomous `agent doctor|run|resume|status|stop|signal|resolve-checkpoint|events`
  workflow with isolated Git worktrees, typed phase artifacts, plan ownership
  checks, command evidence, durable human control, and a reviewed release
  handoff. `agent signal` records an idempotent operator signal for an open
  workflow 2.2 wait node.
- Authenticated loopback operator console with allowlisted project roots,
  checkpoint decisions, bounded event projection, and no publish controls.
- Operator background refresh of the run catalogue and an indicator for
  pending checkpoint decisions.
- Public agent-profile installation and removal with manifest v2 integrity,
  no-follow filesystem transactions, rollback, and retained recovery evidence.
- Deterministic CLI screenshots produced from the current executable surface.
- Public alpha release metadata, contribution guidance, issue forms, pull
  request template, support boundary, governance, and release procedure.
- Pinned GitHub Actions for CI, CodeQL, and Scorecard, plus Dependabot.
- Default graph workflow: two independent alignment extractors and an
  `alignment-gate` before the mutation checkpoint, a `release-checkpoint`
  after verification, a bounded `design-loop` (three rounds) around the design
  critics and a new `design-gate`, and a bounded `plan-loop` (three rounds)
  around planning and alignment. The `verification` gate now also receives the
  critics' findings through `repair-join`.
- Workflow `finding` schema shared by findings payloads: `severity`
  (`blocking`, `major`, `minor`, or `info`), a `blocking` boolean, and an
  `evidence_ref`.
- Run-level workflow budgets `max_wall_clock_seconds` (at least 60) and
  `max_provider_attempts` for schema versions 2.0.0 and 2.1.0, enforced by the
  schedulers. Exceeding either stops scheduling, lets running nodes finish, and
  ends the run as `repair-exhausted` with reason `wall-clock-exhausted` or
  `provider-attempts-exhausted`. The default workflow sets 14400 seconds and 96
  provider attempts.
- Platform scope `rae.run.rebind` for `POST /api/v2/runs/<id>/rebind`.
- Platform lease and heartbeat intervals are configurable; workers back off
  between empty claims.
- Ralph `--discard-transaction <journal-id>` discards one fixing journal found
  through `--doctor`; journals past the `prepared` state also require `--force`.
- Root scripts `build:platform`, `format`, `format:check`, `check:adapters`,
  `check:architecture`, and `check:docs`. `check:docs` validates page
  frontmatter keys, `source_of_truth` paths, and relative links.
- Per-workspace test scripts, tracked test directories for every package, and
  a CI step that runs the developer-tool image protocol tests.
- [Workflow 2.0 and 2.1 reference](docs/reference/contracts/workflow-v2.md).

### Changed

- `agent run` defaults to `--checkpoint-policy before-mutation`. The operator
  console continues to start runs with `before-mutation-and-ship`.
- `rae orchestrate init|run-stage|summarize-run` run in the caller's directory
  and pass `--project-root <caller>` unless a root is given. Run state is no
  longer created inside `packages/engine`.
- `rae ralph` resolves the target repository with
  `git rev-parse --show-toplevel` and, outside the Ralph package, keeps state
  under `<repository>/.runtime/ralph` (`RALPH_STATE_DIR`).
- Root test scripts renamed: `test:history` to `test:coauthor-trailer-cleaner`,
  `test:tooling` to `test:repository-tools`, and `test:profiles` to
  `test:agent-profiles`.
- `npm test` runs every workspace suite sequentially and prints
  `SKIPPED apps/platform: …` when the platform is not installed.
- `npm run verify -- --skip-install [--skip-build]` runs the test suites and
  prints `VERDICT: PARTIAL` when the platform is not installed or
  `--skip-docs` is used, and `VERDICT: PASS` otherwise.
  `--release-candidate` requires a clean Git worktree.
- Workflow loops: a failed loop gate restarts every loop member, whatever node
  the loop-back edge targets. The 2.1.0 scheduler now restarts bounded loops
  with the same repair accounting as 2.0.0, and the gate need not set
  `verification`.
- Workflow validation has two modes and no new schema versions. Authoring
  (registry drafts, validation and activation, new runs, designer templates and
  proposals) requires `verification: true` only on `gate` nodes,
  `mutation_checkpoint` only on `checkpoint` nodes, `findings` items that match
  the shared finding schema, named artifact edges, and a file-ownership
  contract on ownership plans. Snapshot validation, used when resuming, checks
  structure only, so stored runs keep resuming. Workflow proposals keep the
  base workflow's `schema_version`.
- Workflow recipes name their verification gate `verification`. The
  `module-migration` recipe adds test and contract critics, a `repair-join`,
  and a `release-checkpoint`; `unknown-size-discovery` verifies through a gate
  instead of an agent marker. Recipes no longer carry unread
  `max_repair_rounds`, and `max_pipeline_depth` now bounds stream pipelines.
- Operator worktree cleanup returns `200 {exit_code}` after the cleanup
  process finishes, instead of `202 {pid}`.
- Operator start and resume detect an engine process that exits early, and
  engine errors map to HTTP status codes with scrubbed messages.
- Operator console redesigned on the brand's calibration-trace mark: serif for
  human-written text, monospace for recorded evidence, a stepped run trace,
  full run IDs in the catalogue, and a theme that follows the OS. The console
  self-hosts two OFL typefaces and its CSP now allows `font-src 'self'`.
- Node.js 24 or newer is the only supported runtime.
- Updated Ralph to `0.4.0`: Codex-only execution, bounded subprocess output and
  deadlines, sanitized environments, transactional fixing-mode writes, and
  cancellation checkpoints. `--dry-run` takes no lock and writes no logs.
- Updated the coauthor trailer cleaner to `3.0.0`: private rewrite refs, exact
  compare-and-swap promotion, exact push leases, and atomic cleanup.
- The coauthor trailer cleaner is a dry run by default; `--apply` performs the
  rewrite. Recovery refs live under
  `refs/coauthor-trailer-cleaner/recovery/<suffix>`, and refs that still
  contain rewritten-away commits are listed after a run.
- The documentation site is built for `/rae-agent-workflows/docs/` and
  published under the operator demo's Pages site.
- Aligned public documentation with the autonomous, deterministic-loop,
  profile, evaluation, and repo-hygiene surfaces.
- Added purpose-and-rationale headers across executable source files plus a
  release gate that prevents undocumented source modules from entering the
  public candidate.

### Fixed

- Workflow gates fail on any blocking finding or any input that did not pass.
- Autonomous runs check Git state per phase, report ignored paths, retire
  stale locks, roll back the worktree when run setup fails, resume from the
  primary checkout, and parse renamed paths from `git status --porcelain -z`.
- Operator cleanup awaits worktree removal before responding.
- Ralph `--dry-run` no longer recovers transactions, switches branches, or
  archives state.

### Removed

- Obsolete runtime compatibility paths and superseded test surfaces.
- The test-file ignore rules in `.gitignore`.

### Security

- Hardened profile install/uninstall against symlink, parent-swap, hard-link,
  concurrent-edit, rollback, and recovery races.
- Hardened history rewriting against concurrent branch movement and partial
  recovery-ref cleanup.
- The coauthor trailer cleaner pushes its backup only with
  `--allow-backup-push` or when pushing is enabled.
- Added strict runtime, path, environment, output-size, timeout, and
  public-surface hygiene checks.
- Added autonomous-run postconditions for worktree HEAD/current-branch reflogs,
  index visibility, and remote configuration, including resume preflight
  rejection.
- Protected autonomous `.pipeline` state with an external owner-only byte
  guard, atomic single-claim recovery, and retryable evidence that restores and
  reverifies unauthorized workspace-phase changes before run state is consumed.
- Required fresh unsafe authorization and command arguments on every custom
  command-provider resume, confined task files to approved project text files,
  and restricted provider child environments.
- Moved Ralph fixing providers into external transaction workspaces with
  identity-bound recovery, atomic per-entry quarantine, native no-clobber
  installation, and retained conflict evidence.
- Ralph refuses fixing writes to its own runtime paths.
- Platform tokens must carry `iat`, and `exp - iat` may not exceed
  `auth.maxTokenLifetimeSeconds` (at most seven days).
- The platform Host allowlist applies to every route.
- Platform rebind requires the target worker to be registered for the run's
  project.

### Notes

- This is a public alpha candidate, not a stable API commitment.

<!--
Link convention: each version heading is a reference link. A released version
links to the compare view from the previous tag (`v<previous>...v<version>`);
the first release links to its tag. Unreleased changes link to
`v<latest>...HEAD`. Tags use the `v<version>` form.
-->

[0.1.0-alpha.1]: https://github.com/sebastianspicker/rae-agent-workflows/commits/main
