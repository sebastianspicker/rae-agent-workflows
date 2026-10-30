# Experimental hosted platform

This package is an experimental RAE hosted control-plane vertical slice. The
package is not a production deployment. Its `/api/v2` and `/mcp` surfaces
are not connected to the loopback operator, whose remote relay allows only the
operator `/api/v1` contract.

It owns PostgreSQL control-plane state, OIDC-protected REST endpoints, fenced
worker leases, S3-compatible artifact storage, and a narrow Streamable HTTP MCP
surface. It has a separate lockfile and is not part of the root npm workspace.
From the repository root:

```bash
npm ci --prefix apps/platform --ignore-scripts
npm run build
npm --prefix apps/platform run build
```

Control commands are `migrate`, `doctor`, and `serve`. Worker commands are
`doctor` and `run`. Both require the environment described below: a TOML file
named by `RAE_PLATFORM_CONFIG` and, for every command, a reachable PostgreSQL
database. `doctor` and `serve` also require migrated tables, so run `migrate`
first. The development stack below shows the complete order.

An intentionally local-only insecure configuration is useful for unit and
manual experiments. Hosted use must supply the `oidc` section instead; see the
commented `dev/platform.hosted.example.toml`.

```toml
[server]
host = "127.0.0.1"
port = 8080
publicBaseUrl = "http://127.0.0.1:8080"

[database]
url = "postgres://rae:rae-dev-only@127.0.0.1:5432/rae_platform"
# Milliseconds for the connection's statement_timeout; 0 omits it (PgBouncer, RDS Proxy).
# statementTimeoutMs = 30000

[platform]
development = true
allowInsecureAuth = true
allowInsecureHttp = true
# Lease duration and worker heartbeat interval in seconds (defaults shown).
# heartbeatSeconds must be less than half of leaseSeconds.
leaseSeconds = 60
heartbeatSeconds = 20

[storage]
bucket = "rae-artifacts"
region = "us-east-1"
endpoint = "http://127.0.0.1:9000"
forcePathStyle = true
```

For hosted use, remove `allowInsecureAuth`, bind the service behind HTTPS, and
configure an exact issuer, audience, JWKS URL, and allowed asymmetric JWS
algorithms. The JWT `typ` header is not constrained unless `oidc.tokenType` is
set (for example `tokenType = "at+jwt"` for RFC 9068 access tokens); leave it
unset for issuers such as Keycloak, Auth0 and Azure AD that send `typ: JWT`.
`oidc.audience` must be a dedicated API identifier (resource indicator), not an
application `client_id`: ID tokens are issued to the client_id and would
otherwise be accepted. When `tokenType` is unset, tokens carrying `nonce` or
`at_hash` claims (ID-token markers) are rejected; set `tokenType` when your
issuer marks access tokens with a distinct `typ`.
Issuer, audience, algorithms and expiry are always enforced. Tokens must carry an unexpired `exp`, a numeric `iat` (or, without
`iat`, an `nbf`) that is at most 60 seconds in the future, a subject, scopes,
and a `projects` or `project_ids` claim. `exp - iat` must not exceed
`auth.maxTokenLifetimeSeconds` (default 86400, maximum 604800). A present
`projects` claim is authoritative even when empty or invalid; `project_ids` is
consulted only when `projects` is absent. The `Bearer` scheme is matched
case-insensitively. When the JWKS endpoint times out, is unreachable, or does
not answer `200`, requests fail with `503` rather than `401`.
A rejected token logs one `bearer token rejected` line with the jose error
`code` (and the failing claim name where there is one), never the token; the
`401` body stays `invalid bearer token`.
With OIDC, `database.url` must use `sslmode=verify-full` unless
`database.allowInsecure = true` is set explicitly.
The worker identifier must equal the OIDC token subject. Artifact reservations
and final verification are bound to that worker's active node and lease fence.

