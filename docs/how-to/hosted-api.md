---
status: experimental
owner: orchestration
last_reviewed: 2026-10-07
source_of_truth: apps/platform/src/http.ts
evidence_links: ../reference/claims/claims-ledger.md
---

# Use the Experimental Hosted API

This API is an experimental control-plane surface. The loopback operator's remote relay uses `/api/v1`; this hosted `/api/v2` API
requires a translation adapter before those surfaces can interoperate. Local
insecure authentication must remain loopback-only.

## Prerequisites

Configure the control process with `RAE_PLATFORM_CONFIG` and apply migrations
before serving. Hosted callers need a bearer token accepted by the configured
OIDC issuer, audience, and signing-algorithm policy. The token must contain an
unexpired `exp`, an `iat`, a subject, the required `rae.*` scope, and an
authorized `projects` or `project_ids` claim. `exp - iat` may not exceed
`auth.maxTokenLifetimeSeconds`, which is at most seven days. Every route except
`GET /healthz` and `GET /readyz` rejects a `Host` header outside the configured
allowlist; the two probes answer before the `Host` check so load balancers and
orchestrators can call them by address.

The control process exposes unauthenticated `GET /healthz` and `GET /readyz`.
Readiness uses a bounded background snapshot and returns `503` when stale or
when migrations are missing. Metrics are available only on the separate
loopback management listener, at `http://127.0.0.1:9090/metrics` by default;
that listener also exposes `/ready`. Management Host and peer checks reject
non-loopback access. `GET /.well-known/oauth-protected-resource` describes the MCP
resource when OIDC is configured.

## Route groups

| Route | Required scope | Notes |
| --- | --- | --- |
| `POST /api/v2/revisions`, activate, or diff | `rae.policy.write` | Uploads, validates, compares, or activates an exact immutable revision. Activation requires `Idempotency-Key`. |
| `POST /api/v2/runs` | `rae.run.submit` | Requires `Idempotency-Key`; the run envelope is limited to 256 KiB. |
| `GET /api/v2/runs/<id>` and `/events` | `rae.run.read` | Reads an authorized run or cursor-paged events; `?stream=true&from=<id>` opens bounded SSE. |
| `POST /api/v2/runs/<id>/cancel` | `rae.run.cancel` | Requires `Idempotency-Key`. |
| `POST /api/v2/runs/<id>/signals` | `rae.run.signal` | Requires `Idempotency-Key`. |
| `POST /api/v2/runs/<id>/rebind` | `rae.run.rebind` | Requires `Idempotency-Key`, an operator decision, matching digests, and a worker registered for the run's project. |
| Worker register, claim, and heartbeat | `rae.work.claim` | Worker subject must equal the supplied stable worker identifier. |
| Worker report, failure, and artifact upload | `rae.work.report` | Reports require the current fenced lease. |
| Artifact download | `rae.run.read` | Available only for authorized projects when storage is configured. |
| `POST /mcp` | Per-tool `rae.run.*` scope | Stateless Streamable HTTP MCP compatibility surface. |

All listed routes are implementation references, not a stability commitment.
The request parser accepts JSON bodies up to 1,050,000 bytes. Mutating run
operations named above enforce `Idempotency-Key`; callers must provide one for
every mutation. Revision upload also computes and verifies the supplied digest.

## Bounded event pages and uploads

REST event reads and MCP event tools/resources return `{events, nextCursor}`.
Pages default to 100 rows, accept at most 1,000 rows, and fit within a 2 MiB
serialized response budget, including the MCP response envelope. Pass the
returned cursor for the next page. Invalid cursors are rejected. An individual
historical event that cannot fit produces an explicit error without advancing
the cursor. Runs accept at most 1,000 nodes.

Node `key`s must be unique within a run; a duplicate is rejected with `400`, and a
conflicting concurrent submission answers `409`.

Nodes are independent, unordered work items: they have no dependencies, all
start queued, and a failed node does not cancel its siblings. The run ends when
every node is terminal and fails if any node failed. Workers claim queued nodes
in a deterministic order: older runs first, then by node `key` (byte-wise); the
claim order is not an execution-order guarantee, because workers run read nodes
concurrently.

