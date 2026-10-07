/** Git and runtime-namespace invariants for autonomous workflow execution. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import type { BigIntStats, Dirent, Stats } from "node:fs";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import type { BinaryLike } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import { PHASE_ORDER } from "./constants.js";

interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  label?: string;
  allowFailure?: boolean;
}
export interface GitStateSnapshot {
  schema_version: string;
  top_level: string;
  git_directory: string;
  head_ref: string | null;
  head_commit: string;
  head_reflog: string;
  branch_reflog: string | null;
  index: Record<string, string>;
  /** `comparable` is `all` without other runs' `refs/heads/pipeline/*`; absent in older snapshots. */
  refs: { all: string; sensitive: string; comparable?: string };
  /** `safe` digests every non-benign local key and config.worktree; absent in older snapshots. */
  repository_config: { local: string; worktree: string; safe?: string };
  private_info: { exclude: string; attributes: string };
  /** Ignored entries at run start with a recursive metadata digest; absent in older runs. */
  ignored_paths?: Record<string, string>;
}

/**
 * Local config keys that only describe upstream tracking. Every other key, including filters,
 * textconv and merge drivers, pagers, editors, askpass, signing, aliases and hook paths, can
 * change what Git runs or exposes and is therefore safety-relevant.
 */
const BENIGN_CONFIG_KEY = /^(branch\..+\.(merge|remote|rebase|pushremote)|remote\..+\.fetch)$/i;
/** Tracking keys whose value must name a configured remote; any other value can reach a URL. */
const REMOTE_NAMING_KEY = /^branch\..+\.(remote|pushremote)$/i;
const REMOTE_DEFINITION_KEY = /^remote\.(.+)\.(url|pushurl|fetch|push)$/i;
/** Other runs' branches; never part of this run's Git-state comparison. */
const PIPELINE_BRANCH_PREFIX = "refs/heads/pipeline/";
/** Files whose creation or edit changes what Git ignores or how it transforms content. */
const IGNORE_CONTROL_FILES = [".gitignore", ".gitattributes"] as const;
/** Bounds for the recursive fingerprint of ignored directories. */
export interface IgnoredWalkLimits {
  maxEntries: number;
  maxBytes: number;
}
export const DEFAULT_IGNORED_WALK_LIMITS: IgnoredWalkLimits = {
  maxEntries: 20_000,
  maxBytes: 256 * 1024 * 1024,
};

export function requireDirectory(pathValue: string, label: string): string {
  const resolvedPath = realpathSync(resolve(pathValue));
  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`${label} is not a directory: ${pathValue}`);
  }
  return resolvedPath;
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): SpawnSyncReturns<string> {
  const proc = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  assertProcessStarted(proc, command, options);
  assertProcessSucceeded(proc, command, options);
  return proc;
}

export function assertProcessStarted(
  proc: SpawnSyncReturns<string>,
  command: string,
  options: ProcessOptions,
): void {
  if (proc.error)
    throw new Error(`${options.label ?? command} failed to start: ${proc.error.message}`);
}

