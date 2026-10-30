/** Startup probe of the default run provider, surfaced to the console as a warning. */
import { execFile } from "node:child_process";
import {
  autonomousEntrypoint,
  executionRuntimeCwd,
  failingDoctorChecks,
  minimalChildEnvironment,
} from "@rae/engine";
import type { ProviderDoctorReport } from "@rae/engine";
import { sanitizeLogText, scrubMessage } from "./security.js";

export interface ProviderHealth {
  provider: string;
  ok: boolean;
  /** Scrubbed reason; present only when the probe failed. */
  detail?: string;
}

interface ProbeDependencies {
  doctor: (target: { provider: string; workspaceRoot: string }) => Promise<ProviderDoctorReport>;
  describe: (report: ProviderDoctorReport) => string;
  log: (line: string) => void;
}

const DOCTOR_TIMEOUT_MS = 30_000;

/**
 * Builds a doctor that runs the engine CLI `doctor` off the event loop. The CLI exits 1 with a
 * JSON report on stdout when the provider is not ready; only a missing report is an error.
 */
export function cliDoctor(
  entrypoint: string = autonomousEntrypoint(),
  timeoutMs = DOCTOR_TIMEOUT_MS,
): ProbeDependencies["doctor"] {
  return ({ provider, workspaceRoot }) =>
    new Promise((resolveReport, reject) => {
      const cwd = executionRuntimeCwd();
      execFile(
        process.execPath,
        [entrypoint, "doctor", "--provider", provider, "--project-root", workspaceRoot],
        {
          cwd,
          env: minimalChildEnvironment(process.env, cwd) as NodeJS.ProcessEnv,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout) => {
          try {
            resolveReport(JSON.parse(stdout) as ProviderDoctorReport);
          } catch {
            reject(
              error?.killed
                ? new Error("provider doctor timed out")
                : (error ?? new Error("provider doctor printed no report")),
            );
          }
        },
      );
    });
}

const DEFAULTS: ProbeDependencies = {
  doctor: cliDoctor(),
  describe: failingDoctorChecks,
  log: (line) => console.error(line),
};

/** Runs the engine's provider doctor once in a child process; never rejects. */
export async function probeProviderHealth(
  provider: string,
  workspaceRoot: string,
  knownRoots: Iterable<string>,
  dependencies: ProbeDependencies = DEFAULTS,
): Promise<ProviderHealth> {
  let detail: string;
  try {
    const report = await dependencies.doctor({ provider, workspaceRoot });
    if (report.success === true) return { provider, ok: true };
    detail = dependencies.describe(report);
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  detail = scrubMessage(sanitizeLogText(detail), knownRoots).slice(0, 500);
  dependencies.log(`operator warning: provider ${provider} is not ready: ${detail}`);
  return { provider, ok: false, detail };
}
