/** Incremental, bounded sanitized trace replay. Cached prefixes are tail-verified on change. */
import { closeSync, fstatSync, readSync } from "node:fs";
import { openFileAt, openParent, openRoot } from "@rae/fs-bridge";
import { relative } from "node:path";
import { badTrace } from "../primitives/errors.js";
import { ensureRuntimeStateReadable } from "./runtime-state-guard.js";
import { getTracePath, MAX_TRACE_EVENTS } from "./trace.js";
import type { BigIntStats } from "node:fs";

interface OperatorEvent extends Record<string, string | number> {
  seq: number;
  event_id: string;
}
interface TraceCacheEntry {
  identity: string;
  revision: string;
  offset: number;
  lines: number;
  /** The last bytes before `offset`; a changed tail means the file was rewritten, not appended. */
  tail: Buffer;
  events: OperatorEvent[];
  bytes: number;
}
interface TraceMetrics extends Record<string, number> {
  bytes_read: number;
  records_parsed: number;
  cache_hits: number;
}
const cache = new Map<string, TraceCacheEntry>();
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const metrics: TraceMetrics = { bytes_read: 0, records_parsed: 0, cache_hits: 0 };
const TAIL_BYTES = 4096;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const identity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}`;
const revision = (stat: BigIntStats): string =>
  `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function operatorTraceMetrics({ reset = false }: { reset?: boolean } = {}): TraceMetrics & {
  cache_entries: number;
} {
  const result = { ...metrics, cache_entries: cache.size };
  if (reset) for (const key of Object.keys(metrics)) metrics[key] = 0;
  return result;
}

export function clearOperatorTraceCache(): void {
  cache.clear();
}

function retain(path: string, entry: TraceCacheEntry): void {
  cache.delete(path);
  if (entry.bytes > MAX_ENTRY_BYTES) return;
  cache.set(path, entry);
  let total = [...cache.values()].reduce((sum, value) => sum + value.bytes, 0);
  while (cache.size > 16 || total > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    total -= cache.get(oldest)?.bytes ?? 0;
    cache.delete(oldest);
  }
}

function project(line: string, runId: string, seq: number): OperatorEvent {
  let record: unknown;
  try {
    metrics.records_parsed += 1;
    record = JSON.parse(line);
  } catch (error) {
    throw badTrace(`corrupt trace JSONL at line ${seq}: ${String(error)}`);
  }
  const recordObject =
    record && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : {};
  const event: OperatorEvent = {
    seq,
    event_id: typeof recordObject.event_id === "string" ? recordObject.event_id : `${runId}:${seq}`,
  };
  for (const key of [
    "run_id",
    "ts",
    "event",
    "phase",
    "status",
    "tier",
    "artifact_ref",
    "gate_id",
  ]) {
    if (typeof recordObject[key] === "string") event[key] = recordObject[key];
  }
  return event;
}

/** Parses `raw`, the file bytes from `base`; a `prior` entry is extended only when `reusable`. */
function parseAppend(
  raw: Buffer,
  base: number,
  prior: TraceCacheEntry | undefined,
  reusable: boolean,
  runId: string,
  stat: BigIntStats,
): TraceCacheEntry {
  const events = reusable && prior ? [...prior.events] : [];
  let bytes = reusable && prior ? prior.bytes : 0;
  let lineNumber = reusable && prior ? prior.lines : 0;
  let offset = reusable && prior ? prior.offset - base : 0;
  for (;;) {
    const end = raw.indexOf(10, offset);
    if (end < 0) break; // The writer has not committed the final JSONL record yet.
    let line: string;
    try {
      line = utf8.decode(raw.subarray(offset, end)).trim();
    } catch {
      throw badTrace(`invalid trace UTF-8 at line ${lineNumber + 1}`);
    }
    offset = end + 1;
    lineNumber += 1;
    if (!line) continue;
    const event = project(line, runId, lineNumber);
    events.push(event);
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (events.length > MAX_TRACE_EVENTS) {
      throw badTrace(`trace file exceeds MAX_TRACE_EVENTS (${MAX_TRACE_EVENTS})`);
    }
  }
  return {
    identity: identity(stat),
    revision: revision(stat),
    offset: base + offset,
    lines: lineNumber,
    tail: Buffer.from(raw.subarray(Math.max(0, offset - TAIL_BYTES), offset)),
    events,
    bytes,
  };
}