export function assertProcessSucceeded(
  proc: SpawnSyncReturns<string>,
  command: string,
  options: ProcessOptions,
): void {
  if (proc.status === 0 || options.allowFailure) return;
  const detail = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`.trim().slice(-4000);
  throw new Error(`${options.label ?? command} exited with status ${proc.status}: ${detail}`);
}

export function gitOutput(root: string, args: readonly string[]): string {
  return runProcess("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
    label: `git ${args.join(" ")}`,
  }).stdout;
}

export function sha256(value: BinaryLike): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertGitRepository(root: string): void {
  const topLevel = gitOutput(root, ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(topLevel) !== realpathSync(root)) {
    throw new Error(`project root must be the Git top-level directory: ${topLevel}`);
  }
}

export function reflogDigest(root: string, ref: string): string {
  const output = gitOutput(root, [
    "reflog",
    "show",
    "--no-abbrev",
    "--format=%H%x00%gD%x00%gs",
    ref,
  ]);
  if (!output) {
    throw new Error(
      `Git reflog is required for autonomous safety checks but is unavailable for ${ref}`,
    );
  }
  return sha256(output);
}

export function indexDigests(root: string): Record<string, string> {
  const commands: Array<[string, string[]]> = [
    ["entries", ["ls-files", "-s", "-z"]],
    ["skip_worktree", ["ls-files", "-t", "-z"]],
    ["assume_unchanged", ["ls-files", "-v", "-z"]],
  ];
  return Object.fromEntries(commands.map(([name, args]) => [name, sha256(gitOutput(root, args))]));
}

export function configDigest(root: string, scope: string): string {
  const proc = runProcess("git", ["-C", root, "config", `--${scope}`, "--null", "--list"], {
    label: `git config --${scope} --list`,
    allowFailure: true,
  });
  if (proc.status === 0) return sha256(proc.stdout);
  if (scope === "worktree" && proc.status === 128) return "worktree-config-unavailable";
  throw new Error(`could not inspect ${scope} Git configuration: ${proc.stderr.trim()}`);
}

/** True for local config keys that only describe upstream tracking (see BENIGN_CONFIG_KEY). */
export function benignConfigKey(key: string): boolean {
  return BENIGN_CONFIG_KEY.test(key);
}

/**
 * A benign key is benign for this value: `branch.<n>.remote` and `.pushremote` only count when
 * they name a remote defined in the same config.
 */
function benignConfigEntry(key: string, value: string, remotes: ReadonlySet<string>): boolean {
  if (!benignConfigKey(key)) return false;
  // "." is Git's spelling for a local tracking branch and cannot reach a URL.
  return !REMOTE_NAMING_KEY.test(key) || value === "." || remotes.has(value);
}

function configuredRemotes(entries: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    const match = REMOTE_DEFINITION_KEY.exec(entry.split("\n", 1)[0]);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * Digest of every shared local config entry except the benign tracking keys, plus the
 * worktree-private config file. Unknown keys count as safety-relevant.
 */
export function safeConfigDigest(root: string): string {
  const proc = runProcess("git", ["-C", root, "config", "--local", "--null", "--list"], {
    label: "git config --local --list",
    allowFailure: true,
  });
  if (proc.status !== 0) {
    if (proc.status === 1 || proc.status === 128) return "local-config-unavailable";
    throw new Error(`could not inspect local Git configuration: ${proc.stderr.trim()}`);
  }
  const all = splitNullList(proc.stdout);
  const remotes = configuredRemotes(all);
  const entries = all.filter((entry) => {
    const separator = entry.indexOf("\n");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    return !benignConfigEntry(key, value, remotes);
  });
  return sha256([...entries.sort(), `worktree:${worktreeConfigFileDigest(root)}`].join("\0"));
}

/** `git config --worktree` reads the shared local config unless extensions.worktreeConfig is set. */
function worktreeConfigFileDigest(root: string): string {
  const pathValue = gitOutput(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "config.worktree",
  ]).trim();
  try {
    return sha256(readFileSync(pathValue));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function listIgnoredEntries(root: string): string[] {
  return splitNullList(
    gitOutput(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
    ]),
  ).filter((entry) => entry !== ".pipeline/" && !entry.startsWith(".pipeline/"));
}

/** Identity and content-change metadata of one non-directory entry, without reading content. */
function entryMetadata(pathValue: string, stat: BigIntStats): string {
  if (stat.isSymbolicLink()) return `link:${readlinkSync(pathValue)}`;
  const kind = stat.isFile() ? "file" : "special";
  return `${kind}:${stat.mode}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Digests every entry below an ignored directory by lstat metadata (size, mtime, ctime, inode),
 * so an edit deep inside `node_modules/pkg/index.js` changes the directory fingerprint. The walk
 * stops at `limits.maxEntries` entries or `limits.maxBytes` of file size and marks the
 * fingerprint `tree-truncated`; changes beyond the cap are then not detected.
 */
function ignoredTreeFingerprint(directory: string, limits: IgnoredWalkLimits): string {
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  let truncated = false;
  const visit = (relativePath: string): void => {
    if (truncated) return;
    if (entries >= limits.maxEntries || bytes >= limits.maxBytes) {
      truncated = true;
      return;
    }
    entries++;
    const absolute = relativePath ? resolve(directory, relativePath) : directory;
    let stat: BigIntStats;
    try {
      stat = lstatSync(absolute, { bigint: true });
    } catch {
      hash.update(`${relativePath}\0unreadable\0`);
      return;
    }
    if (!stat.isDirectory()) {
      bytes += Number(stat.size);
      hash.update(`${relativePath}\0${entryMetadata(absolute, stat)}\0`);
      return;
    }
    hash.update(`${relativePath}\0directory:${stat.mode}:${stat.ino}\0`);
    let names: string[];
    try {
      names = readdirSync(absolute).sort();
    } catch {
      hash.update("unreadable\0");
      return;
    }
    for (const name of names) visit(relativePath ? `${relativePath}/${name}` : name);
  };
  visit("");
  return `${truncated ? "tree-truncated" : "tree"}:${hash.digest("hex")}`;
}

function ignoredEntryFingerprint(root: string, entry: string, limits: IgnoredWalkLimits): string {
  const pathValue = resolve(root, entry.replace(/\/$/, ""));
  try {
    const stat = lstatSync(pathValue, { bigint: true });
    return stat.isDirectory()
      ? ignoredTreeFingerprint(pathValue, limits)
      : entryMetadata(pathValue, stat);
  } catch {
    return "unreadable";
  }
}

/** Fingerprints recorded before recursive digests: own size and mtime only. */
function legacyIgnoredFingerprint(root: string, entry: string): string {
  try {
    const stat = lstatSync(resolve(root, entry));
    return stat.isDirectory()
      ? `dir:${Math.trunc(stat.mtimeMs)}`
      : `file:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return "unreadable";
  }
}

/** Current gitignored entries (directories collapsed) with their recursive fingerprints. */
export function ignoredPathFingerprints(
  root: string,
  limits: Partial<IgnoredWalkLimits> = {},
): Record<string, string> {
  const resolved = { ...DEFAULT_IGNORED_WALK_LIMITS, ...limits };
  return Object.fromEntries(
    listIgnoredEntries(root).map((entry) => [
      entry,
      ignoredEntryFingerprint(root, entry, resolved),
    ]),
  );
}

/** Ignored entries added, removed, or modified between two fingerprint maps. */
export function changedIgnoredPaths(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((entry) => before[entry] !== after[entry])
    .sort();
}

/** Ignored entries whose fingerprint stopped at the walk cap. */
export function truncatedIgnoredPaths(fingerprints: Readonly<Record<string, string>>): string[] {
  return Object.keys(fingerprints)
    .filter((entry) => fingerprints[entry]?.startsWith("tree-truncated:"))
    .sort();
}

/** Ignored paths added, removed, or modified since the run baseline. */
export function ignoredPathChanges(
  root: string,
  baseline: GitStateSnapshot,
  limits: Partial<IgnoredWalkLimits> = {},
): string[] {
  const recorded = baseline.ignored_paths;
  if (!recorded) return [];
  const current = ignoredPathFingerprints(root, limits);
  // Older baselines stored own-mtime fingerprints; compare those entries in the same format.
  const comparable = Object.fromEntries(
    Object.entries(current).map(([entry, value]) => [
      entry,
      /^(dir:\d+|file:\d+:\d+)$/.test(recorded[entry] ?? "")
        ? legacyIgnoredFingerprint(root, entry)
        : value,
    ]),
  );
  return changedIgnoredPaths(recorded, comparable);
}

/** True when a path names a `.gitignore` or `.gitattributes` file. */
export function isIgnoreControlFile(pathValue: string): boolean {
  return IGNORE_CONTROL_FILES.some((name) => basename(pathValue) === name);
}

/** True when an ignored directory entry carries its own top-level ignore or attributes file. */
export function ignoredDirectoryHasControlFile(root: string, entry: string): boolean {
  if (!entry.endsWith("/")) return false;
  return IGNORE_CONTROL_FILES.some((name) => existsSync(resolve(root, entry, name)));
}

/**
 * `.gitignore` and `.gitattributes` files that are themselves ignored outside any wholly ignored
 * directory, and so invisible to `--exclude-standard` while able to hide sibling files. Tracked
 * edits already appear in `git diff`; control files inside a wholly ignored directory are covered
 * by that directory's ignored-path fingerprint instead.
 */
export function exposedIgnoredControlFiles(root: string): string[] {
  const collapsed = listIgnoredEntries(root).filter((entry) => entry.endsWith("/"));
  return ignoredControlFiles(root).filter(
    (entry) => !collapsed.some((directory) => entry.startsWith(directory)),
  );
}

/** Every ignored `.gitignore` and `.gitattributes` file in the worktree. */
export function ignoredControlFiles(root: string): string[] {
  return splitNullList(
    gitOutput(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ...IGNORE_CONTROL_FILES.map((name) => `:(glob)**/${name}`),
    ]),
  ).filter(
    (entry) =>
      entry !== ".pipeline" && !entry.startsWith(".pipeline/") && isIgnoreControlFile(entry),
  );
}

/**
 * Sensitive refs are the replace, bisect, rewritten and worktree namespaces, every tag, and every
 * local branch except the run branch, whose own movement the HEAD and reflog checks cover, and
 * the `refs/heads/pipeline/*` namespace, which belongs to other runs.
 */
export function refsSnapshot(
  root: string,
  runBranch: string | null = null,
): { all: string; sensitive: string; comparable: string } {
  const output = gitOutput(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)",
  ]);
  const lines = output.split("\n");
  const refName = (line: string): string => line.split("\0", 1)[0];
  const sensitive = lines
    .filter((line) => {
      const ref = refName(line);
      if (/^refs\/(replace|bisect|rewritten|worktree|tags)\//.test(ref)) return true;
      return (
        ref.startsWith("refs/heads/") &&
        ref !== runBranch &&
        !ref.startsWith(PIPELINE_BRANCH_PREFIX)
      );
    })
    .sort()
    .join("\n");
  const comparable = lines
    .filter((line) => !refName(line).startsWith(PIPELINE_BRANCH_PREFIX))
    .join("\n");
  return { all: sha256(output), sensitive: sha256(sensitive), comparable: sha256(comparable) };
}

export function gitInfoEntrySnapshot(root: string, name: string): string {
  const pathValue = gitOutput(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    `info/${name}`,
  ]).trim();
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(pathValue);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
  if (entry.isSymbolicLink()) {
    return `symlink:${entry.mode}:${readlinkSync(pathValue)}`;
  }
  if (!entry.isFile()) return `special:${entry.mode}`;
  return `file:${entry.mode}:${sha256(readFileSync(pathValue))}`;
}

export function gitPrivateInfoSnapshot(root: string): { exclude: string; attributes: string } {
  return {
    exclude: gitInfoEntrySnapshot(root, "exclude"),
    attributes: gitInfoEntrySnapshot(root, "attributes"),
  };
}

export function gitStateSnapshot(root: string): GitStateSnapshot {
  const topLevel = realpathSync(gitOutput(root, ["rev-parse", "--show-toplevel"]).trim());
  const gitDirectory = realpathSync(gitOutput(root, ["rev-parse", "--absolute-git-dir"]).trim());
  const symbolicHead = runProcess("git", ["-C", root, "symbolic-ref", "-q", "HEAD"], {
    label: "git symbolic-ref -q HEAD",
    allowFailure: true,
  });
  if (symbolicHead.status !== 0 && symbolicHead.status !== 1) {
    throw new Error(`could not determine Git HEAD state: ${symbolicHead.stderr.trim()}`);
  }
  const headRef = symbolicHead.status === 0 ? symbolicHead.stdout.trim() : null;
  return {
    schema_version: "1.4.0",
    top_level: topLevel,
    git_directory: gitDirectory,
    head_ref: headRef,
    head_commit: gitOutput(root, ["rev-parse", "HEAD"]).trim(),
    head_reflog: reflogDigest(root, "HEAD"),
    branch_reflog: headRef ? reflogDigest(root, headRef) : null,
    index: indexDigests(root),
    refs: refsSnapshot(root, headRef),
    repository_config: {
      local: configDigest(root, "local"),
      worktree: configDigest(root, "worktree"),
      safe: safeConfigDigest(root),
    },
    private_info: gitPrivateInfoSnapshot(root),
    ignored_paths: ignoredPathFingerprints(root),
  };
}

/**
 * `full` (initial run preflight) compares every ref except other runs' `refs/heads/pipeline/*`
 * and the whole local and worktree config. `phase` ignores remote-tracking refs and benign
 * upstream-tracking config: it compares sensitive refs (other local branches outside
 * `refs/heads/pipeline/*`, tags, replace and bisect state), HEAD and the run branch reflog, the
 * worktree-private config file, and every other local config key. `resume` is `phase` without the
 * refs comparison: nothing ran during the pause, so user ref activity is legitimate.
 */
export type GitStateScope = "full" | "phase" | "resume";

const REFS_MESSAGE = "Git refs changed outside the run-owned HEAD transition";
const CONFIG_MESSAGE = "Git local or worktree configuration changed";

function scopedValue(
  key: "refs" | "repository_config",
  snapshot: GitStateSnapshot,
  scope: GitStateScope,
  legacySafe: boolean,
  baselineComparable: boolean,
): unknown {
  const config = snapshot.repository_config;
  // Full scope uses only the raw digests, so it also compares snapshots whose derived
  // `sensitive` and `safe` digests were computed by an older rule.
  if (scope === "full") {
    return key === "refs"
      ? baselineComparable
        ? snapshot.refs?.comparable
        : snapshot.refs?.all
      : { local: config?.local, worktree: config?.worktree };
  }
  if (key === "refs") return snapshot.refs?.sensitive;
  return legacySafe ? config : { safe: config?.safe };
}

export function gitStateDifferences(
  baseline: GitStateSnapshot,
  current: GitStateSnapshot,
  scope: GitStateScope = "full",
): string[] {
  // Snapshots from before `safe` existed fall back to the full config comparison.
  const legacySafe = baseline.repository_config?.safe === undefined;
  // Snapshots from before `comparable` existed compare the raw digest of every ref.
  const baselineComparable = baseline.refs?.comparable !== undefined;
  const comparisons: Array<[keyof GitStateSnapshot, string]> = [
    ["top_level", "Git top-level identity changed; repository ownership is no longer trustworthy"],
    [
      "git_directory",
      "Git directory identity changed; repository ownership is no longer trustworthy",
    ],
    ["head_commit", `HEAD commit changed from ${baseline.head_commit} to ${current.head_commit}`],
    ["head_reflog", "worktree HEAD reflog changed; a checkout, commit, or reset occurred"],
    ["branch_reflog", "current branch reflog changed; the run branch moved"],
    ["index", "Git index state changed; this can conceal tracked changes from ownership checks"],
    ["refs", REFS_MESSAGE],
    ["repository_config", CONFIG_MESSAGE],
    ["private_info", "Git private exclude or attributes state changed"],
  ];
  return comparisons.flatMap(([key, message]) => {
    if (key === "refs" && scope === "resume") return [];
    const [left, right] =
      key === "refs" || key === "repository_config"
        ? [
            scopedValue(key, baseline, scope, legacySafe, baselineComparable),
            scopedValue(key, current, scope, legacySafe, baselineComparable),
          ]
        : [baseline[key], current[key]];
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [message];
  });
}

export function changedGitState(
  baseline: GitStateSnapshot,
  current: GitStateSnapshot,
  scope: GitStateScope = "full",
): string[] {
  if (baseline.schema_version !== current.schema_version) {
    return ["Git-state snapshot schema changed; start a new autonomous run"];
  }
  if (baseline.head_ref !== current.head_ref) {
    return [
      `HEAD ref changed from ${baseline.head_ref ?? "detached"} to ${current.head_ref ?? "detached"}`,
      ...gitStateDifferences(baseline, current, scope),
    ];
  }
  return gitStateDifferences(baseline, current, scope);
}

/**
 * Fails the workflow when an in-place phase changes Git state outside its explicitly allowed transition.
 */
export function assertGitStateInvariant(
  root: string,
  baseline: GitStateSnapshot,
  phase: string,
  scope: GitStateScope = "phase",
): void {
  const changes = changedGitState(baseline, gitStateSnapshot(root), scope);
  if (changes.length > 0) {
    throw new Error(
      `prohibited Git-state change after ${phase}: ${changes.join("; ")}. ` +
        "Agents must leave run-owned HEAD/current-branch state, remotes, and index visibility unchanged.",
    );
  }
}

export function refreshResumeRefBaseline(root: string, baseline: GitStateSnapshot): void {
  const current = gitStateSnapshot(root);
  // Refs are not compared: the agent was not running while paused, so user ref activity is
  // legitimate. HEAD, the run branch, the index and safety-relevant config still block.
  const blocking = changedGitState(baseline, current, "resume");
  if (blocking.length > 0) {
    throw new Error(
      `prohibited Git-state change after resume preflight: ${blocking.join("; ")}. ` +
        "Resume requires run-owned HEAD/current-branch state, configuration, and index visibility to be unchanged.",
    );
  }
  // Refs and benign tracking config may have changed legitimately while paused; later per-phase
  // checks compare against the state at resume.
  baseline.refs = current.refs;
  baseline.repository_config = current.repository_config;
}

export function splitNullList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export function untrackedPaths(root: string): string[] {
  const entries = splitNullList(
    gitOutput(root, [
      "ls-files",
      "--others",
      "--directory",
      "--no-empty-directory",
      "--exclude-standard",
      "--exclude=/.pipeline/",
      "-z",
      "--",
    ]),
  );
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry === ".pipeline/" || entry.startsWith(".pipeline/")) continue;
    if (!entry.endsWith("/")) {
      paths.push(entry);
      continue;
    }
    paths.push(
      ...splitNullList(
        gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", entry]),
      ),
    );
  }
  return paths;
}

