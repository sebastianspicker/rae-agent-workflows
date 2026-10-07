#!/usr/bin/env node
/** Verify public source installation, builds, tests, documentation, and runtime entrypoints. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";
import { assertNodeRuntime } from "./node-runtime.js";
import { run, runTestSuites } from "./run-tests.js";
export interface VerificationOptions {
  skipInstall: boolean;
  skipBuild: boolean;
  skipDocs: boolean;
  skipTests: boolean;
  releaseCandidate: boolean;
}
export function parseVerificationOptions(args: readonly string[]): VerificationOptions {
  const allowed = [
    "--skip-install",
    "--skip-build",
    "--skip-docs",
    "--skip-tests",
    "--release-candidate",
  ];
  for (const flag of args)
    if (!allowed.includes(flag)) throw new Error(`Unknown verification option: ${flag}`);
  const options = {
    skipInstall: args.includes("--skip-install"),
    skipBuild: args.includes("--skip-build"),
    skipDocs: args.includes("--skip-docs"),
    skipTests: args.includes("--skip-tests"),
    releaseCandidate: args.includes("--release-candidate"),
  };
  if (
    options.releaseCandidate &&
    (options.skipInstall || options.skipBuild || options.skipDocs || options.skipTests)
  )
    throw new Error("--release-candidate cannot be combined with partial verification modes");
  return options;
}
async function capture(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun(output);
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}
export async function verify(options: VerificationOptions): Promise<void> {
  assertNodeRuntime();
  if (options.releaseCandidate && (await capture("git", ["status", "--porcelain"])).trim())
    throw new Error("release candidate requires a clean Git worktree");
  const npm = async (...args: string[]): Promise<void> => run("npm", args);
  const node = async (path: string, ...args: string[]): Promise<void> =>
    run(process.execPath, [resolve(repositoryRoot, path), ...args]);
  if (!options.skipInstall) {
    await npm("ci", "--ignore-scripts");
    await npm("ci", "--prefix", "apps/platform", "--ignore-scripts");
  }
  const platformInstalled = existsSync(resolve(repositoryRoot, "apps/platform/node_modules"));
  const platformSkipped = options.skipInstall && !platformInstalled;
  if (platformSkipped)
    console.log(
      "SKIPPED apps/platform: dependencies not installed (run: npm ci --prefix apps/platform --ignore-scripts)",
    );
  // CI builds in its own step and passes --skip-build so nothing compiles twice.
  if (!options.skipBuild) {
    await npm("run", "build");
    if (!platformSkipped) await npm("run", "build:platform");
  }
  await npm("run", "typecheck");
  await npm("run", "typecheck:docs");
  if (!platformSkipped) await npm("--prefix", "apps/platform", "run", "typecheck");
  await npm("run", "check:adapters");
  await node(
    "packages/dev-tools/dist/scripts/validate-skills.js",
    "--manifest",
    "integrations/agent-adapters/content/spec/adapter-manifest.json",
  );
  await npm("--workspace", "@rae/contracts", "run", "build:generator");
  await npm("--workspace", "@rae/contracts", "run", "check:generated");
  await npm("run", "lint");
  await npm("run", "check:architecture");
  await npm("run", "check:docs");
  if (options.skipTests) console.log("SKIPPED private local test suites (--skip-tests)");
  else {
    console.log("\n> run workspace test suites");
    await runTestSuites({ skipPlatform: platformSkipped });
  }
  await node("scripts/dist/rae.js", "--help");
  await node("scripts/dist/rae.js", "doctor");
  const temporary = mkdtempSync(join(tmpdir(), "rae-verify-"));
  try {
    const engineTarget = join(temporary, "long-horizon");
    await node("scripts/dist/rae.js", "workflow", "long-horizon", "init", engineTarget);
    if (!existsSync(join(engineTarget, ".pipeline/pipeline-state.json")))
      throw new Error("Workflow bootstrap did not write pipeline-state.json");
    const ralphTarget = join(temporary, "ralph");
    mkdirSync(ralphTarget);
    await node("scripts/dist/rae.js", "workflow", "repo-audit", "bootstrap", ralphTarget);
    if (!existsSync(join(ralphTarget, ".claude/ralph-audit/package.json")))
      throw new Error("Ralph bootstrap did not write package.json");
    await node("scripts/dist/rae.js", "hygiene", "coauthor-cleaner", "--help");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (!options.skipDocs) await npm("run", "docs:build");
  console.log(
    `VERDICT: ${options.skipDocs || options.skipTests || platformSkipped ? "PARTIAL" : "PASS"}`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options: VerificationOptions | undefined;
  try {
    options = parseVerificationOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (options)
    try {
      await verify(options);
    } catch (error) {
      console.error(`VERDICT: FAIL\n${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
}
