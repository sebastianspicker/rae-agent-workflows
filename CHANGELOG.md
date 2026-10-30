# Changelog

Notable public changes to the RAE umbrella are recorded here. Component
packages retain their own changelogs where applicable.

## [0.1.0-alpha.1] - Unreleased

### Added

- Experiment report v2: task-level inference, global Holm correction, explicit
  coverage and missing-outcome bounds, per-task CSV, and content digests.
- Durable experiment start/finish/acknowledgment receipts, crash recovery that
  preserves unknown outcomes, cumulative wall budgets and conservative unknown
  cost accounting. V3 locks replace v1/v2 for new execution; old outputs remain
  reportable. DR-003 documents migration and soft cost-limit semantics.
- Private execution evidence archives survive verified workspace cleanup:
  exact run bytes, committed source, tracked patches and nonignored new files.
  `experiment verify-evidence` checks provenance and file hashes. Interrupted
  evaluators remain unknown rather than becoming measured model failures.
- Offline `experiment analyze --bundle` reproduces exported analyses without
  providers or original fixtures. Execution locks now fingerprint input
  contents; resume preserves failed records and limits only new trials.
  See DR-002 for legacy-lock/report migration.

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
- Preregistered experiment layer. Four additive v1 contracts (task suite,
  experiment, trial record, experiment report) under
  `packages/contracts/v1/schemas/experiments/`; the `rae experiment`
  `validate|plan|run|label|report|export` commands, which run interleaved arms
  as isolated `agent run` trials and keep one record per trial; seeded
  statistics (Wilson intervals, bootstrap, exact McNemar, sign-flip permutation,
  Holm correction, pass@k, Cliff's delta, Cohen's kappa), benchmark cards and
  JSON lines/CSV exports with a datasheet; committed data under `experiments/`
  (the four-task `rae-smoke-v1` suite, a single-writer baseline workflow, two
  execution profiles and designs for CLM-007, CLM-014 and CLM-016); and the
  [contract reference](docs/reference/contracts/experiments-v1.md),
  [how-to](docs/how-to/run-an-experiment.md),
  [method](docs/explanation/science/experimental-method.md) and
  [decision record](docs/reference/decisions/dr-001-experiment-layer.md) pages.
- Workflow edge type `context` (schemas 2.0, 2.1 and 2.2, additive): passes the
  source's latest passed envelope as data and never enables its target. The
  default workflow draws `plan` to `build` and `repair` as context edges.

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

- Experimental platform: without `oidc.tokenType`, ID tokens (`nonce` or
  `at_hash` claims) are rejected as bearer tokens; `oidc.audience` must be a
  dedicated API identifier.
- Experimental platform: workers report artifact upload failures to the control
  plane only as `upload failed` (detail stays in the local log) and pin the
  upload connection to a single resolved address.
- Experimental platform: failure and log text now also redacts `file://` URLs,
  UNC paths and `password=`, `secret=`, `api_key=`, `credential=` and
  `X-Api-Key:` values.
- Experimental platform: the hosted example config caps token lifetime at one
  hour (`maxTokenLifetimeSeconds = 3600`) instead of a day.
- Workflow gates fail on any blocking finding or any input that did not pass.
- Autonomous runs check Git state per phase, report ignored paths, retire
  stale locks, roll back the worktree when run setup fails, resume from the
  primary checkout, and parse renamed paths from `git status --porcelain -z`.
- Operator cleanup awaits worktree removal before responding.
- Ralph `--dry-run` no longer recovers transactions, switches branches, or
  archives state.
- Writers now receive the ownership plan they are checked against: every
  `access: write` node, and every agent or map node in a loop that contains
  one, gets the planner's latest passed envelope as an input. The default workflow
  (revision 2) also passes the build envelope to the repair-loop critics.
- A restarted bounded loop's loop-back target now receives the failing gate's
  envelope and its own previous output instead of re-running blind.
- The default plan declares `verification_commands`; Codex writers must show
  exit-0 workspace-root evidence for each. A writer's own blocking findings
  reach `diagnose` over a `context` edge and go through the repair loop, and the
  run report lists them under "Writer-reported blocking findings".
- Writer runs with more than 1024 commands or 4096 changed paths no longer fail
  envelope persistence: the envelope keeps the cap-sized tail/head, records the
  totals in `resource_usage.evidence_truncation` and adds a warning finding.
- A provider payload that fails its contract now names the failing properties
  (first five Ajv errors) in the node failure, trace event and blocked result.
