/** Retains exact private run evidence and evaluated changes before disposable workspaces are removed. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  type ExperimentsEvidenceManifestV1,
  type ExperimentsTrialExecutionV1,
  type ExperimentsTrialRecordV1,
  parseContract,
} from "@rae/contracts";
import { minimalChildEnvironment } from "../agents/agent-provider-runtime.js";
import { writeExclusiveFileAtomic } from "../primitives/atomic-file.js";
import { isWithinRoot } from "../primitives/paths.js";
import { canonicalJson } from "../workflow/workflow-contract.js";
import { writeExperimentArtifact } from "./experiment-journal.js";
import { readJsonStrict } from "./state.js";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 20000;
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function repositoryGit(workspace: string, args: string[], input?: string): Buffer {
  const env = minimalChildEnvironment(process.env, workspace, []);
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", workspace, ...args], {
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    maxBuffer: MAX_BYTES,
    timeout: 30000,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

/** Binds the returned worktree and request to this materialized trial repository and task. */
export function assertTrialWorkspace(
  trialRoot: string,
  repository: string,
  workspace: string,
  request: Record<string, unknown>,
  task: string,
): void {
  const root = realpathSync(trialRoot);
  const actual = realpathSync(workspace);
  if (!isWithinRoot(root, actual)) throw new Error("run workspace does not belong to the trial");
  const common = (path: string) =>
    realpathSync(
      resolve(path, repositoryGit(path, ["rev-parse", "--git-common-dir"]).toString("utf8").trim()),
    );
  if (common(repository) !== common(actual) || request.task !== task)
    throw new Error("run evidence does not match the trial repository and task");
}

/** A manifest is written last; partial archives can never authorize cleanup. */
export function retainTrialEvidence(
  output: string,
  start: ExperimentsTrialExecutionV1,
  workspace: string,
  runId: string,
  now: Date,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("invalid evidence run ID");
  const outputRoot = realpathSync(output);
  const archive = join(outputRoot, "evidence", start.trial_id);
  const files: ExperimentsEvidenceManifestV1["files"] = [];
  let bytes = 0;
  const add = (name: string, data: Buffer, executable: boolean): void => {
    bytes += data.length;
    if (bytes > MAX_BYTES || files.length >= MAX_FILES)
      throw new Error("trial evidence exceeds archive limits; workspace retained");
    const path = resolve(archive, name);
    if (!isWithinRoot(archive, path) || path === archive)
      throw new Error("evidence path escapes archive");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Binary content is preserved exactly, but never included in ordinary analysis exports.
    writeExclusiveFileAtomic(path, data);
    files.push({ path: name, sha256: hash(data), bytes: data.length, executable });
  };
  const copy = (source: string, name: string): void => {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error(`non-regular run evidence: ${name}`);
    if (stat.isDirectory()) {
      for (const child of readdirSync(source).sort()) copy(join(source, child), `${name}/${child}`);
    } else {
      if (bytes + stat.size > MAX_BYTES)
        throw new Error("trial evidence exceeds archive limits; workspace retained");
      add(name, readFileSync(source), (stat.mode & 0o111) !== 0);
    }
  };
  const runDir = resolve(workspace, ".pipeline", "runs", runId);
  if (
    !isWithinRoot(realpathSync(workspace), realpathSync(runDir)) ||
    realpathSync(runDir) !== runDir
  )
    throw new Error("run evidence directory is redirected");
  copy(runDir, "run");
  // Read blobs directly: git archive may omit or rewrite files through export attributes.
  const tree = repositoryGit(workspace, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("baseline contains unsupported entries; workspace retained");
      return { mode: match[1], oid: match[2], path: match[3] };
    });
  if (files.length + tree.length > MAX_FILES)
    throw new Error("baseline exceeds archive limits; workspace retained");
  const blobs = repositoryGit(
    workspace,
    ["cat-file", "--batch"],
    tree.map((file) => `${file.oid}\n`).join(""),
  );
  let offset = 0;
  for (const file of tree) {
    const end = blobs.indexOf(10, offset);
    const header = /^([a-f0-9]+) blob (\d+)$/.exec(blobs.subarray(offset, end).toString("utf8"));
    if (end < offset || !header || header[1] !== file.oid)
      throw new Error("invalid baseline object response");
    const size = Number(header[2]);
    offset = end + 1;
    if (!Number.isSafeInteger(size) || offset + size >= blobs.length || blobs[offset + size] !== 10)
      throw new Error("incomplete baseline object response");
    add(`baseline/${file.path}`, blobs.subarray(offset, offset + size), file.mode === "100755");
    offset += size + 1;
  }
  add(
    "changes.patch",
    repositoryGit(workspace, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
      ".",
      ":(exclude).pipeline",
    ]),
    false,
  );
  const untracked = repositoryGit(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of untracked) {
    if (path === ".pipeline" || path.startsWith(".pipeline/")) continue;
    const source = resolve(workspace, path);
    if (!isWithinRoot(workspace, source) || realpathSync(source) !== source)
      throw new Error("untracked result path is redirected");
    copy(source, `untracked/${path}`);
  }
  add(
    "repository.json",
    Buffer.from(
      JSON.stringify({
        head: repositoryGit(workspace, ["rev-parse", "HEAD"]).toString("utf8").trim(),
      }),
    ),
    false,
  );
  const {
    experiment_id,
    experiment_digest,
    suite_digest,
    input_digest,
    trial_id,
    arm_id,
    task_id,
    repetition,
    sequence,
  } = start;
  const manifest = parseContract("experiments/evidence-manifest-v1.schema.json", {
    schema_version: "1.0.0",
    experiment_id,
    experiment_digest,
    suite_digest,
    input_digest,
    trial_id,
    arm_id,
    task_id,
    repetition,
    sequence,
    run_id: runId,
    created_at: now.toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  });
  const path = join(archive, `manifest-${hash(canonicalJson(manifest))}.json`);
  writeExperimentArtifact(path, manifest);
  return relative(outputRoot, path).split("\\").join("/");
}

