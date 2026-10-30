/** Purpose: execute the worker polling protocol with fenced, locally deadlined leases. */
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createLogger, redactText } from "./observability.js";

async function readResponseBytes(response: WorkerResponse, limit = 1024 * 1024): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new Error("control-plane response exceeds the worker limit");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("control-plane response exceeds the worker limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function normalizedHost(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4Number(address: string) {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4Prefix(base: string, prefixLength: number) {
  const shift = 32 - prefixLength;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << shift) >>> 0;
  return { network: (ipv4Number(base) & mask) >>> 0, mask };
}

const NON_GLOBAL_IPV4_PREFIXES = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] satisfies [string, number][]
).map(([base, prefixLength]) => ipv4Prefix(base, prefixLength));

function privateIpv4(address: string) {
  const value = ipv4Number(address);
  return NON_GLOBAL_IPV4_PREFIXES.some(({ network, mask }) => (value & mask) >>> 0 === network);
}

function ipv6Words(address: string) {
  let value = address.toLowerCase().split("%", 1)[0];
  const dottedTail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dottedTail) {
    const ipv4 = ipv4Number(dottedTail[1]);
    value = `${value.slice(0, -dottedTail[1].length)}${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array(zeroCount).fill("0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
}

function ipv6Prefix(base: string, prefixLength: number) {
  return { words: ipv6Words(base), prefixLength };
}

const NON_GLOBAL_IPV6_PREFIXES = (
  [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] satisfies [string, number][]
).map(([base, prefixLength]) => ipv6Prefix(base, prefixLength));

function hasIpv6Prefix(words: number[], prefix: { words: number[]; prefixLength: number }) {
  const wholeWords = Math.floor(prefix.prefixLength / 16);
  const remainder = prefix.prefixLength % 16;
  for (let index = 0; index < wholeWords; index += 1) {
    if (words[index] !== prefix.words[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xffff << (16 - remainder)) & 0xffff;
  return (words[wholeWords] & mask) === (prefix.words[wholeWords] & mask);
}

function privateIpv6(address: string) {
  const words = ipv6Words(address);
  return NON_GLOBAL_IPV6_PREFIXES.some((prefix) => hasIpv6Prefix(words, prefix));
}

function publicAddress(address: string) {
  if (net.isIPv4(address)) return !privateIpv4(address);
  if (net.isIPv6(address)) return !privateIpv6(address);
  return false;
}

function localDevelopmentHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function loopbackAddress(address: string) {
  return net.isIPv4(address) ? address.startsWith("127.") : address === "::1";
}

function publicDnsName(host: string) {
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

function endpointRelativeUrl(endpoint: URL, path: string) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new Error("worker control-plane paths must be endpoint-relative");
  }
  const target = new URL(path, endpoint.origin);
  if (target.origin !== endpoint.origin || target.username || target.password) {
    throw new Error("worker control-plane paths must not change origin or authority");
  }
  return target;
}

function validEndpointShape(endpoint: URL, localDevelopment: boolean) {
  const validProtocol =
    endpoint.protocol === "https:" || (localDevelopment && endpoint.protocol === "http:");
  return (
    validProtocol &&
    !endpoint.username &&
    !endpoint.password &&
    endpoint.pathname === "/" &&
    !endpoint.search &&
    !endpoint.hash
  );
}

function firstConnection(addresses: Address[]) {
  const address = addresses[0].address;
  return { address, family: net.isIP(address) };
}

function assertTrustedAddresses(host: string, addresses: Address[], localDevelopment: boolean) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("worker control-plane origin must resolve only to public addresses");
  }
  if (localDevelopment) {
    if (addresses.some(({ address }) => !loopbackAddress(address))) {
      throw new Error(
        "development worker control-plane origin must resolve only to loopback addresses",
      );
    }
    return firstConnection(addresses);
  }
  const invalidLiteral = net.isIP(host) && !publicAddress(host);
  const invalidResolution = addresses.some(({ address }) => !publicAddress(address));
  if (!publicDnsName(host) || invalidLiteral || invalidResolution) {
    throw new Error("worker control-plane origin must resolve only to public addresses");
  }
  return firstConnection(addresses);
}

async function assertTrustedEndpoint(
  endpoint: URL,
  { allowInsecureDevelopment, resolveHostname }: EndpointPolicy,
) {
  const host = normalizedHost(endpoint).replace(/\.$/, "");
  const localDevelopment = allowInsecureDevelopment && localDevelopmentHost(host);
  if (!validEndpointShape(endpoint, localDevelopment)) {
    throw new Error(
      "workers require a credential-free HTTPS control-plane origin; development HTTP is loopback-only",
    );
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await resolveHostname(host);
  return assertTrustedAddresses(host, addresses, localDevelopment);
}

const defaultResolveHostname = (host: string) => lookup(host, { all: true, verbatim: true });

function pinnedLookup({ address, family }: Connection): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function responseHeaders(headers: http.IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const part of Array.isArray(value) ? value : [value]) {
      if (part !== undefined) result.append(name, String(part));
    }
  }
  return result;
}

function pinnedRequest(
  target: URL,
  options: RequestOptions,
  connection: Connection,
): Promise<WorkerResponse> {
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        lookup: pinnedLookup(connection),
        ...(target.protocol === "https:" && !net.isIP(normalizedHost(target))
          ? { servername: normalizedHost(target) }
          : {}),
      },
      (response) => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
          response.destroy();
          reject(new Error("worker control-plane redirects are forbidden"));
          return;
        }
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          headers: responseHeaders(response.headers),
          body: response,
        });
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

/** Builds an origin-locked worker request function after validating the endpoint at construction and use. */
export async function createWorkerRequest({
  baseUrl,
  token,
  allowInsecureDevelopment = false,
  resolveHostname = defaultResolveHostname,
  fetchImpl = null,
}: WorkerRequestOptions) {
  const endpoint = new URL(baseUrl);
  await assertTrustedEndpoint(endpoint, { allowInsecureDevelopment, resolveHostname });
  return async (
    path: string,
    requestBody: unknown,
    idempotencyKey: string,
    { timeoutMs = REQUEST_TIMEOUT_MS, signal: requestSignal }: RequestCallOptions = {},
  ) => {
    const target = endpointRelativeUrl(endpoint, path);
    const connection = await assertTrustedEndpoint(endpoint, {
      allowInsecureDevelopment,
      resolveHostname,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // Only the caller's per-request signal joins the timeout; a worker-level shutdown signal must
    // not cancel a result report that is already in flight.
    const signals = [controller.signal, requestSignal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    try {
      const options: RequestOptions = {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        redirect: "error",
        body: JSON.stringify(requestBody),
        signal: AbortSignal.any(signals),
      };
      const response = fetchImpl
        ? await fetchImpl(target, options)
        : await pinnedRequest(target, options, connection);
      const bytes = await readResponseBytes(response);
      return {
        ...response,
        body: (async function* () {
          yield bytes;
        })(),
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  };
}

/** Digest format the worker sends: a lowercase sha256 in hex (the server only checks the length of 64). */
export const WORKER_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DOCTOR_PROBE_TIMEOUT_MS = 5_000;

/** Validates worker environment variables and probes `/healthz` through the worker's endpoint-trust checks; the token is never sent or printed. */
export async function doctorWorkerEnvironment(
  env: Record<string, string | undefined>,
  {
    resolveHostname = (host: string) => lookup(host, { all: true, verbatim: true }),
    fetchImpl = null,
    timeoutMs = DOCTOR_PROBE_TIMEOUT_MS,
  }: Pick<WorkerRequestOptions, "resolveHostname" | "fetchImpl"> & { timeoutMs?: number } = {},
) {
  const required = [
    "RAE_PLATFORM_URL",
    "RAE_PLATFORM_TOKEN",
    "RAE_WORKER_ID",
    "RAE_REPOSITORY_DIGEST",
    "RAE_WORKTREE_DIGEST",
    "RAE_PROJECT_MAP_FILE",
  ];
  const missing = required.filter((name) => !env[name]);
  const problems = missing.map((name) => `${name} is not set`);
  for (const name of ["RAE_REPOSITORY_DIGEST", "RAE_WORKTREE_DIGEST"]) {
    const value = env[name];
    if (value && !WORKER_DIGEST_PATTERN.test(value))
      problems.push(`${name} must be exactly 64 lowercase hex characters (a sha256)`);
  }
  const token = env.RAE_PLATFORM_TOKEN;
  if (token && /\s/.test(token)) problems.push("RAE_PLATFORM_TOKEN must not contain whitespace");
  const baseUrl = env.RAE_PLATFORM_URL;
  if (baseUrl) {
    try {
      const endpoint = new URL(baseUrl);
      const allowInsecureDevelopment = env.RAE_PLATFORM_ALLOW_INSECURE_DEVELOPMENT === "true";
      const connection = await assertTrustedEndpoint(endpoint, {
        allowInsecureDevelopment,
        resolveHostname,
      });
      const target = endpointRelativeUrl(endpoint, "/healthz");
      const options: RequestOptions = {
        method: "GET",
        headers: {},
        redirect: "error",
        body: "",
        signal: AbortSignal.timeout(timeoutMs),
      };
      const response = fetchImpl
        ? await fetchImpl(target, options)
        : await pinnedRequest(target, options, connection);
      await readResponseBytes(response);
      if (!response.ok)
        problems.push(`control plane /healthz answered ${response.status}, expected 200`);
    } catch (error) {
      problems.push(
        `control plane is not usable: ${redactText(causeMessage(error)).slice(0, 500)}`,
      );
    }
  }
  return { missing, problems };
}

const REPORT_PATH = "/api/v2/workers/report";
const FAILURE_PATH = "/api/v2/workers/failure";
const RESERVE_PATH = "/api/v2/artifacts/reserve";
const VERIFY_PATH = "/api/v2/artifacts/verify";
const ARTIFACT_TIMEOUT_MS = 120_000;
const ARTIFACT_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
const IDLE_POLL_MS = 1000;
const MAX_LEASE_SECONDS = 3600;
const MAX_HEARTBEAT_SECONDS = 1800;

type StatusClass = "ok" | "auth" | "conflict" | "transient" | "client";
type WorkerAction = "continue" | "exit" | "retry" | "backoff" | "reregister" | "abort" | "abandon";
type WorkerOperation = "register" | "claim" | "heartbeat" | "report";

/** One table maps each control-plane status class to the worker's action per operation. */
export const STATUS_ACTIONS = Object.freeze({
  register: { ok: "continue", auth: "exit", conflict: "exit", transient: "retry", client: "exit" },
  claim: { ok: "continue", auth: "exit", conflict: "backoff", transient: "retry", client: "exit" },
  heartbeat: {
    ok: "continue",
    auth: "exit",
    conflict: "abort",
    transient: "retry",
    client: "abort",
  },
  report: {
    ok: "continue",
    auth: "exit",
    conflict: "abandon",
    transient: "retry",
    client: "abandon",
  },
} satisfies Record<WorkerOperation, Record<StatusClass, WorkerAction>>);

/** Network failures (null), 5xx, 408 and 429 are transient; the worker never exits on them. */
function statusClass(status: number | null): StatusClass {
  if (status === null || status >= 500 || status === 408 || status === 429) return "transient";
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  return status === 409 ? "conflict" : "client";
}

export function workerAction(
  operation: WorkerOperation,
  status: number | null,
  code?: string,
): WorkerAction {
  const action = STATUS_ACTIONS[operation][statusClass(status)];
  return operation === "claim" && action === "backoff" && code === WORKER_UNREGISTERED
    ? "reregister"
    : action;
}

/** Capped exponential backoff with jitter: attempt n waits within [cap/2, cap) of min(30 s, 2^n s). */
export function retryDelayMs(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/** Bounds server-provided lease timing so heartbeats always fit at least twice into a lease. */
export function workerLeaseTiming(leaseSeconds: number, heartbeatSeconds: number) {
  // The lease is never extended locally beyond what the server granted.
  const lease = Math.min(leaseSeconds, MAX_LEASE_SECONDS);
  const heartbeat = Math.max(
    1,
    Math.min(heartbeatSeconds, MAX_HEARTBEAT_SECONDS, Math.ceil(lease / 2) - 1),
  );
  return { leaseSeconds: lease, heartbeatSeconds: heartbeat };
}

function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Resolves when the promise settles or the signal aborts, whichever happens first. */
function untilAborted(promise: Promise<unknown>, signal: AbortSignal | null): Promise<void> {
  if (!signal)
    return promise.then(
      () => undefined,
      () => undefined,
    );
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    promise.then(done, done);
  });
}

function causeMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** A short, bounded reason sent with the minimal failure report after a rejected result. */
function rejectionSummary(status: number | null, body: unknown) {
  const reason =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? `: ${body.error}`
      : "";
  return `result rejected by the control plane (${status})${reason}`.slice(0, 500);
}

const FAILURE_MESSAGE_LIMIT = 500;

/** The first line of an executor error with tokens, absolute paths and long secrets scrubbed, bounded for the report. */
function executionFailureMessage(error: unknown) {
  const line = error instanceof Error ? (error.message.split(/\r?\n/, 1)[0] ?? "") : "";
  const scrubbed = redactText(line)
    .replace(/(?<![\w.:/-])(?:[A-Za-z]:\\|~\/|\/)[^\s"'`),;]+/g, "[path]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .trim();
  return scrubbed.slice(0, FAILURE_MESSAGE_LIMIT) || "worker execution failed";
}

