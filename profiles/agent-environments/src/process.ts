/** Process liveness and start-time identity used to tell a running transaction from a crashed one. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Start times from /proc and ps agree to within this many seconds. */
export const START_TOLERANCE_SECONDS = 2;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Linux start time from /proc (boot time plus clock ticks; USER_HZ is 100), in epoch seconds. */
function procStart(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const boot = /^btime (\d+)$/mu.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    return Number.isFinite(ticks) && boot !== undefined
      ? Number(boot) + Math.floor(ticks / 100)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parses `ps -o lstart=` output (C locale, UTC) into epoch seconds. */
function parseLstart(text: string): number | undefined {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})$/u.exec(text.trim());
  const month = MONTHS.indexOf((match?.[1] ?? "").toLowerCase());
  if (!match || month < 0) return undefined;
  const [, , day, hour, minute, second, year] = match;
  return Math.floor(
    Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)) / 1000,
  );
}

/** Start time of a process in epoch seconds; undefined when it or the platform tools are missing. */
export function processStart(pid: number): number | undefined {
  if (process.platform === "linux") {
    const fromProc = procStart(pid);
    if (fromProc !== undefined) return fromProc;
  }
  try {
    return parseLstart(
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * Whether the recorded process may still be running. Fails closed: a live pid whose start time
 * cannot be compared counts as running; only a dead pid or a clearly different start time does not.
 */
export function holderAlive(pid: number, started: number | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const actual = processStart(pid);
  return !(
    started !== null &&
    actual !== undefined &&
    Math.abs(started - actual) > START_TOLERANCE_SECONDS
  );
}
