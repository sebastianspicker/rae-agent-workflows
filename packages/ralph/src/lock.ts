/** Owns authenticated single-run locking and conservative stale-lock recovery. */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, uptime } from "node:os";
import {
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  openRoot,
  readDirectory,
  renameAt,
  unlinkAt,
} from "@rae/fs-bridge";
import { EXIT, RalphError } from "./errors.js";
import type { RuntimePaths } from "./types.js";

const LOCK_NAME = Buffer.from(".run.lock");
const HOST_NAME = Buffer.from("host");
/** Process start times from different sources agree to within this many seconds. */
const START_TOLERANCE_SECONDS = 2;
/** Linux reports start times in clock ticks; USER_HZ is 100 on every supported platform. */
const CLOCK_TICKS = 100;

interface HostMarker {
  hostname: string;
  boot_ms: number;
  /** Stable machine identity where the platform offers one; only ever used to refuse reclaiming. */
  machine_id?: string;
  /** Start time (epoch seconds) of the lock holder; absent where it cannot be read. */
  started?: number;
}

/** Reads the Linux start time from /proc, as epoch seconds. */
function procStart(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const boot = /^btime (\d+)$/mu.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    if (!Number.isFinite(ticks) || boot === undefined) return undefined;
    return Number(boot) + Math.floor(ticks / CLOCK_TICKS);
  } catch {
    return undefined;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parses `ps -o lstart=` output (C locale, UTC) into epoch seconds. */
function parseLstart(text: string): number | undefined {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})$/u.exec(text.trim());
  if (!match) return undefined;
  const month = MONTHS.indexOf((match[1] ?? "").toLowerCase());
  if (month < 0) return undefined;
  return Math.floor(
    Date.UTC(
      Number(match[6]),
      month,
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
    ) / 1000,
  );
}

/** Reads a process start time as epoch seconds; undefined when the process or ps is missing. */
export function processStart(pid: number): number | undefined {
  if (process.platform === "linux") {
    const fromProc = procStart(pid);
    if (fromProc !== undefined) return fromProc;
  }
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    });
    return parseLstart(text);
  } catch {
    return undefined;
  }
}

/** Reads a stable machine id (Linux machine-id or macOS IOPlatformUUID) when one is available. */
function machineId(): string | undefined {
  try {
    if (process.platform === "linux") {
      return readFileSync("/etc/machine-id", "utf8").trim() || undefined;
    }
    if (process.platform === "darwin") {
      const text = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      return /"IOPlatformUUID" = "([^"]+)"/u.exec(text)?.[1];
    }
  } catch {
    /* identity is advisory */
  }
  return undefined;
}

/** Identifies this host and boot so a lock from another host is never reclaimed. */
export function hostMarker(): HostMarker {
  const started = processStart(process.pid);
  const id = machineId();
  return {
    hostname: hostname(),
    boot_ms: Math.round(Date.now() - uptime() * 1000),
    ...(id ? { machine_id: id } : {}),
    ...(started !== undefined ? { started } : {}),
  };
}

/** True when the marker proves the lock was taken on another host; never a reason to reclaim. */
export function foreignHost(recorded: unknown, current: HostMarker = hostMarker()): boolean {
  if (!recorded || typeof recorded !== "object") return false;
  const marker = recorded as Partial<HostMarker>;
  if (typeof marker.hostname === "string" && marker.hostname !== current.hostname) return true;
  return (
    typeof marker.machine_id === "string" &&
    current.machine_id !== undefined &&
    marker.machine_id !== current.machine_id
  );
}

/** True when the recorded start time proves the PID now belongs to a different process. */
export function recycledPid(recorded: unknown, actual: number | undefined): boolean {
  if (!recorded || typeof recorded !== "object" || actual === undefined) return false;
  const started = (recorded as Partial<HostMarker>).started;
  return typeof started === "number" && Math.abs(started - actual) > START_TOLERANCE_SECONDS;
}