/** A bounded, redacted `code: error` reason taken from a control-plane error body. */
function responseReason(body: unknown) {
  if (!body || typeof body !== "object") return "";
  const { code, error } = body as { code?: unknown; error?: unknown };
  const parts = [code, error].filter((part): part is string => typeof part === "string" && !!part);
  return redactText(parts.join(": ")).replace(/\s+/g, " ").slice(0, 500);
}

function withReason(prefix: string, body: unknown) {
  const reason = responseReason(body);
  return reason ? `${prefix}: ${reason}` : prefix;
}

function responseCode(body: unknown) {
  return body && typeof body === "object" && "code" in body && typeof body.code === "string"
    ? body.code
    : undefined;
}

/** A bounded, redacted reason recorded in the attempt report for a failed artifact upload. */
function artifactFailure(text: string) {
  return redactText(text).replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_LIMIT);
}

/**
 * PUTs bytes to a presigned storage URL without credentials or redirects. Only HTTPS is accepted,
 * plus loopback HTTP in development; errors never include the URL, whose query carries the signature.
 * The host is resolved once and the connection pinned to that address; private storage is allowed.
 */
async function putPresigned(
  uploadUrl: string,
  { bytes, contentType }: ClaimArtifact,
  allowInsecureDevelopment: boolean,
  signal: AbortSignal,
  resolveHostname: EndpointPolicy["resolveHostname"],
): Promise<void> {
  let target: URL;
  try {
    target = new URL(uploadUrl);
  } catch {
    throw new Error("artifact upload URL is invalid");
  }
  const developmentHttp =
    allowInsecureDevelopment &&
    target.protocol === "http:" &&
    localDevelopmentHost(normalizedHost(target));
  if ((target.protocol !== "https:" && !developmentHttp) || target.username || target.password)
    throw new Error(
      "artifact upload URL must be a credential-free HTTPS URL (loopback HTTP in development)",
    );
  const host = normalizedHost(target).replace(/\.$/, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await resolveHostname(host);
  if (!Array.isArray(addresses) || addresses.length === 0)
    throw new Error("artifact upload host did not resolve");
  const connection = firstConnection(addresses);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "PUT",
        lookup: pinnedLookup(connection),
        ...(target.protocol === "https:" && !net.isIP(host) ? { servername: host } : {}),
        // The presigned URL signs Content-Length; the checksum travels in its query.
        headers: { "content-length": String(bytes.length), "content-type": contentType },
        signal: AbortSignal.any([signal, AbortSignal.timeout(ARTIFACT_TIMEOUT_MS)]),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error("storage redirects are forbidden"));
        } else if (status < 200 || status >= 300) reject(new Error(`storage answered ${status}`));
        else response.once("end", () => resolve()).once("error", reject);
      },
    );
    request.once("error", (error) =>
      reject(new Error(error.name === "AbortError" ? "upload aborted" : error.message)),
    );
    request.end(bytes);
  });
}

