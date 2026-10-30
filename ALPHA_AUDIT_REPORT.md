# RAE Alpha Audit Report

Audit date: 2026-10-15 (revised the same day after the maintainer's scope answers). Commit audited: `bec03f0` (main, clean tree). Mode: audit only; no source file was modified. Ledger: `ALPHA_AUDIT_LEDGER.md` (gitignored, local) holds every finding with file:line and verification evidence, the decisions, and the session log. Scope per the maintainer: alpha audience is a maintainer checkout with the private tests; experiments, Ralph and the experimental platform are all in scope; no paid provider call was allowed, so the core workflow was exercised with the engine's local `command` test provider instead.

## 1. Verdict

RAE is one structural fix away from a credible alpha, and that fix is in the flagship workflow. A fresh clone installs, builds the native bridge and every workspace, passes `rae doctor` and the public verifier; the private suite of 589 tests passes apart from one load-flaky engine test and six Ralph tests that fail only because the audit sandbox denies the `uptime` syscall; the code sweep found no TODO markers, placeholder code, machine paths, secrets or silently swallowed exceptions, and all dependency licences are permissive. The graph engine's mechanics (isolated worktree, ten read-only nodes, bounded loops, gates, checkpoint, `--through`) ran end to end in a throwaway repository with a local provider. But that same run confirmed the one P0: the `build` writer receives only the task text and a checkpoint envelope containing a digest. It never sees the planner's `file_ownership`, task order or verification requirements, although it is told to "modify only paths owned by the plan" and is failed if it touches anything else. The same gap starves the repair writer and the critics, and the loop revisions re-run blind. Around that sit 33 P1 items in six clusters: engine robustness (no Ctrl-C handling, orphaned worktree on a mistyped `--through`, undiagnosable invalid payloads, envelope caps that fail long builds), the experiment runner (provider failures recorded as measured outcomes, no preflight, no cap, placeholders accepted), the operator (unlogged 5xx, registry writes on GET, hard-coded provider), the platform (OIDC `typ` default rejects common tokens, worker errors swallowed, artifact chain has no client, unbounded requeue loop), Ralph readiness (hard-coded "ok" check, dead example, bootstrap leaks build files) and two lockfiles with audit findings. Most P1 items are small; the P0 and the verification-related items are medium. A realistic estimate is two to three weeks of focused work plus one live validation run after the P0 fix.

## 2. Findings by category and priority

Counts: 78 findings. P0: 1. P1: 33. P2: 43. Resolved: 1 (F-043, by design). Missing implementation: 8. Bug: 30. Fix/hardening: 40. Effort S unless noted. (F-006 is listed under Fix/hardening for layout but is a Bug; F-030 moved to P2 after the maintainer's model probes.)

### Missing implementation

| ID | Pri | Title | Where | Effort |
| --- | --- | --- | --- | --- |
| F-062 | **P0** | The `build` writer never receives the plan: its only edge is `mutation-checkpoint -> build` (sequence), the checkpoint envelope carries digests only, the prompt embeds only predecessor envelopes, and `assertWriterEvidence` then fails any path outside `file_ownership`; `repair` and the critics are starved the same way. Confirmed at runtime: the build prompt holds the task text, one digest and the guidance "Implement only plan-owned changes" | workflows/graph-native-default.workflow.json:116; packages/engine/src/workflow/workflow-scheduler.ts:126-142; workflow-runtime.ts:400-431, 987-994, 204-237 | M |
| F-063 | P1 | Loop revisions get no feedback: loop-back edges are excluded from inputs and loop-member envelopes are deleted on restart, so `design` and `plan` re-run blind | packages/engine/src/workflow/workflow-scheduler.ts:127, 135-142, 529-533 | M |
| F-064 | P1 | Verification is critic opinion only: the engine never runs tests, lint or the plan's verification commands; a Codex writer needs one exit-0 command (`ls` suffices); `build`'s own blocking findings feed no gate; tutorial claims the run stops when a test fails | workflow JSON:94-103; workflow-runtime.ts:238-245; run-report-writer.ts:192; docs/tutorials/autonomous-code-change.md:137 | L |
| F-017 | P1 | Operator start hard-codes `--provider codex`; no provider choice or doctor at startup | apps/operator/lib/control.ts:461 | M |
| F-027 | P1 | `experiment run` never calls `agentDoctor` and has no circuit breaker | packages/engine/src/run/experiment-runner.ts:686-800 | S |
| F-049 | P1 | Shipped platform worker never calls `/artifacts/reserve` or `/verify`; the documented S3 upload/verify/quarantine/download chain cannot be exercised | apps/platform/bin/rae-platform-worker.ts; src/local-executor.ts:123-124 | M |
| F-057 | P2 | Platform: `active_revisions` never read, `signals` never delivered, revision "validate" trivial, outbox has no consumer or pruning, no retention, `artifactMismatches` never incremented | apps/platform/src/store.ts:490-1157; src/observability.ts | M |
| F-076 | P2 | `--graph-memory read` injects nothing into graph-native prompts | packages/engine/src/workflow/workflow-runtime.ts:1094-1095 | M |

### Bug

| ID | Pri | Title | Where | Effort |
| --- | --- | --- | --- | --- |
| F-065 | P1 | `agent run` installs no SIGINT/SIGTERM handler; Ctrl-C leaves status `running`, no report, a stale lock, and the detached provider running to its timeout while `resume` can start a second writer | packages/engine/src/run/autonomous-actions.ts; agents/bounded-process.ts:264-271 | S |
| F-066 | P1 | A mistyped `--through` is validated after the worktree, branch and run state exist, outside any rollback: orphan run in status `running` | packages/engine/src/run/autonomous-actions.ts:211-224, 874-876 | S |
| F-068 | P1 | `command_evidence`/`changed_paths` are not truncated to the envelope schema caps (1024/4096), so a long writer run fails after completing and is retried as a full run up to 3 times | workflow-runtime.ts:861-862; node-envelope-v2.schema.json:20-21 | S |
| F-026 | P1 | Experiment runner ignores the child exit code; `blocked` runs from bad auth or a bad model become `completed, pass=false` records | packages/engine/src/run/experiment-runner.ts:416-514 | M |
| F-014 | P1 | Operator returns every 5xx as "internal server error" and logs nothing | apps/operator/server.ts:202-216 | S |
| F-015 | P1 | Browser bootstrap has no per-step catch; a registry failure replaces the loaded catalogue with "Runs unavailable" | apps/operator/static/js/data.ts:80-83 | S |
| F-016 | P1 | GET `/workflows` creates the registry under `.git` (with a 1970 default revision) before route validation; unwritable gitdir gives an unlogged 500 | apps/operator/server.ts:539; workflow-registry.ts:234-258 | S |
| F-045 | P1 | Platform OIDC requires JWT `typ` to equal `tokenType` (default `at+jwt`); Keycloak/Auth0/Azure tokens are rejected and no doc shows the key | apps/platform/src/auth.ts:59-64; config.ts:40 | S |
| F-047 | P1 | Platform worker swallows the executor exception and reports "worker execution failed" for every misconfiguration | apps/platform/src/worker.ts:594-596 | S |
| F-050 | P1 | Duplicate `nodes[].key` hits a DB unique violation returned as 500 (REST) or raw PG text (MCP); MemoryStore diverges (runtime unverified, needs PostgreSQL) | apps/platform/src/store.ts:470-484 | S |
| F-051 | P1 | Node claims are `ORDER BY` random UUID, so nodes run in arbitrary order with no dependencies; undocumented | apps/platform/src/store.ts:943-956 | S/M |
| F-052 | P1 | `reclaimExpired` requeues unconditionally with no attempt ceiling: a crashing node loops forever until cancelled | apps/platform/src/store.ts:594-620 | S |
| F-001 | P1 | Ralph example invokes a `ralph.sh` nothing creates | examples/minimal-ralph-run/README.md:19 | S |
| F-002 | P1 | `ralph --check` prints literal "ok" strings and exits 0 with codex missing | packages/ralph/src/cli.ts:95-107 | S |
| F-007 | P1 | Ralph tutorial states the wrong state dir and omits that cwd mode needs `prd.json` + `INSTRUCTIONS.md` copied | docs/tutorials/first-ralph-run.md:20-54 | S |
| F-004 | P2 | Ralph README claims bootstrap copies a Node runtime | packages/ralph/README.md:40-41 | S |
| F-019 | P2 | Operator start looks for the run dir in the wrong place for worktree runs; always waits 2 s | apps/operator/lib/control.ts:407-415 | S |
| F-020 | P2 | Async catalog substitutes `status:"running"` when control file is missing | apps/operator/lib/runs.ts:357-363 | S |
| F-021 | P2 | `memoryStatus` throw reported as `unresolved_conflicts: 1` | apps/operator/lib/runs.ts:759 | S |
| F-031 | P2 | Suite check `readme-mentions-format` is vacuous; needs a new suite revision | experiments/suites/rae-smoke-v1/suite.json | S |
| F-035 | P2 | Engine lifecycle test is load-sensitive (fails under parallel load, passes alone) | packages/engine/test/run-lifecycle-worktree.test.ts:84-104 | S |
| F-036 | P2 | Public clone: all suites report `tests 0`, `npm test` exits 0, verify prints PASS with nothing run (P2 because the alpha audience is maintainers) | scripts/src/run-tests.ts:94-108; verify.ts:113-115 | S |
| F-038 | P2 | CHANGELOG claims tests are tracked and ignore rules removed; both false | CHANGELOG.md:63-64, 156 | S |
| F-069 | P2 | Retry after a read-only node mutates the repo re-baselines and passes | workflow-runtime.ts:767, 831-842 | S |
| F-071 | P2 | Last repair iteration runs an unverifiable repair; `--max-repair-rounds 1` gives two repairs | workflow-scheduler.ts:366-373 | S |
| F-072 | P2 | Budget accounting resets on resume; failed attempts never counted; wall clock checked only between nodes | workflow-scheduler.ts:351-356, 422-426, 607 | S |
| F-073 | P2 | `--through` checked only when a node settles; `--through plan` stops before alignment, not before a writer; no trace event | workflow-scheduler.ts:632; autonomous-actions.ts:942-946 | S |
| F-074 | P2 | Completion bookkeeping: wrong phase on `run_blocked`, status flip on late report failure, unreadable-state path leaves `running` | autonomous-actions.ts:939-995 | S |
| F-075 | P2 | Control lock throws immediately when held; replayed checkpoint decisions rewrite a finished run's status | run/operator-control.ts:120-131, 320-326 | S |

### Fix/hardening

| ID | Pri | Title | Where | Effort |
| --- | --- | --- | --- | --- |
| F-067 | P1 | Schema-invalid provider payload reports only "node X returned an invalid payload"; Ajv errors dropped, failed attempts persist nothing | workflow-runtime.ts:802-803; workflow-scheduler.ts:469-483 | S |
| F-028 | P1 | Failed trial records are permanent; documented placeholder-replacement flow then fails on lock/drift; recovery undocumented | experiment-runner.ts:142-170, 689-693 | S |
| F-029 | P1 | README quick start launches up to 24 paid trials with no budget or `--max-trials` | README.md:138-145; experiments/*.json | S |
| F-006 | P1 | Ralph's hard-coded default model `gpt-5.3` is rejected by Codex ("metadata not found", 400 for ChatGPT accounts); Ralph always passes `-m`, preflight is off, so the first story fails. Verified by the maintainer's probes: `gpt-5.6-sol` and `gpt-5.6-terra` work | packages/ralph/src/prd.ts:261; runner.ts:157; prd.json.example:7 | S |
| F-018 | P1 | Operator has no signal handling; Ctrl-C orphans the detached engine child (consequence unverified) | apps/operator/server.ts:794-815 | S |
| F-046 | P1 | Every jose failure collapses to 401 "invalid bearer token" with no code logged | apps/platform/src/auth.ts:85-92 | S |
| F-048 | P1 | Worker registration failure shows only the HTTP status; worker `doctor` checks env non-emptiness only | apps/platform/src/worker.ts:517-528; bin/rae-platform-worker.ts:8-26 | S |
| F-053 | P1 | Artifact verification silently requires S3 bucket versioning; undocumented, not checked by doctor | apps/platform/src/artifacts.ts:498-516 | S |
| F-054 | P1 | MCP tool handlers return raw error messages (PG, fetch) that REST masks | apps/platform/src/mcp.ts | S |
| F-055 | P1 | Worker refuses private/LAN/VPC/compose control-plane hosts outside loopback dev mode | apps/platform/src/worker.ts:176-194 | S/M |
| F-056 | P1 | Platform setup docs: no OIDC example config, deploy doc understates requirements, revision `digest` and node `profileDigest` computation undocumented, submission accepts ids that later fail silently, two hosted-api statements contradict the code | docs/how-to/deploy-experimental-platform.md:18; hosted-api.md:23,74; src/config.ts; src/store.ts:90-103 | M |
| F-003 | P1 | Ralph bootstrap copies the fs-bridge CMake build tree (absolute local paths, arch-specific binary) into the target repo | packages/ralph/src/helper.ts:146-149 | S |
| F-013 | P1 | `npm audit`: root 1 high (dev-only); platform 1 critical, 1 high, 1 moderate. None reachable (no express/trust-proxy, no MCP OAuth client, smol-toml parses owner-only config) but every `npm ci` prints them | both lockfiles | S |
| F-005 | P2 | Ralph `--check` codex probe diverges from the real resolver | packages/ralph/src/cli.ts:82-93 | S |
| F-030 | P2 | experiments README calls `gpt-5.6-terra` a placeholder but Codex accepts it (verified by probe); the clm-016 prices are still placeholders and `validate` warns about neither | experiments/README.md:53; experiment-contract.ts:249-252 | S |
| F-008 | P2 | Ralph writes `.runtime/ralph/`, temp dirs and reports into the tester's repo unannounced | packages/ralph/src/config.ts:354-367 | S |
| F-009 | P2 | Missing `prd.json` error lacks the `cp` hint | packages/ralph/src/prd.ts:69 | S |
| F-010 | P2 | `ralph --doctor` hard-codes `fs_bridge: "found"` | packages/ralph/src/cli.ts:133-153 | S |
| F-011 | P2 | Ralph CLI reference incomplete and marked experimental | docs/reference/cli/ralph.md | S |
| F-012 | P2 | Verify smoke never runs the bootstrapped CLI (bootstrapped install itself verified working) | scripts/src/verify.ts:109-113 | S |
| F-022 | P2 | Operator remote mode validates token file only on first request; `--execution-profile` ignored | apps/operator/lib/remote.ts:334-350 | S |
| F-023 | P2 | Proposal failures unlogged | apps/operator/lib/proposals.ts:179-187 | S |
| F-024 | P2 | Operator startup error quality (raw stack on old Node, raw ENOENT, git-missing misreport) | apps/operator/server.ts:46-48; lib/security.ts:31-39 | S |
| F-025 | P2 | Operator catalog/UI hardening bundle | apps/operator/lib/runs.ts; static/js/* | S |
| F-032 | P2 | Experiment validate fails on any symlinked path component without naming it | experiment-contract.ts:93 | S |
| F-033 | P2 | trials.csv lacks formula-injection guard | experiment-export.ts:131-135 | S |
| F-034 | P2 | Experiment CLI hints and doc drift | cli/experiment.ts:132-133, 422-426; docs | S |
| F-037 | P2 | README/CONTRIBUTING advertise test commands that run nothing publicly | README.md:221-242; CONTRIBUTING.md:62-89 | S |
| F-039 | P2 | 26 lint warnings, 2 infos | operator, engine, profiles | S |
| F-040 | P2 | CODEOWNERS routes non-existent `/evals/` | .github/CODEOWNERS:8 | S |
| F-041 | P2 | Ralph `os.uptime()` throws unhandled where the syscall is denied; every command exits 1 | packages/ralph/src/lock.ts:121 | S |
| F-042 | P2 | fs-bridge `-Werror`, macOS/Linux-only; README silent on Windows | packages/fs-bridge/CMakeLists.txt:3-12 | S |
| F-044 | P2 | No doc shows a full `resolve-checkpoint` invocation; umbrella reference omits `status/stop/events` | docs/tutorials/autonomous-code-change.md:49; docs/reference/cli/umbrella.md:85-150 | S |
| F-058 | P2 | Platform API gaps: no run list/node/attempt/artifact-list endpoints; SSE 30-min cap undocumented | apps/platform/src/http.ts | M |
| F-059 | P2 | Platform hard-coded staging paths, never-cleaned attempt dirs, no worker entrypoint or HEALTHCHECK, read-only-fs claim unenforced | apps/platform/src/hosted-staging.ts:216,333; Dockerfile | S |
| F-060 | P2 | Migrations: no down path, checksum or lock; hand-maintained required list | apps/platform/src/store.ts:106-113, 400-415 | S |
| F-061 | P2 | Platform error/log quality bundle (stack on missing env, raw Zod arrays, no hints, regex-based JWKS outage detection, presigned PUT unverified) | apps/platform/bin, src/config.ts:187, src/auth.ts:28-36 | S |
| F-070 | P2 | `containment_uncertain` timeouts are retryable; a second writer can start while the first provider may live | workflow-runtime.ts:272-282 | S |
| F-077 | P2 | Engine hardening bundle (no `.pipeline` guard for read nodes, ownership path hygiene, close-only process wait, crashed runs show `running`, v2.2 ignores budgets/flags, restore window race) | workflow-runtime.ts, bounded-process.ts, runtime-state-guard.ts | M |
| F-078 | P2 | Engine doc drift (stop timing, oversized ignored dir, `sequence` semantics, `--through plan`) | docs/tutorials/autonomous-code-change.md; packages/engine/README.md:96; workflow-v2.md:131 | S |
| F-043 | resolved | `/AGENTS.md` gitignored: by design (Q-5) | .gitignore:157-162 | - |

## 3. P0 items in recommended order

1. **F-062 (P0): deliver the plan to the writers.** Either add `artifact` edges `plan -> build` and `plan -> repair` (and `build -> repair-join`/critics so critics see what changed) in `workflows/graph-native-default.workflow.json`, or have the runtime inject the ownership-plan payload into every `access: write` prompt next to the rule that cites it. Bump the workflow revision and digest. Re-run the local-provider probe (`--provider command --allow-unsafe-command-provider --through build`) and confirm the build prompt carries `file_ownership`. No dependencies; everything else in the engine cluster assumes this is fixed.

Recommended P1 order after the P0, grouped by dependency:

2. **Engine robustness: F-065, F-066, F-067, F-068.** Signal handler that stops the run and kills the provider group; validate `--through` before `initializeOrResume`; include Ajv errors and persist failed attempts; truncate or chunk evidence to the schema caps. Independent of each other; F-063 (loop feedback) and F-064 (real verification) follow once F-062's edges exist, since both are workflow-context changes.
3. **Experiment runner: F-027 then F-026, then F-029, F-028.** Preflight per arm and a consecutive-failure stop; then exit-code and status handling with an infrastructure status (contract addition); then quick-start cap and documented recovery path.
4. **Operator: F-014 then F-016 then F-015, then F-017 and F-018.** Log before masking; lazy registry creation after route validation; per-step UI error handling; provider doctor at start; signal handling.
5. **Platform: F-045 + F-046 (auth), F-047 + F-048 (worker diagnostics), F-052 (requeue ceiling), F-050 (duplicate keys), F-051 (document or implement ordering), F-049 + F-053 (either ship an artifact client or document the chain as server-only), F-055, F-054, F-056.** Auth first, because nothing else is testable without a working login.
6. **Ralph: F-006 then F-002 then F-001 then F-007 then F-003.** Replace the stale `gpt-5.3` default (or omit `-m` when unset), make `--check` real, fix the example, fix the tutorial, narrow the bootstrap copy.
7. **F-013:** bump both lockfiles.

## 4. Assumptions made and how the result changes if any are wrong

- **Mode AUDIT ONLY (Q-1):** confirmed by the maintainer; no file was modified.
- **Maintainer audience (Q-2):** confirmed; F-036, F-037, F-038 are P2. If external testers on a public clone become the audience, they return to P1.
- **Experiments, Ralph and platform in scope (Q-3, Q-4):** confirmed; their findings are weighted as core. If the platform is later declared experimental-only, F-045..F-056 drop to P2 and F-013 to P2 (the vulnerabilities are not reachable).
- **AGENTS.md gitignored by design (Q-5):** confirmed; F-043 resolved.
- **No paid provider call by the auditor (Q-6):** the core workflow was validated with the local `command` provider, which exercises the engine but not Codex's sandbox, output schema handling or event stream. A single live `agent run` after the P0 fix remains the one unperformed validation of the flagship path. The maintainer ran four one-line `codex exec` model probes outside the sandbox, which settled F-006 and F-030.
- **Unverified items are labelled** in the ledger: runtime consequence of F-018 and F-065 (needs a Ctrl-C test), F-050 (needs PostgreSQL), provider-side behaviour for F-026. None is P0; the P0 was confirmed at runtime.

## 5. Open questions still needing a decision

None block the audit. Two maintainer choices shape the fix plan:

- For F-062/F-063/F-064, whether to fix by workflow data (edges in the default workflow) or by runtime injection of the plan into writer prompts; the former is revision-controlled and visible in the editor, the latter protects user-authored workflows too.
- For F-049/F-053, whether the alpha ships an artifact client in the worker or documents the artifact chain as server-only.

## Verification record

- Clean clone: `npm ci --ignore-scripts` (root, platform), `npm run build`, `npm run build:platform`, `npm run rae -- doctor` (PASS), `npm run verify -- --skip-install --skip-build --skip-tests` (PARTIAL, exit 0, docs build OK), `npm test` (0 tests, exit 0).
- Main checkout: 589 tests. Engine 274/276 (1 flaky, 1 skip); operator 52/52; platform 123/124 (1 skip, no database); Ralph 57/64 (6 sandbox `uv_uptime` failures, 1 skip); profiles 16/16; trailer cleaner 29/29; repository tools 16/16; dev-tools 4/4; fs-bridge 8/8.
- `biome lint .`: exit 0, 26 warnings, 2 infos. Typecheck, architecture, docs and adapter checks: pass. `npm audit`: root 1 high; platform 1 critical, 1 high, 1 moderate.
- Local-provider probe: default workflow run through `build` in a throwaway repository with `RAE_STATE_HOME=~/.cache/rae-audit-state`; exit 0, status `stopped-at-through-node`; build prompt captured (ledger F-062). Ralph bootstrap into a throwaway repository: embedded `--check` and `--validate-prd` exit 0.
- No external service was called. The working tree is unchanged; only this report (untracked) and the gitignored ledger were created. One directory was created outside the repo for the probe and can be removed: `~/.cache/rae-audit-state`.

## Implementation results

Implemented 2026-10-30 on branch `alpha-readiness` (from `main` @ `bec03f0`); scope P0 + all P1, attended. Decisions, questions and the step log are in the gitignored `ALPHA_IMPLEMENTATION_LEDGER.md`; tester-facing limits are in `ALPHA_KNOWN_ISSUES.md`.

### Verdict: READY WITH CONDITIONS

Every in-scope finding is fixed with a regression test (in the private suites), no finding is blocked or deferred, and the alpha gate passes with no new test failures. Conditions before handing the alpha to testers:

1. **One live Codex run of the default workflow.** No paid provider call was made during the audit or the implementation; the flagship path was exercised end to end only with the engine's local test provider (automated, both context modes, through completion). Run `agent run` once with Codex on a throwaway repository and confirm the plan, the verification-command binding and the report.
2. **The experimental platform needs one run against real PostgreSQL and S3/MinIO** (`RAE_PLATFORM_DATABASE_URL` + `test:integration`, plus a worker with `RAE_PLATFORM_UPLOAD_ARTIFACTS=true`) before it is offered to testers. Claim order, the attempt ceiling, unique-violation mapping, artifact upload/verify and the bucket-versioning probe are verified only against simulated clients.
3. **Testers use maintainer checkouts** (the agreed alpha audience); public clones run no tests.

### Findings and commits

| ID | Pri | Final status | Commits |
| --- | --- | --- | --- |
| F-062 | P0 | fixed | 4d5e930, 933929f, 3ae0e3c; visible `context` edges via F-079 73da88d, 97e2d4a |
| F-063 | P1 | fixed | 0c76ecf |
| F-064 | P1 | fixed (evidence binding; writer findings routed to repair) | 8be2f80, 78fffae, 79c9ee9 |
| F-065 | P1 | fixed | a4b51d0 |
| F-066 | P1 | fixed | 423b121 |
| F-067 | P1 | fixed | e955e56 |
| F-068 | P1 | fixed | 242ffc8 |
| F-027 | P1 | fixed | 4d0c73e, c039ab5 |
| F-026 | P1 | fixed | 84696bf, 8bfe904 |
| F-029 | P1 | fixed | 1597168 |
| F-028 | P1 | fixed | 00c3265, 629ec01 |
| F-014 | P1 | fixed | a62caa1 |
| F-016 | P1 | fixed | 2d8a040, 0c9849c |
| F-015 | P1 | fixed | 3559441 |
| F-017 | P1 | fixed | 341be7b, 4e06b51 |
| F-018 | P1 | fixed (EPIPE crash reproduced and fixed) | 24ba54d, 17afba1 |
| F-045 | P1 | fixed | d9685dc, 2ff61fa |
| F-046 | P1 | fixed | 57f9e31 |
| F-047 | P1 | fixed | 0aed39d, 7e4ddfa |
| F-048 | P1 | fixed | bedac99 |
| F-049 | P1 | fixed (opt-in worker artifact client) | 3c43a2c, 35241ac |
| F-050 | P1 | fixed | 754d38d |
| F-051 | P1 | fixed (deterministic order, documented as independent) | fc69aea |
| F-052 | P1 | fixed | be6a081 |
| F-053 | P1 | fixed | 95f7166 |
| F-054 | P1 | fixed | 7913dbf, 328b43c |
| F-055 | P1 | fixed (documentation only; guard unchanged by decision) | cf866de |
| F-056 | P1 | fixed | eb3fc8a, 6605cc4 |
| F-001 | P1 | fixed | b9383b8 |
| F-002 | P1 | fixed | e6283f9 |
| F-003 | P1 | fixed | 49d95a5 |
| F-006 | P1 | fixed | 82f0529 |
| F-007 | P1 | fixed | cfe6bb6 |
| F-013 | P1 | fixed (root patch overrides; approved platform minor bumps) | 828fb6d, bba442d |

Changelog-only commits: 3b422ef, f9aeec8. P2 findings outside scope remain open unless listed below.

### New findings

| ID | Pri | Title | Status |
| --- | --- | --- | --- |
| F-079 | P1 | No edge type carries data without enabling its target (needed to draw plan→writer safely) | fixed 73da88d, 97e2d4a |
| F-085 | P1 | Operator start/resume with an execution profile always failed (`--provider` + `--execution-profile`) | fixed d7bf8b1, 26d2aad |
| F-009 | P1 (raised from P2) | Fresh-clone README `ralph --check` fails without `prd.json` | fixed a4434cf |
| F-080 | P2 | Legacy-linear runs have no Ctrl-C handling | open |
| F-081 | P2 | Evidence-truncation warning not bounded by the findings cap | open |
| F-082 | P2 | v2.1 context edges may deliver an earlier iteration's envelope | open |
| F-083 | P2 | Graph projection: two edges on one node pair share a version id | open |
| F-084 | P2 | v2.0/v2.2 context "latest passed" uses the current entry only; 2.2 doc and edge diagram not updated | open |
| F-086 | P2 | Operator provider health probes only Codex, once | open |
| F-087 | P2 | Platform PG-only paths verified with scripted clients only | open (condition 2) |
| F-088 | P2 | MCP events resource template requires both query parameters | open |
| F-089 | P2 | Artifact upload/versioning probe verified against fakes only | open (condition 2) |
| F-090 | P2 | Rejected bearer tokens log one warning each (log amplification) | open |
| F-091 | P2 | Platform claim order has no per-project fairness; rolling worker restarts can exhaust the 3-attempt ceiling | open |

### Gate results

- **Clean checkout:** fresh clone of `alpha-readiness`, README setup verbatim (`npm ci --ignore-scripts` root and platform, `npm run build`, `npm run build:platform`, `rae doctor`): all exit 0, no deviation. README quick start in the clone: `--help`, `agent doctor` (Codex authenticated), `experiment validate` (24 planned trials), `experiment run --dry-run` exit 0; `ralph --check` failed (no `prd.json` step) → fixed as F-009, then exit 0; `verify --skip-install --skip-tests` VERDICT PASS (PARTIAL overall because tests are private). Paid steps not run.
- **Workflow smoke runs (automated, private suites):** default-workflow `agent run` to completion with the test provider in legacy and bounded context (plan reaches build, critics and diagnosis; writer findings reach diagnosis and the report); SIGINT stop; `--through` validation; experiment doctor, breaker and outcome classification; operator start, profile start/resume, shutdown with detached runs and EPIPE; Ralph bootstrap with embedded `--check`; platform worker reserve → upload → verify against a local fake storage server.
- **Test delta (main checkout, sandboxed):** 589 → 711 tests; engine 276 → 336 (1 skip), operator 52 → 69, platform 124 → 165 (1 skip, no database), Ralph 64 → 68 (the same 6 sandbox `uv_uptime` failures as the baseline, 1 skip), other suites unchanged and green. 0 new failures. Typecheck, platform tsc, lint (26 warnings, unchanged), format, architecture, docs, adapters pass; `npm audit` 0 for root and platform (baseline 3 and 7 advisories).
- **Hygiene sweep on changed lines:** no TODO/FIXME, absolute machine paths, `console.log`, empty catches or secret-like literals. Independent reviews ran on every cluster (engine P0, context edge, experiments, operator) and a security review on the platform; their should-fixes were applied in follow-up commits.

### Decisions to review (Tier 2) and what reversing them changes

| Decision | Choice | If reversed |
| --- | --- | --- |
| D-5 / D-11 (F-062, F-079) | Plan reaches writers by runtime injection; the visible plan→writer edges use a new `context` edge type added **additively** to the existing 2.0/2.1/2.2 schemas (precedent: optional budgets) | A separate schema version means moving the default workflow to it; no behaviour change. Removing `context` returns to injection only; verdict unchanged |
| D-9 (F-064) | Engine binds Codex writers to plan `verification_commands`; it never runs commands itself; OpenCode not bound | Engine-executed commands would move a security boundary; verdict unchanged |
| D-10 (F-064b, user) | Writer-reported blocking findings route to diagnosis (advisory) and are listed in the report | Fail-closed instead: runs stop on a writer's own finding; verdict unchanged |
| D-13 (F-026/F-027) | Blocked run with no passed provider step = `launch-failed` (attrition); doctor before the first trial; 3-strike stop | Counting them as measured failures lowers observed pass rates for infrastructure problems; verdict unchanged |
| D-14 (platform) | OIDC `typ` unchecked unless configured (ID-token markers rejected); attempt ceiling 3; deterministic claim order without migration | Strict `at+jwt` default rejects common IdP tokens unless configured; verdict unchanged |
| D-16 (Ralph) | No hard-coded model; `--check` exits non-zero when Codex is missing | Restoring a default model id reintroduces a first-story failure when the id is retired |