The `[storage]` bucket must have S3 object versioning `Enabled`. Verification
pins the object version it read and quarantines a mismatched upload by copying
that exact version; an upload without a version ID is rejected with `409` and
nothing is quarantined. `rae-platform doctor` runs `HeadBucket` and
`GetBucketVersioning` and fails with `artifact bucket versioning is not enabled`
unless the status is `Enabled`. Only the development `minio-init` service
enables versioning for you; enable it yourself on any other bucket (for
example `aws s3api put-bucket-versioning --bucket <name>
--versioning-configuration Status=Enabled`).

Every route except `/healthz` and `/readyz` is checked against the Host
allowlist (`server.host` and the host of `server.publicBaseUrl`). With
`allowInsecureAuth = true` that allowlist must be non-empty and loopback-only,
or the control process refuses to start.

### Worker environment

- `RAE_PLATFORM_URL`: control-plane base URL (an HTTPS origin with no path).
- `RAE_PLATFORM_ALLOW_INSECURE_DEVELOPMENT=true`: permits plain `http` to a
  loopback control plane; otherwise HTTPS to a public address is required.
- `RAE_PLATFORM_TOKEN`: bearer token, read once at start-up. It needs an
  unexpired `exp` and an `iat` (or `nbf`) with `exp - iat` at most
  `auth.maxTokenLifetimeSeconds` (default 86400), so it must outlive the
  worker run but not exceed that bound.
- `RAE_WORKER_ID`: must equal the token subject. With
  `allowInsecureAuth = true` the fixed principal is `local-experiment`, so use
  that value.
- `RAE_REPOSITORY_DIGEST` and `RAE_WORKTREE_DIGEST`: exactly 64 hex characters
  (a sha256), not a 40-character git SHA.
- `RAE_PROJECT_MAP_FILE`: see below.
- `RAE_PLATFORM_UPLOAD_ARTIFACTS=true`: upload each successful attempt's
  published artifacts (`output.json`, `events.jsonl`, at most 20 MiB each) to
  the control plane's object storage. Off by default, which keeps the worker
  from calling the artifact routes at all; enable it only when the control
  plane has `[storage]` configured.

With `RAE_PLATFORM_UPLOAD_ARTIFACTS=true`, after a successful execution and
before its report the worker, for each published artifact, computes its SHA-256
and size, calls `POST /api/v2/artifacts/reserve` (idempotency key
`artifact:<attemptId>:<fence>:<name>`) through its pinned control-plane client,
PUTs exactly those bytes with `Content-Length` and `Content-Type` and no
credentials to the returned presigned URL, then calls
`POST /api/v2/artifacts/verify`. The presigned URL must be HTTPS (loopback HTTP
only with `RAE_PLATFORM_ALLOW_INSECURE_DEVELOPMENT=true`); redirects are
refused, each PUT and verify times out after 120 seconds, transient reserve and
verify failures are retried at most four times, and the claim's lease signal
aborts all of it while heartbeats keep running. The success report gains
`artifactUploads`: one entry per artifact with `name`, `sha256`, `sizeBytes`
and either `id` with `state: "verified"` or a bounded, redacted `error` (for
example `verification rejected (409): ...` or `control plane has no artifact
storage configured (404)`, after which that attempt's remaining artifacts are
skipped). Upload failures never turn a successful execution into a failure, and
neither the presigned URL nor its signature is logged or reported. If the lease
is lost during uploads, the claim is abandoned without a report.

#### Worker control-plane endpoint rules

The worker sends its bearer token only to a control plane it can trust, so it
checks `RAE_PLATFORM_URL` at start-up and again before every request:

- Accepted: an `https://` origin with no user name, password, path, query or
  fragment whose host is a public DNS name (not `localhost`, `*.localhost`,
  `*.local` or `*.internal`) or a public IP literal, and whose DNS answers are
  all public (globally routable) addresses. The connection is pinned to the
  first checked address, TLS verifies the host name, and redirects are refused.
