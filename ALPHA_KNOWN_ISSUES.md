# RAE alpha: known issues

This alpha is for people working from a maintainer checkout. It covers
autonomous code changes, the operator console, research experiments, the Ralph
story loop and the experimental hosted platform. Below is what does not work
yet, what to watch for, and how to report problems.

## Before you start

- **Only macOS and Linux are supported.** The native filesystem bridge does not
  build on Windows. A compiler newer than ours may also turn a new warning into
  a build error; if the bridge fails to compile, report the compiler version.
- **Public clones have no tests.** The test suites are kept out of the public
  repository. On a public clone, `npm test` and `verify` report success without
  running any tests. Use a maintainer checkout to run them.
- **Some steps cost money.** `agent run`, `experiment run` and Ralph's audit mode
  call a paid model provider. Do a dry run first (`experiment run ... --dry-run`).
  Then run one trial at a time (`--max-trials 1`). An experiment without a budget
  can launch up to 24 long trials.

## Autonomous runs (`agent run`)

- **The engine does not run your tests itself.** The plan names the
  verification commands. A Codex writer must show that it ran each one
  successfully from the repository root. OpenCode writers are not yet held to
  the plan's commands. Review the run report before you accept a change.
- **The writer's own warnings may not trigger a fix.** A writer can report a
  blocking problem in its own output. The default workflow passes that report to
  the diagnosis step, but whether a repair follows depends on the model's
  judgement. The run report always lists these problems under "Writer-reported
  blocking findings". Check that section before release.
- **Stopping and resuming:** press Ctrl-C once to stop a run cleanly. A second
  Ctrl-C exits immediately and may leave a stale lock, which the next `resume`
  clears. Runs started with `--legacy-linear` do not stop cleanly on Ctrl-C yet.
  Use `agent stop` for those.
- **Graph memory:** `--graph-memory read` records memory after the run. It does
  not yet feed earlier memory into the prompts.
- **Budgets:** budget counters restart when you resume a run, and the wall-clock
  limit is checked only between steps.

## Operator console

- **Runs keep going when the console closes.** Stopping the console does not
  stop its runs. Use the Stop button after restarting the console, or
  `agent stop`.
- **The provider check is limited.** The console checks only Codex, and only
  once at startup. The warning in the new-run dialog can show even when you
  picked OpenCode. It also stays until you restart the console.

## Experiments

- **Failed trials are permanent.** To retry after changing an experiment, use a
  new output directory (`--output <dir>`). The old directory stays reportable.
- **Some failures count as attrition, not as model failures.** A trial whose run
  never got a single step to succeed is recorded as a launch failure. This
  covers bad credentials, an unknown model or a missing provider. It also covers
  invalid output or a timeout in the very first step. Such trials widen the
  pass-rate bounds instead of lowering the observed pass rate.
- **A run stops after three infrastructure failures in a row.** Fix the cause,
  then run again.
- **The cost figures in the cognitive-tiering experiment are placeholders.** Do
  not read cost results from it.

## Ralph

- **Ralph uses your Codex default model.** Without a configured model, Ralph
  lets Codex choose. Set `RALPH_MODEL` to pick one.
- **Ralph writes into the target repository.** It creates `.runtime/ralph/` and
  temporary folders there. Add them to your ignore file, or run Ralph on a
  scratch clone.
- **A bootstrapped install is tied to one machine type.** It refuses to run on
  a different operating system or CPU type. Bootstrap again on the target
  machine.
- **Locked-down sandboxes are not supported.** Ralph fails with "uv_uptime
  returned EPERM" in a sandbox that blocks the system uptime call.

## Experimental hosted platform

- **It has not been tested against a real database or real object storage.**
  Several behaviours are covered only by simulated clients:
  - claim ordering
  - retry limits for crashing work items
  - duplicate-key handling
  - artifact upload and verification
  - the storage versioning check

  Please report anything you see against real PostgreSQL or S3/MinIO.
- **Artifact upload is off by default.** Set `RAE_PLATFORM_UPLOAD_ARTIFACTS=true`
  on the worker. The storage bucket must have versioning enabled.
  `rae-platform doctor` checks this.
- **Workers need a public HTTPS address.** They refuse control planes on
  private, LAN, VPC or container-network addresses; this is a deliberate safety
  guard. Put the control plane behind a public HTTPS name, or use loopback for
  local development.
- **Work items are independent.** They have no ordering or dependencies, and a
  failed item does not cancel the others.
- **The events URL needs both query parameters.** The `rae://runs/<id>/events`
  resource answers only when both `cursor` and `limit` are given.

## How to report a bug

Open an issue in the repository, or follow `SECURITY.md` for anything security
related. Please include:

1. What you ran (the full command) and what you expected.
2. The output of `npm run rae -- doctor`, plus `npm run rae -- agent doctor`
   for run problems.
3. Your operating system, `node --version` and the Git commit
   (`git rev-parse HEAD`).
4. For autonomous runs:
   - the run id;
   - `run-report.md`;
   - the `workflow/attempts/` folder under `.pipeline/runs/<run-id>/` in the run's
     workspace;
   - the output of `npm run rae -- agent status --project-root <workspace>
     --run-id <run-id> --json`.
5. For experiments:
   - the experiment file;
   - the `trials.csv` export, or the trial records of the failing trial;
   - the error line.
6. For the operator: the console's terminal output. Server errors are logged
   there with their cause.
7. For Ralph: the output of `--doctor` and the report under `.claude/` or
   `.runtime/ralph/`.

Remove secrets, tokens and private paths before you attach logs.
