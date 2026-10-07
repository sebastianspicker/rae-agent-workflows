/** Exclusive owner-recorded lock files whose dead or abandoned owners can be retired safely. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { writeExclusiveFileAtomic } from "./atomic-file.js";

/** An empty or unparsable lock older than this is treated as abandoned by a crashed writer. */
const ABANDONED_LOCK_MS = 30_000;
/** A retirement lock older than this belongs to a crashed contender. */
const STALE_REAP_LOCK_MS = 60_000;
/** Recorded and observed process start times may differ by this much (seconds). */
const START_TIME_TOLERANCE_S = 2;
/** Linux `/proc/<pid>/stat` start times count clock ticks; 100 Hz is the Linux user-space rate. */
const LINUX_CLOCK_TICKS = 100;

interface LockOwner {
  pid: number;
  hostname: string | null;
  /** Epoch seconds at which the owner process started; absent in older records. */
  started: number | null;
}

interface LockSnapshot {
  content: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface ExclusiveLock {
  path: string;
  token: string;
  release: () => void;
}

/** True when a process with this PID exists (EPERM means it exists under another user). */
export function processAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Epoch seconds from `ps -o lstart=` output such as `Tue Oct  7 12:34:56 2026` (UTC). */
function parsePsStartTime(text: string): number | null {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return null;
  const [day, hour, minute, second, year] = [match[2], match[3], match[4], match[5], match[6]].map(
    Number,
  );
  return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000);
}

/** Process start time in epoch seconds, or null where it cannot be read (other platforms, no ps). */
export function processStartTime(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name may contain spaces and parentheses; fields resume after the last ")".
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]);
      const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
      if (!boot || !Number.isFinite(ticks)) return null;
      return Number(boot[1]) + Math.floor(ticks / LINUX_CLOCK_TICKS);
    }
    if (process.platform === "darwin") {
      const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parsePsStartTime(output);
    }
  } catch {
    return null;
  }
  return null;
}

/** Reads the lock and the file identity of exactly the bytes read; null when it is absent. */
function readLockSnapshot(lockPath: string): LockSnapshot | null {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    return {
      content: readFileSync(descriptor, "utf8"),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    closeSync(descriptor);
  }
}

function sameFile(stat: Stats, snapshot: Pick<LockSnapshot, "dev" | "ino" | "mtimeMs">): boolean {
  return (
    stat.dev === snapshot.dev && stat.ino === snapshot.ino && stat.mtimeMs === snapshot.mtimeMs
  );
}

function readLockContent(lockPath: string): string | null {
  return readLockSnapshot(lockPath)?.content ?? null;
}

/** Accepts the current JSON record and the legacy `<pid>\n` and `{pid, started_at}` formats. */
function parseLockOwner(content: string): LockOwner | null {
  const trimmed = content.trim();
  if (/^\d+$/.test(trimmed)) {
    return { pid: Number.parseInt(trimmed, 10), hostname: null, started: null };
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      pid?: unknown;
      hostname?: unknown;
      started?: unknown;
    } | null;
    const pid = parsed?.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    return {
      pid,
      hostname: typeof parsed?.hostname === "string" ? parsed.hostname : null,
      started:
        typeof parsed?.started === "number" && Number.isFinite(parsed.started)
          ? parsed.started
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * A lock is stale only when its owner is provably gone (no such PID, or a live PID that started
 * at a different time, so the PID was reused) or it was abandoned empty long ago. A lock recorded
 * on another host throws: it cannot be checked from here and is never retired automatically.
 */
function lockIsStale(lockPath: string, snapshot: LockSnapshot): boolean {
  const owner = parseLockOwner(snapshot.content);
  if (owner) {
    if (owner.hostname !== null && owner.hostname !== hostname()) {
      throw new Error(
        `lock ${lockPath} is held by pid ${owner.pid} on host ${owner.hostname}, which cannot be ` +
          `checked from ${hostname()}; after confirming that owner is gone, remove the file ` +
          `${lockPath} and retry`,
      );
    }
    if (!processAlive(owner.pid)) return true;
    if (owner.started === null) return false;
    const current = processStartTime(owner.pid);
    return current !== null && Math.abs(current - owner.started) > START_TIME_TOLERANCE_S;
  }
  return Date.now() - snapshot.mtimeMs >= ABANDONED_LOCK_MS;
}

/** Creates the lock with its complete owner record in one step; throws EEXIST when held. */
function createLock(lockPath: string, content: string): void {
  writeExclusiveFileAtomic(lockPath, content);
}

/**
 * Takes the retirement lock `${lockPath}.reap` (created `wx`). One that outlived
 * STALE_REAP_LOCK_MS belonged to a crashed contender and is removed once, but only if it is still
 * the same file that was judged stale. Returns false when another contender holds it.
 */
function acquireReapLock(reapPath: string): boolean {
  for (let round = 0; round < 2; round++) {
    try {
      const descriptor = openSync(reapPath, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify({ pid: process.pid, hostname: hostname() })}\n`,
        );
      } finally {
        closeSync(descriptor);
      }
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    let observed: Stats;
    try {
      observed = lstatSync(reapPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (Date.now() - observed.mtimeMs < STALE_REAP_LOCK_MS) return false;
    try {
      if (!sameFile(lstatSync(reapPath), observed)) return false;
      unlinkSync(reapPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return false;
}

function releaseReapLock(reapPath: string): void {
  try {
    unlinkSync(reapPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Retires a stale lock under the exclusive `${lockPath}.reap` file, so a single contender does it.
 * The lock's device, inode and mtime are verified against the judged snapshot immediately before
 * it is moved aside, and a lock that changed is left alone. Returns true when the path is free.
 */
function retireStaleLock(lockPath: string, observed: LockSnapshot): boolean {
  const reapPath = `${lockPath}.reap`;
  if (!acquireReapLock(reapPath)) return false;
  try {
    let current: Stats;
    try {
      current = lstatSync(lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    if (!sameFile(current, observed)) return false;
    const retired = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(lockPath, retired);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    if (readLockContent(retired) === observed.content) {
      unlinkSync(retired);
      return true;
    }
    // The verification window closed on a new owner: restore its record with a non-overwriting
    // link and report the lock as held.
    try {
      linkSync(retired, lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    unlinkSync(retired);
    return false;
  } finally {
    releaseReapLock(reapPath);
  }
}

/**
 * Acquires `lockPath` exclusively. Returns null when a live (or unverifiable) owner holds it or
 * another contender is retiring a stale lock. The returned release only removes the lock while it
 * still carries this owner's token.
 */
export function acquireExclusiveLock(lockPath: string): ExclusiveLock | null {
  const token = randomUUID();
  const started = processStartTime(process.pid);
  const content = `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    ...(started === null ? {} : { started }),
    acquired_at: new Date().toISOString(),
    token,
  })}\n`;
  for (let round = 0; round < 2; round++) {
    try {
      createLock(lockPath, content);
      return { path: lockPath, token, release: () => releaseExclusiveLock(lockPath, token) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const observed = readLockSnapshot(lockPath);
    if (observed !== null && !lockIsStale(lockPath, observed)) return null;
    if (observed !== null && !retireStaleLock(lockPath, observed)) return null;
  }
  return null;
}

function releaseExclusiveLock(lockPath: string, token: string): void {
  const current = readLockContent(lockPath);
  if (current === null) return;
  try {
    const parsed = JSON.parse(current) as { token?: unknown } | null;
    if (parsed?.token !== token) return;
  } catch {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}