- Accepted for development only: `http://` or `https://` to `localhost`,
  `127.0.0.1` or `::1` with `RAE_PLATFORM_ALLOW_INSECURE_DEVELOPMENT=true`;
  every resolved address must then be loopback.
- Refused: any other plain `http` URL, credentials in the URL, and any host
  that is or resolves to a private, LAN, VPC, CGNAT (`100.64.0.0/10`),
  link-local or cloud-metadata (`169.254.169.254`), loopback (outside the
  development mode), unique-local IPv6, documentation or multicast address.
  This includes Docker Compose service names and Kubernetes `*.svc` names,
  which resolve to private addresses.

The rule applies to the control-plane origin: a worker configuration or DNS
answer that points at an internal service must not receive the worker token or
act as a probe of the private network. It is not configurable. Artifact upload
URLs come from the authenticated control plane and may point at private object
storage (for example self-hosted MinIO); the worker resolves the upload host
once and pins the connection to that address. Upload failures are reported to
the control plane only as `upload failed` or `upload aborted`; the detail
(storage status, connect error) is logged locally. Supported topologies are a control plane behind a public HTTPS
ingress or reverse proxy with a public DNS name (workers may run anywhere that
reaches it), and the loopback development setup with the worker on the same
host as the control process. A worker inside the same Compose network or
Kubernetes cluster must still use the public HTTPS name.

`rae-platform-worker doctor` reports one problem per failed check and exits
non-zero: unset variables, digests that are not 64 lowercase hex characters, a
token that is empty or contains whitespace (never printed), and a control plane
that is untrusted under the worker's endpoint rules or does not answer `200`
to an unauthenticated `GET /healthz` within 5 seconds. A failed worker
registration includes the control plane's status, error code and a bounded,
redacted message.

`platform.leaseSeconds` sets the lease duration and
`platform.heartbeatSeconds` the heartbeat interval handed to workers in each
claim; `platform.heartbeatSeconds` must be below half of
`platform.leaseSeconds`. Defaults are 60
and 20. Workers never extend the server's lease locally and lower an
out-of-bounds heartbeat so it fits at least twice into the lease.

The worker maps every response with one table for registration, claims,
heartbeats and reports: `401`/`403` end the worker; `5xx`, `408`, `429` and
network failures are retried with capped exponential backoff and jitter (the
first delay is 0.5 to 1 second, the cap 30 seconds) and never end it; a claim `409` with `code: "worker_unregistered"`
registers again, and any other claim `409` backs off. The worker keeps a local
lease deadline (`last renewal + leaseSeconds`). A heartbeat `409`, `401` or
`403`, or a passed deadline, aborts the claim immediately; transient heartbeat
failures are retried until the deadline. A finished result is still reported
when the abort came from shutdown but the deadline has not passed: the
shutdown signal only stops registration, claims, heartbeats and execution,
never a result report. The deadline starts when the claim request is sent. A
`200` reply that is not valid JSON or fails schema validation is treated as a
transient failure; only a valid claim response resets claim retry backoff.
A result the control plane rejects with `400` or `413`
is replaced by a minimal failure report with code `result_rejected`. When the
executor throws, the worker logs the error and stack locally and reports only
the first line of the message, at most 500 characters, with tokens, absolute
paths (including `file://` URLs and UNC paths), `key=value` secrets and long
secret-like strings scrubbed (`worker execution failed` if nothing usable
remains). Failure messages are visible to everyone who can read the run, so
executors should not put sensitive data in error messages. Heartbeat
requests time out after `heartbeatSeconds`. `rae-platform-worker run` aborts
its poll, heartbeat and execution on `SIGTERM` or `SIGINT`.

