---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: apps/platform
evidence_links: ../reference/claims/claims-ledger.md
---

# Deploy the Experimental Platform

This is a local development procedure, not production deployment guidance. The
checked-in compose file deliberately uses loopback cleartext PostgreSQL and
MinIO ports plus development credentials. Do not publish it, expose it, or
reuse its credentials.

## Prepare configuration

Set `RAE_PLATFORM_CONFIG` to a TOML file. A database URL alone is not enough:
the loader also requires either an `[oidc]` section or, for a local experiment
only, `platform.development = true` with `platform.allowInsecureAuth = true`
(which in turn requires a literal loopback `server.host` and
`server.publicBaseUrl`). Without `platform.allowInsecureHttp`,
`server.publicBaseUrl` must be an `https://` URL, and with `[oidc]` the
`database.url` must use `sslmode=verify-full`. Set `platform.development = true`
before enabling `platform.allowInsecureAuth` or `platform.allowInsecureHttp`.
`apps/platform/dev/platform.hosted.example.toml` is a commented hosted example
(OIDC, HTTPS, verified database TLS, optional storage);
`apps/platform/dev/platform.toml` is the loopback development configuration. The checked-in
Compose file publishes only PostgreSQL and MinIO on loopback. The anonymous
development control process runs on the host and binds its own loopback
interface; it is intentionally not exposed from a container.

For any hosted experiment, omit `allowInsecureAuth` and configure `oidc` with
an exact issuer, audience, JWKS URL, and allowed asymmetric JWS algorithms. Put
the service behind HTTPS. Set `oidc.tokenType` (for example `"at+jwt"`) only if
your issuer emits that JWT `typ` header and you want it enforced; when unset the
`typ` header is not checked, which suits issuers that send `typ: JWT`; tokens
carrying `nonce` or `at_hash` claims (ID tokens) are then rejected. Set
`oidc.audience` to a dedicated API identifier, not an application `client_id`.
If artifacts are needed, configure an S3-compatible bucket, region, optional
endpoint, and optional path-style addressing. The bucket must have object
versioning `Enabled`: verification pins the object version it read, so uploads
to an unversioned or suspended bucket are rejected with `409` and never
quarantined. The development `minio-init` service enables versioning; for any
other bucket enable it yourself (for example `aws s3api put-bucket-versioning
--bucket <name> --versioning-configuration Status=Enabled`).
`npm run control -- doctor` checks `HeadBucket` and `GetBucketVersioning` and
exits non-zero with `artifact bucket versioning is not enabled` otherwise.

## Choose a worker topology

Workers send their bearer token only to a trusted control-plane origin, and the
rule is not configurable. `RAE_PLATFORM_URL` must be a credential-free
`https://` origin without a path whose host is a public DNS name or public IP
literal and resolves only to public, globally routable addresses. Plain `http`
is accepted only for `localhost`, `127.0.0.1` or `::1` with
`RAE_PLATFORM_ALLOW_INSECURE_DEVELOPMENT=true`, and those names must resolve to
loopback addresses.

The worker refuses private, LAN, VPC, CGNAT, link-local and cloud-metadata
addresses, unique-local IPv6, `*.local`, `*.internal` and `*.localhost` names,
and therefore Docker Compose service names and Kubernetes service names. The
check runs before every request against fresh DNS answers and pins the
connection to the checked address, so a configuration or DNS answer pointing at
an internal service cannot receive the worker token (a server-side request
forgery and credential exfiltration guard).

Supported topologies:

- Hosted: the control plane behind a public HTTPS ingress or reverse proxy with
  a public DNS name. Workers anywhere, including inside the same cluster, use
  that public name.
- Local development: the control process on host loopback and the worker on the
  same host with `RAE_PLATFORM_URL=http://127.0.0.1:8080` and
  `RAE_PLATFORM_ALLOW_INSECURE_DEVELOPMENT=true`.

A worker container that reaches the control plane only through a private
network address is not supported.

## Start the local development stack

From `apps/platform/`, review the checked-in development-only
`dev/platform.toml` configuration, set `RAE_DEV_MINIO_ACCESS_KEY` and
`RAE_DEV_MINIO_SECRET_KEY` to disposable local values, then start the
loopback-published dependencies:

```bash
docker compose -f compose.yaml up -d postgres minio minio-init
```

Run migrations and the control process on the host with the checked-in
loopback-only configuration:

```bash
RAE_PLATFORM_CONFIG="$PWD/dev/platform.toml" npm run control -- migrate
RAE_PLATFORM_CONFIG="$PWD/dev/platform.toml" npm run control -- serve
```

The control process never applies migrations automatically. Verify that all
migrations completed before serving work:

```bash
curl http://127.0.0.1:8080/readyz
```

The expected response is `{"status":"ready"}`. `GET /healthz` only proves
that the HTTP process answered. It does not prove schema readiness, OIDC,
object storage, or worker execution.

## Required external evidence

No current repository evidence proves a container deployment, PostgreSQL
integration, OIDC issuer interoperability, S3-compatible upload and
verification, worker execution, or operational recovery. A hosted trial must
record those results separately, including HTTPS termination, secret handling,
database backup and restore, object retention and quarantine handling, and
worker loss recovery.

See [Use the Experimental Hosted API](hosted-api.md) for the route contract.

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