Artifact verification atomically claims the reservation and validates its
worker, project, node and active fence before object-storage access. It stops
oversized streams and revalidates authorization before finalization. New uploads
use reservation-specific keys; existing artifacts keep their stored keys.
Apply every checked-in migration explicitly before serving, including the
verification-claim and idempotency-namespace migrations.

## Identifiers and digests

`projectId` and every node `key` in a run submission must match
`[A-Za-z0-9._-]{1,128}`, the pattern workers enforce on claims; anything else
is rejected with `400` at submission (REST and the MCP submit tool).

`revision.digest` in `POST /api/v2/runs` and `digest` in
`POST /api/v2/revisions` are the lowercase hex SHA-256 of the platform's own
canonical JSON of `revision.definition` (or `document`): object keys sorted with
JavaScript's default string sort at every level, no whitespace, and each key
and scalar written by `JSON.stringify`. The implementation is `canonical` and
`digest` in `apps/platform/src/store.ts`; it is not an RFC 8785 library, so
compute the digest with that helper instead of a JCS implementation. After
`npm --prefix apps/platform run build`, from `apps/platform/`:

```bash
node --input-type=module -e 'import fs from "node:fs"; import { digest } from "./dist/src/store.js"; console.log(digest(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))))' definition.json
```

A provider node's `payload.profileDigest` must equal the digest the worker
computes for the execution-profile v2 snapshot named in its project map:
`loadExecutionProfile(path).digest` from `@rae/engine`, the SHA-256 of the
engine's canonical JSON (sorted keys, no whitespace) of the validated profile.
Compute it with the same snapshot file the worker uses, from `apps/platform/`:

```bash
node --input-type=module -e 'import { loadExecutionProfile } from "@rae/engine"; console.log(loadExecutionProfile(process.argv[1]).digest)' /absolute/path/to/profile.json
```

The profile path must be absolute-resolvable without symlinks. A mismatch fails
the claim on the worker with `claim does not match the worker's snapshotted
execution profile`.

## Worker protocol

Register first, then claim work. A worker uses HTTPS, long-polls for up to 25
seconds, sends a heartbeat every `heartbeatSeconds` from the claim (20 by
default), and reports success or failure with the claim's node identifier and
fence value. A heartbeat answered with `409`, `401`, `403` or another client
error aborts the claim at once. Network failures, `5xx`, `408` and `429` are
retried with backoff until the local lease deadline (last successful renewal
plus `leaseSeconds`) passes, which aborts the claim; there is no fixed count of
failed heartbeats. Reporting waits for provider containment.

With `RAE_PLATFORM_UPLOAD_ARTIFACTS=true` the worker uploads each successful
attempt's `output.json` and `events.jsonl` before reporting: reserve, presigned
`PUT` of the exact bytes, then verify. Each outcome is listed in the report's
`artifactUploads` (verified `id`, or a bounded redacted `error`); a failed
upload does not fail the attempt. Without the variable the worker never calls
the artifact routes. See the platform README for the exact rules.

The worker resolves the claim's logical project ID through its private
`RAE_PROJECT_MAP_FILE`, verifies the claim's profile digest against the local
execution-profile v2 snapshot, replaces all filesystem paths locally, and
awaits the engine's sandboxed provider supervisor. The map must be an
owner-only regular file and each root must be a canonical Git top level.

Each provider-node payload must contain `prompt`, `outputSchema`,
`profileDigest`, and a logical `tier`; it may contain a bounded
`timeoutSeconds`. The control plane supplies only the logical project, run,
attempt, and node identities plus read/write access. The worker derives the
workspace root, output paths, Codex model, reasoning effort, credentials, and
MCP allowlist from its local map and matching profile snapshot.

For the deployment boundary, see
[Deploy the Experimental Platform](deploy-experimental-platform.md).

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)

Provider schemas and result paths are staged in a private worker-owned directory
outside every mapped project and temporary-directory write grant. Successful
bounded output and events are published with no-clobber operations into the
attempt directory. Cancellation awaits the owned process-group cleanup; uncertain
containment is an execution failure. The staging directory is removed after the
supervisor finishes, including failure paths.