Workers require `RAE_PROJECT_MAP_FILE` to name an owner-only TOML file mapping
each logical project ID to a canonical local Git root and a snapshotted
execution-profile v2 file. See `dev/projects.toml.example`. Absolute roots and
profile paths stay on the worker and are never reported to the control plane.
Each entry's optional `writeNodes` lists the node keys this worker accepts
write claims for; every other node is read-only, and a write claim for it is
refused and reported as a failure. The execution-profile v2 contract has no
write field, so this policy lives in the worker's project map.
Integration tests are intentionally skipped unless
`RAE_PLATFORM_DATABASE_URL` is configured.

Worker claims wait through a shared PostgreSQL notification listener. Each
claim probe opens a short transaction and releases every row and advisory lock
before waiting. Run creation and expired-lease reconciliation wake waiters;
the worker retries for at most 25 seconds. A successful claim is persisted
with its idempotency key in the claiming transaction; empty results are never
persisted, so a retried key can still claim newly queued work. Claims from
both stores include `workerId` and an ISO `expiresAt`. A dropped notification
connection is discarded and re-established before the worker waits again.
Expiry cleanup uses bounded, skip-locked batches, both in each claim probe and
in the periodic reconciler, so a locked expired lease cannot stall unrelated
claims. The reconciler runs every `leaseSeconds / 2` seconds, bounded to
between 1 and 30 seconds, and also deletes `claim` and `report` idempotency
rows older than 24 hours, oldest first; a pruning failure is logged and does
not stop lease reconciliation. Store shutdown cancels pending claim
waiters and waits for an in-flight notification connection before releasing
its client, so no poll retries against an ended pool.

The PostgreSQL pool uses at most 20 connections, closes idle clients after 30
seconds, sets a 30-second `statement_timeout` (migrations lift it), and logs
idle client errors instead of crashing. The timeout is sent as the
`-c statement_timeout` connection startup option, which PgBouncer and RDS Proxy
reject; behind either of them set `database.statementTimeoutMs = 0` to omit the
option (and configure the timeout on the server or role instead), or change
the value in milliseconds. A failed `ROLLBACK` discards the
client. The management metrics include the pool's total, idle and waiting
client counts and the number of active event streams.

A node gets at most 3 claim attempts (`MAX_NODE_ATTEMPTS`). When a lease
expires on a node that has used them all, reclaim fails the node with the
result `{message: "attempts exhausted", code: "attempts_exhausted"}`, appends
`node.failed`, and settles the run like any failed node instead of requeueing
it; earlier expiries requeue the node. Reclaim locks the run with `SKIP
LOCKED`, so a run busy with a report is reclaimed on the next probe.