/**
 * Polls for work until aborted. Every status follows STATUS_ACTIONS: 401/403 end the worker,
 * 5xx and network failures are retried with capped jittered backoff, an unregistered-worker 409
 * re-registers, and other claim 409s back off. A heartbeat 409/401/403 or a passed local lease
 * deadline abandons the claim immediately; the lease reconciler re-queues unreported nodes.
 */
export async function runWorker({
  baseUrl,
  token,
  workerId,
  repositoryDigest,
  worktreeDigest,
  execute,
  allowInsecureDevelopment = false,
  resolveHostname,
  signal = null,
  sleep = abortableSleep,
  logger = createLogger({ service: "rae-platform-worker" }),
  fetchImpl = null,
  now = () => Date.now(),
  random = Math.random,
  uploadArtifacts = false,
}: RunWorkerOptions) {
  const request = await createWorkerRequest({
    baseUrl,
    token,
    allowInsecureDevelopment,
    ...(resolveHostname ? { resolveHostname } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  // Register and claim stop on shutdown; heartbeats use the claim's signal and reports neither.
  const shutdown: RequestCallOptions = signal ? { signal } : {};
  const pause = (ms: number, cancel: AbortSignal | null = signal) =>
    untilAborted(sleep(ms, cancel ?? undefined), cancel);
  const call = async (
    path: string,
    body: unknown,
    key: string,
    options?: RequestCallOptions,
  ): Promise<{ status: number | null; body: unknown }> => {
    try {
      const response = await request(path, body, key, options);
      let parsed: unknown = null;
      try {
        parsed = await readJsonBounded(response);
      } catch (error) {
        if (response.ok) {
          logger("warn", "control-plane response body is not valid JSON; treating as transient", {
            path,
            status: response.status,
            error: causeMessage(error),
          });
          return { status: null, body: null };
        }
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      logger("warn", "control-plane request failed", { path, error: causeMessage(error) });
      return { status: null, body: null };
    }
  };
  let transientFailures = 0;
  const retryLater = async (operation: WorkerOperation, status: number | null) => {
    const delayMs = retryDelayMs(transientFailures, random);
    transientFailures += 1;
    logger("warn", "control plane unavailable; retrying", { operation, status, delayMs });
    await pause(delayMs);
  };

  const register = async () => {
    // One key per registration: retries replay it, a later re-registration writes again.
    const key = `register:${workerId}:${crypto.randomUUID()}`;
    while (!signal?.aborted) {
      const { status, body } = await call(
        "/api/v2/workers/register",
        { workerId, repositoryDigest, worktreeDigest },
        key,
        shutdown,
      );
      const action = workerAction("register", status);
      if (action === "continue") {
        transientFailures = 0;
        return;
      }
      if (action !== "retry") {
        const reason = responseReason(body);
        throw new Error(`worker registration failed: ${status}${reason ? ` (${reason})` : ""}`);
      }
      await retryLater("register", status);
    }
  };

  const runClaim = async (claim: Claim, claimSent: number): Promise<Error | null> => {
    const fields = { nodeId: claim.nodeId, attemptId: claim.attemptId, fence: claim.fence };
    const leaseMs = claim.leaseSeconds * 1000;
    const heartbeatMs = claim.heartbeatSeconds * 1000;
    // The server may grant the lease at any point of the long poll, so the deadline starts when
    // the claim request was sent, consistent with heartbeats.
    let leaseDeadline = claimSent + leaseMs;
    let leaseLost = false;
    let fatal: Error | null = null;
    const abort = new AbortController();
    const loseLease = () => {
      leaseLost = true;
      abort.abort();
    };
    const stopExecution = () => abort.abort();
    signal?.addEventListener("abort", stopExecution, { once: true });
    if (signal?.aborted) abort.abort();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(loseLease, Math.max(0, leaseDeadline - now()));
    };
    armDeadline();
    const heartbeatLoop = (async () => {
      let failures = 0;
      while (!abort.signal.aborted) {
        await pause(
          failures ? Math.min(retryDelayMs(failures - 1, random), heartbeatMs) : heartbeatMs,
          abort.signal,
        );
        if (abort.signal.aborted) break;
        const sent = now();
        const { status } = await call(
          "/api/v2/workers/heartbeat",
          { workerId, nodeId: claim.nodeId, fence: claim.fence },
          `heartbeat:${claim.attemptId}:${claim.fence}:${crypto.randomUUID()}`,
          { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, heartbeatMs), signal: abort.signal },
        );
        if (abort.signal.aborted) break;
        const action = workerAction("heartbeat", status);
        if (action === "continue") {
          failures = 0;
          leaseDeadline = sent + leaseMs;
          armDeadline();
        } else if (action === "retry") {
          failures += 1;
          logger("warn", "heartbeat failed; retrying until the lease deadline", {
            ...fields,
            status,
          });
          if (now() >= leaseDeadline) loseLease();
        } else {
          if (action === "exit") fatal = new Error(`heartbeat failed: ${status}`);
          logger("warn", "lease lost; abandoning claim", { ...fields, status });
          loseLease();
        }
      }
    })();
    const artifacts: ClaimArtifact[] = [];
    const context: ClaimContext = {
      publishArtifact: (artifact) => {
        if (uploadArtifacts) artifacts.push(artifact);
      },
    };
    /** Retries transient reserve/verify failures a few times while the lease holds. */
    const artifactCall = async (path: string, body: unknown, key: string) => {
      for (let attempt = 0; ; attempt += 1) {
        const sent = await call(path, body, key, {
          timeoutMs: ARTIFACT_TIMEOUT_MS,
          signal: abort.signal,
        });
        const retry =
          statusClass(sent.status) === "transient" &&
          attempt < ARTIFACT_RETRIES &&
          !abort.signal.aborted &&
          now() < leaseDeadline;
        if (!retry) return sent;
        await pause(retryDelayMs(attempt, random), abort.signal);
      }
    };
    const owner = { workerId, nodeId: claim.nodeId, fence: claim.fence };
    let storageMissing = false;
    /** Reserves, uploads and verifies one artifact; failures become a bounded report entry. */
    const uploadArtifact = async (artifact: ClaimArtifact) => {
      const sha256 = crypto.createHash("sha256").update(artifact.bytes).digest("hex");
      const entry = { name: artifact.name, sha256, sizeBytes: artifact.bytes.length };
      /** Logs the detail locally; `reported` is the only text the control plane receives. */
      const failed = (error: string, reported = error) => {
        logger("warn", "artifact upload failed", { ...fields, name: artifact.name, error });
        return { ...entry, error: artifactFailure(reported) };
      };
      if (storageMissing) return failed("control plane has no artifact storage configured (404)");
      const reserved = await artifactCall(
        RESERVE_PATH,
        { ...owner, sha256, sizeBytes: entry.sizeBytes, contentType: artifact.contentType },
        `artifact:${claim.attemptId}:${claim.fence}:${artifact.name}`,
      );
      if (reserved.status === 404) {
        storageMissing = true;
        return failed("control plane has no artifact storage configured (404)");
      }
      const reservation = artifactReservation.safeParse(reserved.body);
      if (workerAction("report", reserved.status) !== "continue" || !reservation.success)
        return failed(withReason(`reservation failed (${reserved.status})`, reserved.body));
      try {
        await putPresigned(
          reservation.data.uploadUrl,
          artifact,
          allowInsecureDevelopment,
          abort.signal,
          resolveHostname ?? defaultResolveHostname,
        );
      } catch (error) {
        // Storage statuses and connect errors stay local: they would let a hostile control plane probe the network.
        const detail = causeMessage(error);
        return failed(
          `upload failed: ${detail}`,
          detail === "upload aborted" ? detail : "upload failed",
        );
      }
      const verified = await artifactCall(
        VERIFY_PATH,
        { id: reservation.data.id, ...owner, sha256, sizeBytes: entry.sizeBytes },
        `artifact-verify:${claim.attemptId}:${claim.fence}:${artifact.name}`,
      );
      if (workerAction("report", verified.status) !== "continue")
        return failed(withReason(`verification rejected (${verified.status})`, verified.body));
      return { ...entry, id: reservation.data.id, state: "verified" };
    };
    try {
      let outcome: { result: unknown } | { failed: string };
      try {
        outcome = { result: await execute(claim, abort.signal, context) };
      } catch (error) {
        // The full error stays in the worker log; only a scrubbed summary reaches the control plane.
        logger("error", "claim execution failed", {
          ...fields,
          error: causeMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        outcome = { failed: executionFailureMessage(error) };
      }
      // A finished result is still reported while the local lease deadline holds.
      if (abort.signal.aborted && ("failed" in outcome || leaseLost || now() >= leaseDeadline)) {
        logger("warn", "lease lost or run cancelled; abandoning claim", fields);
        return fatal;
      }
      // Upload failures are recorded in the successful report; they never turn it into a failure.
      if ("result" in outcome && artifacts.length && isRecord(outcome.result)) {
        const artifactUploads: Record<string, unknown>[] = [];
        for (const artifact of artifacts) artifactUploads.push(await uploadArtifact(artifact));
        outcome = { result: { ...outcome.result, artifactUploads } };
        if (leaseLost || now() >= leaseDeadline) {
          logger("warn", "lease lost while uploading artifacts; abandoning claim", fields);
          return fatal;
        }
      }
      // Success and failure keep separate idempotency keys, but a failed report never turns a successful execution into a failure.
      const failureKey = `failure:${claim.attemptId}:${claim.fence}`;
      const deliver = async (path: string, result: unknown, key: string) => {
        for (let attempt = 0; ; attempt += 1) {
          const { status, body } = await call(
            path,
            { workerId, nodeId: claim.nodeId, fence: claim.fence, result },
            key,
          );
          const action = workerAction("report", status);
          if (action === "retry" && !leaseLost && now() < leaseDeadline && !signal?.aborted) {
            await pause(retryDelayMs(attempt, random), abort.signal);
            continue;
          }
          return { status, body, action };
        }
      };
      let path = "failed" in outcome ? FAILURE_PATH : REPORT_PATH;
      let sent =
        "failed" in outcome
          ? await deliver(path, { message: outcome.failed }, failureKey)
          : await deliver(path, outcome.result, `report:${claim.attemptId}:${claim.fence}`);
      if (path === REPORT_PATH && (sent.status === 400 || sent.status === 413)) {
        logger("warn", "control plane rejected the result; reporting a failure instead", {
          ...fields,
          status: sent.status,
        });
        path = FAILURE_PATH;
        sent = await deliver(
          path,
          { message: rejectionSummary(sent.status, sent.body), code: "result_rejected" },
          failureKey,
        );
      }
      if (sent.action === "exit") return new Error(`report failed: ${sent.status}`);
      if (sent.status === 409) logger("warn", "lease lost while reporting; continuing", fields);
      else if (sent.action !== "continue")
        logger("error", "report failed; lease reconciler will re-queue the node", {
          ...fields,
          path,
          status: sent.status,
        });
      return fatal;
    } finally {
      signal?.removeEventListener("abort", stopExecution);
      clearTimeout(deadlineTimer);
      abort.abort();
      await heartbeatLoop;
    }
  };

  await register();
  while (!signal?.aborted) {
    const claimSent = now();
    const claimed = await call(
      "/api/v2/workers/claim",
      { workerId, longPollSeconds: 25 },
      `claim:${workerId}:${crypto.randomUUID()}`,
      shutdown,
    );
    const action = workerAction("claim", claimed.status, responseCode(claimed.body));
    if (action === "retry") {
      await retryLater("claim", claimed.status);
      continue;
    }
    if (action === "reregister") {
      logger("warn", "worker is not registered; registering again", { workerId });
      await register();
      // One backoff step keeps a flapping registration from turning into a hot loop.
      await pause(retryDelayMs(0, random));
      continue;
    }
    if (action === "backoff") {
      // The run is pinned to another worker or otherwise busy: nothing claimable right now.
      logger("warn", "claim conflict; backing off", { workerId });
      await pause(IDLE_POLL_MS);
      continue;
    }
    if (action !== "continue") throw new Error(`claim failed: ${claimed.status}`);
    const parsedClaim = claimResponse.safeParse(claimed.body);
    if (!parsedClaim.success) {
      logger("warn", "claim response failed validation; retrying", {
        issues: parsedClaim.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      await retryLater("claim", null);
      continue;
    }
    transientFailures = 0;
    const { claim } = parsedClaim.data;
    if (!claim) {
      await pause(IDLE_POLL_MS);
      continue;
    }
    const timing = workerLeaseTiming(claim.leaseSeconds, claim.heartbeatSeconds);
    if (
      timing.leaseSeconds !== claim.leaseSeconds ||
      timing.heartbeatSeconds !== claim.heartbeatSeconds
    )
      logger("warn", "server lease timing adjusted to worker bounds", {
        received: { leaseSeconds: claim.leaseSeconds, heartbeatSeconds: claim.heartbeatSeconds },
        effective: timing,
      });
    const fatal = await runClaim({ ...claim, ...timing }, claimSent);
    if (fatal) throw fatal;
  }
}

import type { LookupFunction } from "node:net";
import { WORKER_UNREGISTERED, type Claim } from "./store-types.js";
import { z } from "zod";
interface Address {
  address: string;
  family?: number;
}
interface Connection {
  address: string;
  family: number;
}
interface EndpointPolicy {
  allowInsecureDevelopment: boolean;
  resolveHostname: (host: string) => Promise<Address[]>;
}
interface WorkerResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
}
interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  body: string;
  redirect: "error";
}
interface WorkerRequestOptions {
  baseUrl: string;
  token: string;
  allowInsecureDevelopment?: boolean;
  resolveHostname?: EndpointPolicy["resolveHostname"];
  fetchImpl?: ((url: URL, options: RequestOptions) => Promise<WorkerResponse>) | null;
}
interface RequestCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
/** An attempt output the worker uploads through the control plane's artifact reservations. */
export interface ClaimArtifact {
  name: string;
  bytes: Buffer;
  contentType: string;
}
/** Passed to the executor; published artifacts are uploaded only when `uploadArtifacts` is set. */
export interface ClaimContext {
  publishArtifact(artifact: ClaimArtifact): void;
}
interface RunWorkerOptions extends WorkerRequestOptions {
  workerId: string;
  repositoryDigest: string;
  worktreeDigest: string;
  execute: (claim: Claim, signal: AbortSignal, context: ClaimContext) => Promise<unknown>;
  /** Reserve, upload and verify published artifacts after a successful execution. */
  uploadArtifacts?: boolean;
  signal?: AbortSignal | null;
  /** Waits ms; implementations should resolve early when the optional signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  logger?: (level: string, message: string, fields?: Record<string, unknown>) => unknown;
  now?: () => number;
  random?: () => number;
}
const claimResponse = z.object({
  claim: z
    .object({
      attemptId: z.string().uuid(),
      nodeId: z.string().uuid(),
      runId: z.string().uuid(),
      projectId: z.string(),
      nodeKey: z.string(),
      access: z.enum(["read", "write"]),
      payload: z.unknown(),
      fence: z.number().int().positive(),
      leaseSeconds: z.number().int().positive(),
      heartbeatSeconds: z.number().int().positive(),
    })
    .nullable(),
});

const artifactReservation = z.object({ id: z.string().uuid(), uploadUrl: z.string() });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBounded(response: WorkerResponse): Promise<unknown> {
  const bytes = await readResponseBytes(response);
  return bytes.length
    ? (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown)
    : {};
}
