/** Enforces loopback request authentication, project confinement, and input bounds. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename } from "node:path";
import type { IncomingMessage } from "node:http";

export interface OperatorProject {
  id: string;
  root: string;
  label: string;
}
type HttpError = Error & { status?: number };

export const MAX_BODY_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function opaqueProjectId() {
  return randomBytes(12).toString("base64url");
}

export function canonicalGitRoot(pathValue: unknown): string {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error("project root must be a non-empty path");
  }
  const canonical = realpathSync(pathValue);
  const result = spawnSync(
    "git",
    ["-C", canonical, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`project root is not a Git repository: ${pathValue}`);
  }
  const topLevel = realpathSync(result.stdout.trim());
  if (topLevel !== canonical) {
    throw new Error(`project root must be the Git top-level directory: ${topLevel}`);
  }
  return canonical;
}

export function createProjectRegistry(paths: unknown): OperatorProject[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("at least one --project Git root is required");
  }
  const seen = new Set<string>();
  return paths.map((pathValue) => {
    const root = canonicalGitRoot(pathValue);
    if (seen.has(root)) throw new Error(`duplicate project root: ${root}`);
    seen.add(root);
    return { id: opaqueProjectId(), root, label: basename(root) };
  });
}

export function findProject(
  projects: OperatorProject[],
  projectId: unknown,
): OperatorProject | null {
  if (typeof projectId !== "string" || !SAFE_ID.test(projectId)) return null;
  return projects.find((project) => project.id === projectId) ?? null;
}

export function isAuthorized(header: unknown, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const candidate = header.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(token);
  const candidateBuffer = Buffer.from(candidate);
  return (
    expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

export function validateLoopbackRequest(
  req: Pick<IncomingMessage, "headers">,
  {
    host,
    origin,
    requireOrigin = false,
  }: { host: string; origin: string; requireOrigin?: boolean },
) {
  if (req.headers.host !== host) return { ok: false, status: 421, error: "invalid Host" };
  const suppliedOrigin = req.headers.origin;
  if (requireOrigin && suppliedOrigin !== origin) {
    return { ok: false, status: 403, error: "invalid Origin" };
  }
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin) {
    return { ok: false, status: 403, error: "invalid Origin" };
  }
  return { ok: true };
}

function bodyTooLarge(limit: number): HttpError {
  return Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413 });
}

function declaredBodyLength(req: Pick<IncomingMessage, "headers">, limit: number): void {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > limit) throw bodyTooLarge(limit);
}

async function collectBodyChunks(
  req: IncomingMessage,
  limit: number,
): Promise<{ size: number; chunks: Buffer[] }> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw bodyTooLarge(limit);
    chunks.push(bytes);
  }
  return { size, chunks };
}

function parseJsonObject(chunks: Buffer[]): Record<string, unknown> {
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  declaredBodyLength(req, limit);
  const { size, chunks } = await collectBodyChunks(req, limit);
  if (size === 0) return {};
  try {
    return parseJsonObject(chunks);
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    const badRequest: HttpError = new Error(
      `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
    badRequest.status = 400;
    throw badRequest;
  }
}

export function validateRunId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw Object.assign(new Error("invalid run id"), { status: 400 });
  }
  return value as string;
}

export function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  minimum = 0,
): number {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw Object.assign(new Error(`value must be an integer from ${minimum} to ${maximum}`), {
      status: 400,
    });
  }
  return number;
}

const SCRUBBED_MESSAGE_MAX = 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * Long opaque-looking tokens are scrubbed from messages, except identifiers the console itself
 * shows and operators need to correlate: 40- and 64-hex Git and artifact digests, UUIDs and run
 * ids. Session tokens are base64url, so none of these patterns matches them and they are still
 * scrubbed.
 */
const KEPT_IDENTIFIERS = [
  /^[0-9a-f]{40}$/i,
  /^[0-9a-f]{64}$/i,
  new RegExp(`^${UUID}$`, "i"),
  new RegExp(`^[A-Za-z][A-Za-z0-9]{0,31}-${UUID}$`, "i"),
  /^run-[A-Za-z0-9_-]{1,124}$/,
];
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;
/** OSC (ESC ] … BEL or ST), CSI (ESC [ … final) and two-byte ESC sequences. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point.
const TERMINAL_SEQUENCES = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/** Strips terminal escapes and control characters before child or engine text is logged. */
export function sanitizeLogText(text: string): string {
  return text.replace(TERMINAL_SEQUENCES, "").replace(CONTROL_CHARACTERS, " ").trim();
}

function pathVariants(path: string): string[] {
  const variants = new Set([path]);
  try {
    variants.add(realpathSync(path));
  } catch {
    // A root that no longer exists is still replaced by its recorded spelling.
  }
  for (const variant of [...variants]) {
    if (variant.startsWith("/private/")) variants.add(variant.slice("/private".length));
    else if (/^\/(?:var|tmp|etc)\//.test(variant)) variants.add(`/private${variant}`);
  }
  return [...variants];
}

function looksLikeSecret(token: string): boolean {
  return !KEPT_IDENTIFIERS.some((pattern) => pattern.test(token));
}

/**
 * Removes local paths and secret-like strings from text that is returned to the browser.
 * Run ids, UUIDs, 40-hex commit SHAs and 64-hex digests stay readable.
 */
export function scrubMessage(text: string, roots: Iterable<string> = []): string {
  let value = text;
  const replacements: Array<[string, string]> = [
    ...[...roots].flatMap((root) =>
      pathVariants(root).map((variant): [string, string] => [variant, "<project>"]),
    ),
    ...pathVariants(homedir()).map((variant): [string, string] => [variant, "<home>"]),
    ...pathVariants(tmpdir()).map((variant): [string, string] => [variant, "<tmp>"]),
  ];
  for (const [path, placeholder] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    if (path.length > 1) value = value.split(path).join(placeholder);
  }
  return value
    .replace(/[A-Za-z0-9_-]{32,}/g, (token) => (looksLikeSecret(token) ? "<redacted>" : token))
    .trim()
    .slice(0, SCRUBBED_MESSAGE_MAX);
}
