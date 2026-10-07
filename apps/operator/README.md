# RAE loopback operator console

The operator presents durable autonomous-run state under `.pipeline/`. It binds
only to `127.0.0.1`, uses an ephemeral port by default, and does not expose raw
provider traces. The interface uses modular CSS and TypeScript under
`static/css/` and `static/js/`, compiled into `dist/static/`. Its design system
is defined by the stylesheets under `static/css/`.

## Task and evidence review

The selected task places recorded evidence beside the human decision. Text a
person wrote (the task, rationale and saved decisions) is set in a serif, and
everything the machine recorded is set in monospace. A stepped trace follows
task, checkpoint, execution and hand-off from recorded run state only; it does
not estimate progress or replace the workflow graph. Approval saves its
outcome and rationale. Resume is a separate action enabled by the server's
current run controls. Draft rationale survives background updates to the same
checkpoint. Start validates the task's 32 KiB UTF-8 limit before submission.

Completed runs retain references for local report and worktree-diff inspection.
Completion does not publish or release changes. Full gate, resource, event and
recovery controls remain under **Run details**; the complete revision-controlled
workflow editor remains under **Workflow editor**. **All runs** exposes the
catalogue, search, state filters (All, Active, Needs decision, Completed,
Blocked) and new-run form; Blocked means a failure, while human holds are under
Needs decision. `Cmd+K` on macOS or `Ctrl+K` elsewhere opens run search and
focuses it. Copy controls copy displayed references without reading local
files. At 1440 px and wider the catalogue stays beside the selected record.

While the tab is visible the console re-reads run summaries every 10 seconds.
A top-bar "N decisions pending" button filters the catalogue to runs waiting on
a human decision, and the page title gains an `(N)` prefix. The connection pill
reports the health of the catalogue refresh and the live event stream; the
stream reconnects after the server's routine 15-second cycle silently and after
errors with capped exponential backoff. Run controls are never disabled by
event-log errors, and Stop and Interrupt stay available from the catalogue row
while run details are loading or unavailable because the server validates them. Reject and Escalate
ask for confirmation and show the rationale that will be saved. Errors stay on
screen until dismissed; notices expire.

Without a stored choice the theme follows the operating system live; the theme
control stores a chosen light or dark preference when browser storage is
available. Narrow windows stack evidence before decisions. State is always given
in text as well as colour.

The console self-hosts two SIL Open Font License typefaces, IBM Plex Mono and
Newsreader, under `static/fonts/` with their licences. The server's content
security policy allows same-origin fonts only (`font-src 'self'`); no asset is
loaded from another origin.

## Static Pages demo

The Pages demo is a real interactive browser surface using the same static UI,
but it is not the screenshot capture workflow. Its data, API responses, NDJSON
event stream, and mutations live only in the browser. It has no repository or
filesystem access, makes no backend API calls, and exposes no live or publish
controls.

The build also emits `demo/tour.html`, a screenshot tour of the workflow editor
at desktop and mobile widths. The demo banner links to it.

Build the static output into the safe default temporary directory:

```bash
npm --workspace @rae/operator run build:demo
```

Or provide a dedicated directory for a Pages upload or local static server:

```bash
npm --workspace @rae/operator run build
node apps/operator/dist/scripts/build-demo.js --out .runtime/operator-demo
python3 -m http.server --directory .runtime/operator-demo 8080
```

`"$TMPDIR/rae-operator-demo"` works as an alternative output directory. The
output must be a strict descendant of the real temporary directory or of
`<repo>/.runtime/`. An existing output directory must contain the marker file
`.rae-operator-demo` written by the build. Anything else is refused before any
delete happens.

The build copies the real static assets, replaces the production entry module
with the demo bootstrap, rewrites root-relative assets for a Pages subpath, and
writes `.nojekyll`. Do not commit its generated output. The regular operator
entry remains bearer-authenticated, same-origin, and loopback-only.

## Screenshots

Sanitized layout captures use the maintained CSS and fixture data. They are not
evidence from a real run:

![Workflow editor desktop fixture](docs/screenshots/evidence-dossier-desktop.png)

![Workflow editor mobile fixture](docs/screenshots/evidence-dossier-mobile.png)

