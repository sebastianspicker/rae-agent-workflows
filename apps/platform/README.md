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
manual experiments. Hosted use must supply the `oidc` section instead.

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
algorithms. Tokens must carry an unexpired `exp`, a numeric `iat` (or, without
`iat`, an `nbf`) that is at most 60 seconds in the future, a subject, scopes,
and a `projects` or `project_ids` claim. `exp - iat` must not exceed
`auth.maxTokenLifetimeSeconds` (default 86400, maximum 604800). A present
`projects` claim is authoritative even when empty or invalid; `project_ids` is
consulted only when `projects` is absent. The `Bearer` scheme is matched
case-insensitively. When the JWKS endpoint times out, is unreachable, or does
not answer `200`, requests fail with `503` rather than `401`.
With OIDC, `database.url` must use `sslmode=verify-full` unless
`database.allowInsecure = true` is set explicitly.
The worker identifier must equal the OIDC token subject. Artifact reservations
and final verification are bound to that worker's active node and lease fence.

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
is replaced by a minimal failure report with code `result_rejected`. Heartbeat
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
events. It is implemented with the MCP SDK's stateless Streamable HTTP
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
