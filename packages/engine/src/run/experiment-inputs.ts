/** Content identities for experiment inputs, independent of absolute checkout paths. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { workflowsRoot } from "../primitives/installation-paths.js";
import { canonicalJson } from "../workflow/workflow-contract.js";
import { DEFAULT_AUTONOMOUS_POLICY } from "./autonomous-policy.js";
import type { LoadedExperiment, SuiteRepository } from "./experiment-contract.js";

export interface ExperimentInputs {
  digest: string;
  entries: Record<string, string>;
}

export const DEFAULT_EXPERIMENT_WORKFLOW = resolve(
  workflowsRoot,
  "graph-native-default.workflow.json",
);

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash paths, contents and executable bits; ignore only Git metadata, just as materialization does. */
export function experimentTreeDigest(root: string): string {
  const entries: unknown[] = [];
  let bytes = 0;
  const walk = (path: string, name: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`experiment input must be a regular file or directory: ${path}`);
    if (entries.length >= 20000) throw new Error(`experiment input exceeds 20000 entries: ${root}`);
    if (stat.isDirectory()) {
      entries.push([name, "directory"]);
      for (const child of readdirSync(path).sort())
        if (child !== ".git") walk(join(path, child), name ? `${name}/${child}` : child);
    } else {
      bytes += stat.size;
      if (bytes > 256 * 1024 * 1024) throw new Error(`experiment input exceeds 256 MiB: ${root}`);
      entries.push([name, stat.mode & 0o111, digest(readFileSync(path))]);
    }
  };
  if (realpathSync(root) !== resolve(root))
    throw new Error(`experiment input traverses a symlink: ${root}`);
  walk(root, "");
  return digest(canonicalJson(entries));
}

/** Includes implicit workflow/policy defaults so installation changes invalidate execution locks. */
export function fingerprintExperimentInputs(loaded: LoadedExperiment): ExperimentInputs {
  const entries: Record<string, string> = {};
  const repositories = loaded.suite.suite.repositories as Record<string, SuiteRepository>;
  for (const id of [...new Set(loaded.tasks.map((task) => task.repository))].sort()) {
    const repository = repositories[id];
    entries[`repository:${id}`] =
      repository.kind === "directory"
        ? experimentTreeDigest(resolve(loaded.suite.root, repository.path))
        : digest(canonicalJson({ url: repository.url, commit: repository.commit }));
  }
  for (const arm of loaded.experiment.arms) {
    const files = {
      workflow: arm.run.workflow
        ? resolve(loaded.root, arm.run.workflow)
        : DEFAULT_EXPERIMENT_WORKFLOW,
      policy: arm.run.policy ? resolve(loaded.root, arm.run.policy) : DEFAULT_AUTONOMOUS_POLICY,
      ...(arm.run.execution_profile
        ? { execution_profile: resolve(loaded.root, arm.run.execution_profile) }
        : {}),
    };
    for (const [kind, path] of Object.entries(files)) {
      if (!lstatSync(path).isFile() || realpathSync(path) !== path)
        throw new Error(`experiment arm input is not a regular symlink-free file: ${path}`);
      entries[`arm:${arm.arm_id}:${kind}`] = digest(readFileSync(path));
    }
  }
  return { digest: digest(canonicalJson(entries)), entries };
}