Start it with one or more canonical Git roots:

```bash
npm --workspace @rae/operator run build
node apps/operator/dist/server.js \
  --project /absolute/path/to/repository
```

The supported umbrella form is:

```bash
npm run rae -- operator serve --project /absolute/path/to/repository
```

Preload one or more server-owned execution profiles with repeatable
`--execution-profile <file>` arguments. Profile paths and credentials stay on
the server. The browser receives only sanitized IDs, routes, models, and
readiness.

The server prints one URL. Its 256-bit session token appears only in the URL
fragment. The app removes the fragment from browser history and keeps the token
in memory for bearer-authenticated API and event-stream requests.

## Remote upstream mode

To use the same local console with a separately hosted operator API, keep the
browser session on loopback and configure an upstream origin and an owner-only
credential file:

```bash
npm run rae -- operator serve \
  --remote-url https://operator.example \
  --token-file /absolute/path/to/operator-token
```

Remote mode cannot be combined with `--project`. The browser still reaches only
the ephemeral local URL and sends only its local session bearer. The server
reads the upstream bearer token from `--token-file` for every forwarded request;
it is never included in browser JavaScript, local API responses, or errors.

`--remote-url` must be an origin-only HTTPS URL. Plain HTTP is rejected, including for
loopback origins. The token file must be a regular file
owned by the current user, with no group or world permissions; symlinks and
unsafe files are rejected. Token rotation therefore takes effect on the next
request without restarting the console.

Remote mode is a fixed API relay, not a general proxy. It rejects redirects and
forwards only the `/api/v1` methods used by this console, including the listed
run, event, control, and workflow-editor routes. Request bodies are limited to
64 KiB and upstream responses to 1 MiB. Upstream responses must be
`application/json`; the event stream route also accepts `application/x-ndjson`
and `text/event-stream`. Any other content type is answered with 502, an
unreachable upstream with 502 and an upstream timeout with 504. Streamed events
honour local backpressure, and a stream that reaches the size limit ends with a
`{"event":"stream_error","status":"size_limit"}` line.

## API

All `/api/v1` requests require the session bearer token and an exact loopback
`Host`. State-changing requests also require the exact loopback `Origin`.

- `GET /api/v1/projects`
- `GET /api/v1/projects/:projectId/execution-profiles`
- `GET|POST /api/v1/projects/:projectId/runs`
- `GET /api/v1/projects/:projectId/runs/:runId`
- `GET /api/v1/projects/:projectId/runs/:runId/events`
- `GET /api/v1/projects/:projectId/runs/:runId/events/stream`
- `POST .../:runId/stop`
- `POST .../:runId/resume`
- `POST .../:runId/interrupt`
- `POST .../:runId/checkpoint-decision`
- `POST .../:runId/cleanup`
- `GET /api/v1/projects/:projectId/workflows`
- `GET /api/v1/projects/:projectId/workflows/:workflowId`
- `GET|POST /api/v1/projects/:projectId/workflows/templates`
- `POST /api/v1/projects/:projectId/workflows/:workflowId/analysis`
- `POST /api/v1/projects/:projectId/workflows/:workflowId/proposals`
- `GET /api/v1/projects/:projectId/workflows/:workflowId/proposals/:jobId`
- `POST /api/v1/projects/:projectId/workflows/:workflowId/drafts`
- `GET /api/v1/projects/:projectId/workflows/:workflowId/diff`
- `POST /api/v1/projects/:projectId/workflows/:workflowId/revisions/:revision/validate`
- `POST /api/v1/projects/:projectId/workflows/:workflowId/revisions/:revision/activate`

Start accepts `task`, `checkpoint_policy`, and an optional preloaded
`execution_profile_id`. It never accepts a profile path. Interrupt and cleanup
require `confirm_run_id` to exactly match the selected run. A checkpoint
decision requires its opaque `checkpoint_id`, one of `approve`, `reject`, or `escalate`, and a
non-empty `rationale`. An opaque `decision_id` is optional; the server
generates one when it is omitted. The server
records the actor as `rae-loopback-operator`.