const MAX_TRACE_BYTES = 20 * 1024 * 1024;
const SNAPSHOT_RETRIES = 3;
/** A concurrent append can race one snapshot; retry before surfacing the change. */
function readSnapshot(path: string, runId: string, root: string): TraceCacheEntry {
  for (let attempt = 0; ; attempt++) {
    try {
      return readSnapshotOnce(path, runId, root);
    } catch (error) {
      if (
        attempt >= SNAPSHOT_RETRIES ||
        !(error instanceof Error && error.message.includes("trace changed while reading"))
      )
        throw error;
    }
  }
}

/** Reads the bytes from `base` to the end of the stat'ed size; throws when the file moved meanwhile. */
function readFrom(fd: number, base: number, stat: BigIntStats): Buffer {
  const raw = Buffer.alloc(Number(stat.size) - base + 1);
  let bytes = 0;
  while (bytes < raw.length) {
    const count = readSync(fd, raw, bytes, raw.length - bytes, base + bytes);
    if (!count) break;
    bytes += count;
  }
  metrics.bytes_read += bytes;
  const after = fstatSync(fd, { bigint: true });
  if (revision(stat) !== revision(after) || bytes !== Number(stat.size) - base)
    throw badTrace("trace changed while reading; retry replay");
  return raw.subarray(0, bytes);
}

function readSnapshotOnce(path: string, runId: string, root: string): TraceCacheEntry {
  const rootFd = openRoot(root);
  let parentFd: number | undefined, fd: number | undefined;
  try {
    const parent = openParent(rootFd, relative(root, path));
    parentFd = parent.fd;
    fd = openFileAt(parentFd, parent.name);
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      stat.size > BigInt(MAX_TRACE_BYTES)
    )
      throw badTrace("unsafe trace file or trace byte limit exceeded");
    const prior = cache.get(path);
    if (prior?.revision === revision(stat)) {
      metrics.cache_hits += 1;
      retain(path, prior);
      return prior;
    }
    cache.delete(path);
    // Growth alone is not proof of append-only writes: re-read the tail block before the old offset.
    let base = 0;
    let reusable = false;
    if (prior && prior.identity === identity(stat) && stat.size >= BigInt(prior.offset)) {
      base = prior.offset - prior.tail.length;
      reusable = true;
    }
    let raw = readFrom(fd, base, stat);
    if (reusable && prior && !raw.subarray(0, prior.tail.length).equals(prior.tail)) {
      base = 0;
      reusable = false;
      raw = readFrom(fd, 0, stat);
    }
    const entry = parseAppend(raw, base, prior, reusable, runId, stat);
    retain(path, entry);
    return entry;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (parentFd !== undefined) closeSync(parentFd);
    closeSync(rootFd);
  }
}

export interface OperatorEventPageOptions {
  after?: number;
  limit?: number;
}
export interface OperatorEventPage {
  events: OperatorEvent[];
  next_after: number;
  has_more: boolean;
}
function validatePage({ after = 0, limit = 100 }: OperatorEventPageOptions): {
  after: number;
  limit: number;
} {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TRACE_EVENTS
  )
    throw badTrace("invalid operator event cursor or limit");
  return { after, limit };
}
/** One protected snapshot serves bounded cursor cohorts without repeating filesystem authorization. */
export function readOperatorEventPages(
  runId: string,
  root: string,
  requests: readonly OperatorEventPageOptions[],
): OperatorEventPage[] {
  if (!requests.length || requests.length > 128)
    throw badTrace("invalid operator event page batch");
  const pages = requests.map(validatePage);
  ensureRuntimeStateReadable(root, { expectedRunId: runId });
  const path = getTracePath(runId, root);
  let records: OperatorEvent[];
  try {
    records = readSnapshot(path, runId, root).events;
  } catch (error) {
    cache.delete(path);
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    records = [];
  }
  ensureRuntimeStateReadable(root, { expectedRunId: runId });
  return pages.map(({ after, limit }) => selectPage(records, after, limit));
}

/** Physical JSONL line cursors survive reconnects; returned records cannot mutate the cache. */
export function readOperatorEventsAfter(
  runId: string,
  root: string,
  options: OperatorEventPageOptions = {},
): OperatorEventPage {
  const page = readOperatorEventPages(runId, root, [options])[0];
  if (!page) throw badTrace("missing operator event page");
  return page;
}
function selectPage(records: OperatorEvent[], after: number, limit: number): OperatorEventPage {
  // Binary search avoids scanning retained history for every page.
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((records[middle]?.seq ?? Number.POSITIVE_INFINITY) <= after) low = middle + 1;
    else high = middle;
  }
  const events = records.slice(low, low + limit).map((event) => ({ ...event }));
  return {
    events,
    next_after: events.at(-1)?.seq ?? after,
    has_more: low + events.length < records.length,
  };
}