/** Verifies a retained manifest and every stored byte without reading the original workspace. */
export function verifyTrialEvidence(
  output: string,
  record: ExperimentsTrialRecordV1,
  expectedInputDigest?: string,
): { manifests: number; files: number; bytes: number } {
  const refs = record.evidence_refs.filter((ref) =>
    /^evidence\/.+\/manifest-[a-f0-9]{64}\.json$/.test(ref),
  );
  const result = { manifests: 0, files: 0, bytes: 0 };
  if (refs.length > 1) throw new Error("trial has multiple evidence manifests");
  for (const ref of refs) {
    const expected = `evidence/${record.trial_id}/`;
    if (!ref.startsWith(expected) || ref.slice(expected.length).includes("/"))
      throw new Error("evidence manifest belongs to another trial");
    const path = resolve(realpathSync(output), ref);
    if (!isWithinRoot(realpathSync(output), realpathSync(path)) || realpathSync(path) !== path)
      throw new Error("evidence manifest is redirected");
    const manifest = parseContract(
      "experiments/evidence-manifest-v1.schema.json",
      readJsonStrict(path),
    );
    if (
      !ref.endsWith(`manifest-${hash(canonicalJson(manifest))}.json`) ||
      manifest.trial_id !== record.trial_id ||
      manifest.experiment_digest !== record.experiment_digest ||
      manifest.suite_digest !== record.suite_digest ||
      manifest.run_id !== record.run.run_id ||
      manifest.experiment_id !== record.experiment_id ||
      manifest.arm_id !== record.arm_id ||
      manifest.task_id !== record.task_id ||
      manifest.repetition !== record.repetition ||
      manifest.sequence !== record.sequence ||
      (expectedInputDigest !== undefined && manifest.input_digest !== expectedInputDigest)
    )
      throw new Error("evidence manifest identity or digest mismatch");
    const seen = new Set<string>();
    for (const file of manifest.files) {
      const target = resolve(dirname(path), file.path);
      if (
        seen.has(target) ||
        !isWithinRoot(dirname(path), target) ||
        realpathSync(target) !== target ||
        !lstatSync(target).isFile()
      )
        throw new Error("invalid retained evidence file");
      seen.add(target);
      if (result.bytes + file.bytes > MAX_BYTES || result.files >= MAX_FILES)
        throw new Error("retained evidence exceeds archive limits");
      if (lstatSync(target).size !== file.bytes || hash(readFileSync(target)) !== file.sha256)
        throw new Error(`retained evidence digest mismatch: ${file.path}`);
      result.files++;
      result.bytes += file.bytes;
    }
    result.manifests++;
  }
  return result;
}