The console never accepts in-place execution, command providers, environment
overrides, raw trace access, forced cleanup, commit, push, or publish controls.
Cleanup delegates to the pipeline's ownership- and dirty-state-validating
worktree cleanup operation. It waits for that operation and returns `200` with
`{ "accepted": true, "run_id": "…", "exit_code": 0 }`; a non-zero exit or the
60-second timeout returns `409` with a scrubbed reason. While a cleanup is in
flight, start in the same project and resume, interrupt or cleanup of that run
return `409`.

Compatibility note: earlier versions answered cleanup with `202` and
`{ "pid": … }` before the operation finished. Clients that polled for completion
or read `pid` must now read `exit_code` from the `200` response instead.

Error messages returned to the browser are scrubbed: project and run workspace
roots (including their `/private` and temporary-directory spellings) and the
home directory are replaced by placeholders, and secret-like tokens are
redacted. Run ids, UUIDs, 40-hex commit SHAs and 64-hex digests stay readable.
Child and engine text is logged server-side without terminal escape sequences or
control characters.

The workflow editor provides synchronized Loop, Graph, Analyze, and JSON views.
It compiles five guided templates to workflow 2.1, exposes keyboard-operable
node and edge controls, analyzes unsaved revisions, and loads validated proposal
jobs into the unsaved editor. Saving a revision and activating its exact digest
remain separate human actions. Workflow 2.0 and experimental 2.2 stay available
through the expert JSON view. Registry mutations are rejected while any
allowlisted project run is active.

Proposal creation is asynchronous. A request accepts only `task`, optional
`base_revision`, and optional `execution_profile_id`; task text is limited to
32 KiB and the in-memory queue holds at most 12 jobs, of which at most four run
a provider at once. Job lookups are scoped to the project and workflow that
created the job. The result is validated
before it is returned to the editor. The proposal endpoint does not save a
revision, activate a digest, or start a run.

Run projections include bounded graph health counts when a projection exists:
availability, validation state, node and edge counts, stale-source count, and
stale-memory and unresolved-conflict counts. The API does not expose raw graph
records, absolute paths, prompts, provider metadata, or untrusted memory text.

Only one process started by a server instance may be active at once. Interrupt
signals that owned process group, records `interrupted` after it exits, and
removes an autonomous lock only when its recorded PID matches the owned child.
POSIX process groups cannot prove termination of a descendant that deliberately
creates a new session, so interrupt responses expose `containment_uncertain`;
inspect the workspace and provider activity before reusing an interrupted run.
A repeated interrupt restarts the SIGTERM (10 s) and SIGKILL (20 s) escalation
for the same process instead of adding a second set of timers. Start returns as
soon as the new run directory is recorded, or reports an early engine exit
within 2 seconds. Start defaults to checkpoints before both mutation and release.

## Verification

```bash
npm --workspace @rae/operator run build
```

## Summary discovery and event replay

`GET /api/v1/projects/:projectId/runs?view=summary` returns identity, workspace
labels, status, phase, timing and a `needs_human_decision` boolean without
gates, attempts, checkpoint identities or graph-health projection. This keeps
human checkpoint holds distinct from workflow timer waits. The default
response remains the full run projection.
Run pages use opaque timestamp-and-ID keyset cursors, with pagination applied
before detail loading. The browser initially loads 100 summaries and offers
further pages without discarding the selected run. Legacy runs whose only start
timestamp is in their trace still read that trace to preserve ordering.

The console loads selected-run details separately. Event pages use physical
JSONL line cursors; incomplete appended lines wait for their newline, malformed
committed lines fail closed, and replacement or rewritten prefixes invalidate
the bounded sanitized cache. The 10,000-event limit still applies to the whole
trace. Cached reads keep the guarded-workspace checks. The browser drains every
historical page before subscribing. Reconnects resume from the last event
cursor, and animation-frame batches append stable rows while
retaining complete history, keyboard focus and expanded details. The static
demo uses the same summary/detail and replay flow.

Run `node scripts/dist/benchmarks/operator.js` (after `npm run build`) for three repetitions of the
100/1,000-run and 1,000/10,000-event workloads. It checks equivalent projections
and reports elapsed milliseconds, RSS changes, bytes read and parse/read counts
using disposable repositories. Timing is diagnostic, not a pass threshold.