`projectId` and node `key`s must match `[A-Za-z0-9._-]{1,128}`, the pattern
workers enforce on claims (`400` at submission otherwise). How to compute the
revision `digest` and a node's `profileDigest` is described in
[the hosted API guide](../../docs/how-to/hosted-api.md#identifiers-and-digests).
Node `key`s must be unique within a run (`400` otherwise, in both stores and
the MCP submit tool); a PostgreSQL unique violation from a racing submission
answers `409`. Nodes are independent, unordered work items: no dependencies, all queued at
once, and a failed node does not cancel its siblings. Claims are deterministic:
older runs first, then node `key` byte-wise, in both stores. This is not an
execution-order guarantee.

Node reports lock the owning run and commit the fenced attempt, node state,
immutable event, and outbox record together. The run becomes terminal only
after every node is terminal. Any failed node makes the run failed; otherwise
it succeeds. Cancellation uses the same run lock and cannot be overwritten by
a concurrent report. Event streams read bounded pages after their cursor,
honor response backpressure, stop on disconnect, and drain committed terminal
events before closing. The non-streaming event response returns
`{events, nextCursor}`, paged at 100 events by default (maximum 1000); follow
`nextCursor` for further pages. Graceful control-process shutdown aborts tracked event streams
before waiting for connections and force-closes remaining sockets after a
bounded grace period.

`POST /api/v2/runs` accepts an `Idempotency-Key`; the control plane commits the
revision, run, queued nodes, event, and outbox record in one PostgreSQL
transaction. Each key is stored with a digest of its request: a retry with the
same key and request replays the reply, while the same key with a different
request returns `422` (`code: "idempotency_key_reused"`). Worker registration
and artifact reservations honour their keys too; a reservation is deduplicated
on `(workerId, nodeId, fence, key)`. Worker claim and heartbeat routes require
`rae.work.claim`, worker reports require `rae.work.report`, run reads require
`rae.run.read`, run creation requires `rae.run.submit`, signals require
`rae.run.signal` and an active run, and `POST /api/v2/runs/{id}/rebind`
requires `rae.run.rebind`. Rebind is rejected with `409` while the run is
terminal or has an unexpired lease. The action scope is checked before the run
is read; path identifiers must be UUIDs (`400` otherwise), and runs in projects
the caller cannot access return `404`, as do artifacts, revision diffs and MCP
runs in such projects. Rebind answers an unknown worker, a worker of another
project and a digest mismatch with one identical `409`. Signals reply with the
appended event (`id`, `type`, `payload`, `traceparent`, `createdAt`) and rebind
with `{runId, workerId}`, in both stores. Event streams are capped at 256 globally
and 8 per token subject (`503` above the cap) and send a `: ping` comment after
15 idle seconds. `/mcp` is a
allowlisted JSON-RPC MCP compatibility endpoint exposing run data and immutable
events. MCP tool and resource (`rae-run`, `rae-events`) failures follow REST:
client errors (status below 500, validation) keep their message, and any other
failure returns `internal error` while the real error is logged server-side. It is implemented with the MCP SDK's stateless Streamable HTTP
transport and publishes OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource`. The operator's separate remote mode
can relay a compatible hosted operator service without exposing its upstream
token to browser code, but it cannot relay this platform API without a version
translation adapter.

The documented HTTP surface begins at `/api/v2`. All mutations require an
`Idempotency-Key`; scopes are `rae.*`. Run envelopes are limited to 256 KiB.
Change to `apps/platform` for the following development commands.
For an isolated cleartext development stack, review `dev/platform.toml` and set
`RAE_DEV_MINIO_ACCESS_KEY` and `RAE_DEV_MINIO_SECRET_KEY` to disposable local
values. Start only the loopback-published dependencies with `docker compose -f
compose.yaml up -d postgres minio minio-init`, then export the configuration
and the same MinIO credentials for the host-run control process. Its S3 client
uses the default AWS credential chain, so artifact operations fail unless
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set. Run the migration,
diagnostics and control process on the host so its anonymous development
surface remains bound to the host loopback interface:

```bash
export RAE_DEV_MINIO_ACCESS_KEY=<disposable-access-key>
export RAE_DEV_MINIO_SECRET_KEY=<disposable-secret-key>
docker compose -f compose.yaml up -d postgres minio minio-init
export RAE_PLATFORM_CONFIG="$PWD/dev/platform.toml"
export AWS_ACCESS_KEY_ID="$RAE_DEV_MINIO_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$RAE_DEV_MINIO_SECRET_KEY"
npm run control -- migrate
npm run control -- doctor
npm run control -- serve
```

`curl http://127.0.0.1:8080/readyz` must then return `ready`.
Production deployments require HTTPS and must not use this development compose
file or its development credentials.

`npm run build` compiles only `src` and `bin`, so the container image ships
`dist/src` and `dist/bin` without tests; `npm test` compiles
`tsconfig.test.json` first. `src/attempt-runtime.ts` and
`src/hosted-staging.ts` import `@rae/fs-bridge` directly for descriptor-relative
filesystem access. That is the only allowed exception to the engine-facade
rule, and `test/engine-boundary.test.ts` rejects any other `@rae/*` import.

See the [platform architecture
reference](../../docs/reference/architecture/experimental-hosted-platform.md),
and [local deployment experiment](../../docs/how-to/deploy-experimental-platform.md).
