#!/usr/bin/env node
/** Run every workspace test suite sequentially and stop at the first failing suite. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";
import { assertNodeRuntime } from "./node-runtime.js";

const suites = [
  "@rae/engine",
  "@rae/operator",
  "apps/platform",
  "@rae/ralph",
  "@rae/agent-profiles",
  "@rae/coauthor-trailer-cleaner",
  "@rae/repository-tools",
  "@rae/dev-tool-verification",
  "@rae/fs-bridge",
] as const;

export interface TestSuiteOptions {
  /** Skip the separately installed platform even when its dependencies are present. */
  skipPlatform?: boolean;
}

export interface SuitePlan {
  /** Suites to run, in order. */
  run: string[];
  /** Why the platform suite is skipped, when it is. */
  skipped?: string;
}

/** Pure suite-list decision: the platform runs only when requested and installed. */
export function planSuites(options: TestSuiteOptions, platformInstalled: boolean): SuitePlan {
  if (options.skipPlatform || !platformInstalled)
    return {
      run: suites.filter((suite) => suite !== "apps/platform"),
      skipped: options.skipPlatform
        ? "SKIPPED apps/platform: excluded by the caller"
        : "SKIPPED apps/platform: dependencies not installed (run: npm ci --prefix apps/platform --ignore-scripts)",
    };
  return { run: [...suites] };
}

/** Runs a command with inherited stdio, forwarding SIGINT/SIGTERM to the child until it exits. */
export async function run(command: string, args: string[], cwd = repositoryRoot): Promise<void> {
  console.log(`\n> ${command === process.execPath ? "node" : command} ${args.join(" ")}`);
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const onInterrupt = (): void => {
      child.kill("SIGINT");
    };
    const onTerminate = (): void => {
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const cleanup = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

/** Returns true when the platform suite was skipped, so callers can report a partial result. */
export async function runTestSuites(options: TestSuiteOptions = {}): Promise<boolean> {
  assertNodeRuntime();
  const plan = planSuites(
    options,
    existsSync(resolve(repositoryRoot, "apps/platform/node_modules")),
  );
  if (plan.skipped) console.log(plan.skipped);
  for (const suite of plan.run) {
    const args =
      suite === "apps/platform"
        ? ["--prefix", "apps/platform", "test"]
        : ["run", "test", "--workspace", suite];
    try {
      await run("npm", args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${suite} tests failed: ${reason}`);
    }
  }
  return plan.skipped !== undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const skipped = await runTestSuites();
    if (skipped) console.log("TESTS: PARTIAL (platform skipped)");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
