/** Pure formatting helpers for the operator console. */
import type { OperatorRun } from "./types.js";

export function phaseLabel(phase: unknown): string {
  return (
    (
      {
        arm: "Intake",
        design: "Design",
        "adversarial-review": "Adversarial review",
        plan: "Plan",
        pmatch: "Drift match",
        build: "Build",
        "quality-static": "Quality static",
        "quality-tests": "Quality tests",
        "post-build": "Post-build",
        "release-readiness": "Release readiness",
      } as Record<string, string>
    )[String(phase ?? "")] ?? humanize(phase)
  );
}

export function humanize(value: unknown): string {
  return String(value ?? "")
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function tone(status: unknown): string {
  const value = String(status ?? "").toLowerCase();
  if (["pass", "passed", "completed", "success", "approved"].includes(value)) return "pass";
  if (["fail", "failed", "error", "blocked", "rejected"].includes(value)) return "error";
  if (["running", "active", "in_progress", "pending", "awaiting"].includes(value)) return "active";
  return "muted";
}

/** True when a human checkpoint decision is waiting on this run. */
export function needsDecision(run: OperatorRun | null | undefined): boolean {
  return (
    run?.needs_human_decision === true ||
    Boolean(run?.checkpoints?.some((item) => item.status === "pending"))
  );
}

/** Catalogue filter tone: a human hold is "decision"; "blocked" is reserved for failures. */
export function runTone(run: OperatorRun | null | undefined): string {
  if (needsDecision(run)) return "decision";
  // A graph wait with no checkpoint is live workflow state, not a human hold.
  if (run?.status === "waiting") return "active";
  const statusTone = tone(run?.status);
  if (statusTone === "pass") return "proof";
  if (statusTone === "active") return "active";
  if (statusTone === "error") return "blocked";
  return "muted";
}

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

export function formatNumber(value: unknown, unavailable = "—"): string {
  if (value === null || value === undefined || value === "") return unavailable;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : String(value);
}

export function formatCost(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(numeric)
    : String(value);
}

export function formatTime(value: string | null | undefined, withDate = false): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Not available";
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return withDate
    ? `${date.toLocaleDateString([], { month: "short", day: "2-digit" })} ${time}`
    : time;
}

/** True when timestamped entries fall on more than one local calendar day. */
export function spansMultipleDays(values: ReadonlyArray<string | null | undefined>): boolean {
  const days = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) continue;
    days.add(date.toDateString());
    if (days.size > 1) return true;
  }
  return false;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unavailable"
    : date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  const delta = Date.now() - date.valueOf();
  if (delta < 60_000) return "Now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 172_800_000) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Shortens an identifier from the middle so its distinguishing prefix and suffix stay visible. */
export function middleCut(value: unknown, maximum: number): string {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  const tail = Math.max(4, Math.floor((maximum - 1) / 3));
  return `${text.slice(0, maximum - 1 - tail)}…${text.slice(-tail)}`;
}

export function shortRef(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "—";
  if (text.length <= 18) return text;
  return middleCut(text, 15);
}