/** Parses a lock PID; 0, 1 and negative values never identify a Ralph process. */
export function lockPid(text: string): number | undefined {
  const value = text.trim();
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) return undefined;
  const pid = Number(value);
  return pid > 1 ? pid : undefined;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function readFileAt(directoryFd: number, name: Buffer): string {
  const fd = openFileAt(directoryFd, name, "read");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(128);
    let total = 0;
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      total += size;
      if (total > 4096) throw new RalphError("Ralph lock metadata is too large", EXIT.lock);
      chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Writes through a temporary file in the lock directory so readers never see partial content. */
function writeFileAt(directoryFd: number, name: Buffer, value: string): void {
  const temporary = Buffer.from(`.${process.pid}.${randomUUID()}.tmp`);
  const fd = openFileAt(directoryFd, temporary, "create");
  try {
    try {
      fchmodSync(fd, 0o600);
      const bytes = Buffer.from(value);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameAt(directoryFd, temporary, directoryFd, name, false);
  } catch (error) {
    try {
      unlinkAt(directoryFd, temporary, false);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function sameIdentity(leftFd: number, rightFd: number): boolean {
  const left = fstatSync(leftFd);
  const right = fstatSync(rightFd);
  return left.dev === right.dev && left.ino === right.ino;
}

function removeLock(stateFd: number, expectedFd: number): void {
  const current = openDirectoryAt(stateFd, LOCK_NAME);
  try {
    if (!sameIdentity(current, expectedFd))
      throw new RalphError("Ralph lock changed while being reclaimed", EXIT.lock);
    for (const name of readDirectory(current)) unlinkAt(current, name, false);
    fsyncSync(current);
  } finally {
    closeSync(current);
  }
  unlinkAt(stateFd, LOCK_NAME, true);
  fsyncSync(stateFd);
}

export class RunLock {
  private readonly stateDirectory: string;
  private readonly token = randomUUID();
  private owned = false;

  public constructor(
    paths: RuntimePaths,
    private readonly staleNoPidSeconds: number,
  ) {
    this.stateDirectory = paths.stateDir;
  }

  public acquire(): void {
    const stateFd = openRoot(this.stateDirectory);
    try {
      try {
        mkdirAt(stateFd, LOCK_NAME, 0o700);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        let existing: number;
        try {
          existing = openDirectoryAt(stateFd, LOCK_NAME);
        } catch {
          throw new RalphError(
            `Ralph run lock is not a safe directory: ${this.stateDirectory}/.run.lock`,
            EXIT.lock,
          );
        }
        try {
          if (!this.reclaimable(existing))
            throw new RalphError(
              `Another Ralph run is active (lock: ${this.stateDirectory}/.run.lock)`,
              EXIT.lock,
            );
          removeLock(stateFd, existing);
        } finally {
          closeSync(existing);
        }
        try {
          mkdirAt(stateFd, LOCK_NAME, 0o700);
        } catch {
          throw new RalphError(
            `Could not acquire Ralph run lock: ${this.stateDirectory}/.run.lock`,
            EXIT.lock,
          );
        }
      }
      const lockFd = openDirectoryAt(stateFd, LOCK_NAME);
      try {
        writeFileAt(lockFd, Buffer.from("pid"), `${process.pid}\n`);
        writeFileAt(lockFd, HOST_NAME, `${JSON.stringify(hostMarker())}\n`);
        writeFileAt(lockFd, Buffer.from("token"), `${this.token}\n`);
        fsyncSync(lockFd);
      } catch (error) {
        try {
          removeLock(stateFd, lockFd);
        } catch {
          /* retain failed lock evidence */
        }
        throw error;
      } finally {
        closeSync(lockFd);
      }
      fsyncSync(stateFd);
      this.owned = true;
    } finally {
      closeSync(stateFd);
    }
  }

  private reclaimable(lockFd: number): boolean {
    let pid: number | undefined;
    try {
      pid = lockPid(readFileAt(lockFd, Buffer.from("pid")));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (pid !== undefined) {
      let marker: unknown;
      try {
        const text = readFileAt(lockFd, HOST_NAME).trim();
        // A missing, empty or unparsable host file falls back to the PID check, never to "stale".
        if (text) marker = JSON.parse(text);
      } catch (error) {
        if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      if (foreignHost(marker))
        throw new RalphError(
          `Ralph lock held from another host; remove it manually (${this.stateDirectory}/.run.lock)`,
          EXIT.lock,
        );
      // A recycled PID has a different start time than the process that took the lock.
      if (recycledPid(marker, processStart(pid))) return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (errorCode(error) === "EPERM") return false;
      }
      return true;
    }
    const age = (Date.now() - fstatSync(lockFd).mtimeMs) / 1000;
    return age >= this.staleNoPidSeconds;
  }

  public release(): void {
    if (!this.owned) return;
    let stateFd: number | undefined;
    let lockFd: number | undefined;
    try {
      stateFd = openRoot(this.stateDirectory);
      lockFd = openDirectoryAt(stateFd, LOCK_NAME);
      if (readFileAt(lockFd, Buffer.from("token")).trim() === this.token)
        removeLock(stateFd, lockFd);
    } catch {
      /* keep a lock we cannot authenticate */
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      if (stateFd !== undefined) closeSync(stateFd);
      this.owned = false;
    }
  }
}

export function lockState(paths: RuntimePaths): {
  held: boolean;
  status: string;
  pid: number | null;
} {
  let stateFd: number | undefined;
  let lockFd: number | undefined;
  try {
    stateFd = openRoot(paths.stateDir);
    lockFd = openDirectoryAt(stateFd, LOCK_NAME);
    let pid: number | null = null;
    try {
      pid = lockPid(readFileAt(lockFd, Buffer.from("pid"))) ?? null;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return { held: true, status: `held (pid=${pid ?? "?"})`, pid };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { held: false, status: "not held", pid: null };
    return { held: true, status: "held (unreadable)", pid: null };
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    if (stateFd !== undefined) closeSync(stateFd);
  }
}