- `agent run --through <node>` validates the node against the resolved workflow
  before creating the worktree, branch or run state, so a typo leaves no orphan run.
- `agent run` and `agent resume` handle SIGINT/SIGTERM like `agent stop` (provider
  group killed, run stopped with a report, lock released); a second signal exits.
- `experiment run` runs the provider doctor for each distinct arm configuration
  before the first new trial (not with `--dry-run`) and stops after 3
  consecutive infrastructure failures instead of burning every slot.
- `experiment run` records a trial whose `agent run` ended `blocked` with no
  passed agent or map envelope as `launch-failed` (infrastructure), not as a
  measured `pass: false`; the child exit code goes in `run.status`.
- The README experiment quick start uses `--dry-run` then `--max-trials 1`, and
  `experiment run` warns on stderr with the trial count when the experiment has
  no budgets and `--max-trials` is not set.
- The `experiment run` input-drift and lock-mismatch errors now say to start a
  fresh output directory with `--output <dir>`; the how-to and
  `experiments/README.md` document the retry flow.
- The operator logs one stderr line (method, path without query, message, stack)
  for every masked 5xx; the response body stays `internal server error`.
- Reading or probing operator workflow routes no longer creates
  `<git-common-dir>/rae-workflows`; the registry and its seeded default revision
  are created on the first draft or activation, and only after the request
  validated. A registry seeded with an older default revision reports the
  committed default revision without writing.
- The operator console isolates its startup steps: a workflow-registry or profile
  failure shows in its own panel and no longer replaces the loaded run catalogue.
- Operator start accepts `provider` (`codex` default, `opencode`) and `model`; the
  server runs the provider doctor at startup, logs a warning and reports
  `provider_health` in `GET /api/v1/projects`, and the new-run dialog shows it.
  The doctor runs as a child process, so it no longer blocks the operator's event
  loop; `provider_health` stays `null` until it finishes.
- The operator exits 0 on SIGINT/SIGTERM after closing the server; runs it started
  are detached and keep running (stop them with `agent stop`). The engine CLI
  ignores EPIPE on stdout and stderr, so such a run no longer exits 1 after it
  completed when its starter's pipes are gone.
- Operator runs started with an execution profile no longer pass `--provider`,
  which the engine rejects alongside a profile; a request combining a profile
  with a provider or model gets 400. Resuming such a run likewise omits
  `--provider` and lets the engine restore the stored profile.
- Platform OIDC verification no longer requires a JWT `typ` header unless
  `oidc.tokenType` is set (Keycloak, Auth0 and Azure send `typ: JWT`), and a
  rejected bearer token logs the jose error code server-side.
- Platform workers report a scrubbed executor error instead of "worker execution
  failed", registration errors include the control plane's reason, and
  `rae-platform-worker doctor` validates digests, the token and `/healthz`.
- Platform nodes fail with "attempts exhausted" after 3 expired leases instead
  of requeueing forever; duplicate node keys are rejected with 400 (409 on a
  racing unique violation); claims are ordered by run age then node key.
- Platform MCP tools and resources mask non-client errors as `internal error` and
  log them.
- `rae-platform doctor` fails unless the artifact bucket has versioning
  `Enabled`, which verification requires; the requirement is documented.
- The platform worker's control-plane endpoint rules (public HTTPS only,
  loopback HTTP in development) and the supported topologies are documented.
- The platform worker can upload attempt artifacts (`RAE_PLATFORM_UPLOAD_ARTIFACTS=true`):
  it reserves, PUTs the exact bytes to the presigned URL and verifies each
  artifact, and lists the outcomes in the report's `artifactUploads`.
- Platform run submission rejects project IDs and node keys a worker cannot
  claim with 400; a hosted example configuration, the configuration
  requirements and the revision and profile digest computation are documented,
  and the hosted API guide now matches the health-probe Host check and
  heartbeat retry behaviour.
- Ralph no longer defaults to the retired `gpt-5.3` model; without a configured
  model it lets Codex choose. `--check` probes the PRD, Node, the native bridge
  and Codex and fails when one is missing; `--doctor` reports the real bridge.
- Ralph bootstrap copies only the compiled bridge addon, records the build
  platform and refuses to run on another one.
- The minimal Ralph example and the first-run tutorial use real commands and
  the correct state directory.
- A missing Ralph `prd.json` error now names the example to copy, and the
  README quick start copies it before `ralph --check`.

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
