/** Purpose: map hosted logical project IDs to private canonical local roots and profiles. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";

const MAX_MAP_BYTES = 64 * 1024;

/** A mapped project; only nodes listed in writeNodes may receive write claims. */
export type ProjectMapEntry = Readonly<{
  root: string;
  profile: string;
  writeNodes: readonly string[];
}>;

/** Validates the immutable file descriptor used for the private project map. */
export function validateProjectMapFileStat(stat: fs.Stats) {
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_MAP_BYTES
  ) {
    throw new Error("project map must be a private owner-only regular file");
  }
}

/** Rejects a project-map file that changed between descriptor checks. */
export function assertStableProjectMapDescriptor(before: fs.Stats, after: fs.Stats) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("project map changed while it was read");
  }
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Reads the node keys this worker lets write; absent means every node is read-only. */
function writeNodeKeys(projectId: string, value: object): readonly string[] {
  if (!("writeNodes" in value) || value.writeNodes === undefined) return Object.freeze([]);
  const nodes = value.writeNodes;
  if (
    !Array.isArray(nodes) ||
    nodes.some((node: unknown) => typeof node !== "string" || !SAFE_ID.test(node))
  )
    throw new Error(`invalid project map entry: ${projectId}`);
  return Object.freeze([...new Set<string>(nodes)]);
}

/** Validates one untrusted TOML descriptor before resolving it on the worker. */
export function validateProjectMapEntry(projectId: string, value: unknown) {
  if (
    !SAFE_ID.test(projectId) ||
    !value ||
    typeof value !== "object" ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    !("profile" in value) ||
    typeof value.profile !== "string" ||
    !path.isAbsolute(value.root) ||
    !path.isAbsolute(value.profile)
  ) {
    throw new Error(`invalid project map entry: ${projectId}`);
  }
  return {
    root: value.root,
    profile: value.profile,
    writeNodes: writeNodeKeys(projectId, value),
  };
}

function canonicalGitRoot(projectId: string, rootPath: string) {
  const root = fs.realpathSync(rootPath);
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: MAX_MAP_BYTES,
  });
  if (probe.status !== 0 || fs.realpathSync(probe.stdout.trim()) !== root) {
    throw new Error(`project ${projectId} root must be a canonical Git top level`);
  }
  return root;
}

export function loadProjectMap(filePath: string) {
  if (!path.isAbsolute(filePath || "")) throw new Error("RAE_PROJECT_MAP_FILE must be absolute");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    validateProjectMapFileStat(before);
    const bytes = Buffer.alloc(MAX_MAP_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(descriptor, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > MAX_MAP_BYTES) throw new Error("project map exceeds byte limit");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    const after = fs.fstatSync(descriptor);
    assertStableProjectMapDescriptor(before, after);
    const parsed = parseToml(source);
    if (!parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects))
      throw new Error("project map must define [projects.<id>] entries");
    const projects = new Map<string, ProjectMapEntry>();
    for (const [projectId, value] of Object.entries(parsed.projects)) {
      const entry = validateProjectMapEntry(projectId, value);
      const root = canonicalGitRoot(projectId, entry.root);
      projects.set(
        projectId,
        Object.freeze({
          root,
          profile: path.resolve(entry.profile),
          writeNodes: entry.writeNodes,
        }),
      );
    }
    return projects;
  } finally {
    fs.closeSync(descriptor);
  }
}