export function changedPaths(root: string): string[] {
  const paths = new Set<string>([
    ...splitNullList(gitOutput(root, ["diff", "--name-only", "-z", "--relative"])),
    ...splitNullList(gitOutput(root, ["diff", "--cached", "--name-only", "-z", "--relative"])),
    // Ignored files are excluded here so build output and dependencies do not count as changes;
    // ignoredPathChanges() reports new or modified ignored paths separately, and the private
    // exclude file and config keys that decide what is ignored are covered by the Git-state
    // snapshot. Collapse wholly untracked directories first. The sole fixed exclude prunes the
    // runtime-owned .pipeline subtree; that namespace is independently covered by its tamper
    // snapshot.
    ...untrackedPaths(root),
    // A new .gitignore or .gitattributes that hides itself is still an ownership-relevant change.
    ...exposedIgnoredControlFiles(root),
  ]);
  return [...paths]
    .filter((pathValue) => pathValue !== ".pipeline" && !pathValue.startsWith(".pipeline/"))
    .sort();
}

export function runtimeNamespaceSnapshot(
  workspaceRoot: string,
  ignoredRefs: readonly string[] = [],
): Map<string, string> {
  const pipelineRoot = resolve(workspaceRoot, ".pipeline");
  const ignored = new Set<string>(ignoredRefs);
  const snapshot = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathValue = resolve(directory, entry.name);
      const ref = relative(pipelineRoot, pathValue);
      if (ignored.has(ref)) continue;
      const stat = runtimeEntryStat(pathValue);
      if (!stat) continue;
      snapshot.set(ref, runtimeEntryFingerprint(pathValue, entry, stat));
      if (entry.isDirectory()) visit(pathValue);
    }
  };
  visit(pipelineRoot);
  return snapshot;
}

function runtimeEntryStat(pathValue: string): Stats | null {
  try {
    return lstatSync(pathValue);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function runtimeEntryFingerprint(pathValue: string, entry: Dirent, stat: Stats): string {
  if (entry.isDirectory()) return `directory:${stat.mode}`;
  if (entry.isFile()) return `file:${stat.mode}:${sha256(readFileSync(pathValue))}`;
  if (entry.isSymbolicLink()) return `symlink:${stat.mode}:${readlinkSync(pathValue)}`;
  return `special:${stat.mode}`;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateConcurrentOperatorChanges({
  beforeControl,
  afterControl,
  beforeTrace,
  afterTrace,
  runId,
  expectedPhase = null,
}: {
  beforeControl: Record<string, unknown>;
  afterControl: Record<string, unknown>;
  beforeTrace: string;
  afterTrace: string;
  runId: string;
  expectedPhase?: string | null;
}): void {
  validateConcurrentControl(beforeControl, afterControl, runId);
  if (beforeTrace === afterTrace) return;
  if (afterControl.status !== "stop-requested" || afterControl.stop_requested !== true) {
    throw new Error("provider or concurrent process appended a stop trace without stop control");
  }
  if (!afterTrace.startsWith(beforeTrace)) {
    throw new Error("provider or concurrent process rewrote protected trace history");
  }
  for (const line of afterTrace
    .slice(beforeTrace.length)
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)) {
    validateConcurrentTraceEvent(line, runId, expectedPhase);
  }
}

export function validateConcurrentControl(
  beforeControl: Record<string, unknown>,
  afterControl: Record<string, unknown>,
  runId: string,
): void {
  if (sameJson(beforeControl, afterControl)) return;
  const mutable = new Set(["status", "stop_requested", "stop_requested_at", "updated_at"]);
  const unexpected = Object.keys(afterControl).some(
    (key) => !Object.hasOwn(beforeControl, key) && !mutable.has(key),
  );
  const stableChanged = Object.keys(beforeControl).some(
    (key) => !mutable.has(key) && !sameJson(beforeControl[key], afterControl[key]),
  );
  const invalidTimestamp =
    typeof afterControl.stop_requested_at !== "string" ||
    !Number.isFinite(Date.parse(afterControl.stop_requested_at)) ||
    typeof afterControl.updated_at !== "string" ||
    !Number.isFinite(Date.parse(afterControl.updated_at));
  const validTransition = [
    afterControl.run_id === runId,
    afterControl.status === "stop-requested",
    afterControl.stop_requested === true,
    !invalidTimestamp,
    !unexpected,
    !stableChanged,
  ].every(Boolean);
  if (!validTransition) {
    throw new Error("provider or concurrent process made an invalid operator-control transition");
  }
}

export function validateConcurrentTraceEvent(
  line: string,
  runId: string,
  expectedPhase: string | null = null,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("provider or concurrent process appended invalid trace JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("provider or concurrent process appended a non-stop operator trace event");
  const event = parsed as Record<string, unknown>;
  const expectedKeys = ["event", "phase", "run_id", "status", "ts"];
  const validEvent = [
    sameJson(Object.keys(event).sort(), expectedKeys),
    event.event === "run_stop_requested",
    event.run_id === runId,
    event.status === "ok",
    typeof event.phase === "string" &&
      (PHASE_ORDER.some((phase) => phase === event.phase) ||
        (expectedPhase !== null && /^[a-z][a-z0-9._-]{0,63}$/.test(event.phase))),
    expectedPhase === null || event.phase === expectedPhase,
    typeof event.ts === "string" && Number.isFinite(Date.parse(event.ts)),
  ].every(Boolean);
  if (!validEvent) {
    throw new Error("provider or concurrent process appended a non-stop operator trace event");
  }
}

export function assertRuntimeNamespaceInvariant(
  before: ReadonlyMap<string, string>,
  workspaceRoot: string,
  allowedChanges: readonly string[] = [],
): void {
  const after = runtimeNamespaceSnapshot(workspaceRoot, allowedChanges);
  const allowed = new Set<string>(allowedChanges);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((ref) => !allowed.has(ref) && before.get(ref) !== after.get(ref))
    .sort();
  if (changed.length > 0) {
    throw new Error(
      `provider modified protected .pipeline state: ${changed.slice(0, 8).join(", ")}`,
    );
  }
}
