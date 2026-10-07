/** Builds the static, browser-only operator demo for a GitHub Pages subpath. */

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const operatorDirectory = resolve(scriptDirectory, "..");
const sourceOperatorDirectory =
  basename(operatorDirectory) === "dist" ? resolve(operatorDirectory, "..") : operatorDirectory;
const repositoryRoot = resolve(sourceOperatorDirectory, "..", "..");
const staticDirectory = resolve(operatorDirectory, "static");
const demoDirectory = resolve(operatorDirectory, "demo");
const screenshotsDirectory = resolve(sourceOperatorDirectory, "docs", "screenshots");
const defaultOutput = resolve(tmpdir(), "rae-operator-pages-demo");
/** Written into every output directory buildDemo creates; an existing directory needs it. */
export const demoMarker = ".rae-operator-demo";
const refusal = "demo output must be a dedicated directory outside the operator source";

function parseOutput(argv: string[]): string {
  if (argv.length === 0) return defaultOutput;
  if (argv.length === 2 && argv[0] === "--out" && argv[1] !== "") return resolve(argv[1]);
  throw new Error("usage: build-demo.mjs [--out <directory>]");
}

/** A path split into its deepest existing ancestor (by real path) and the missing segments. */
interface Anchored {
  existing: string;
  missing: string[];
}

function anchor(path: string): Anchored {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return { existing: realpathSync.native(current), missing };
}

function sameEntry(left: string, right: string): boolean {
  const a = statSync(left, { bigint: true });
  const b = statSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Relates two paths by walking the (dev, ino) identity of real ancestors rather than comparing
 * strings, so symlinked and case-insensitive spellings of the same directory are recognized.
 */
function relation(parentPath: string, childPath: string): "equal" | "inside" | "none" {
  const parent = anchor(parentPath);
  const child = anchor(childPath);
  if (parent.missing.length > 0) {
    // A missing parent can only contain paths that share its existing anchor and missing prefix.
    if (!sameEntry(parent.existing, child.existing)) return "none";
    if (parent.missing.some((segment, index) => child.missing[index] !== segment)) return "none";
    return child.missing.length === parent.missing.length ? "equal" : "inside";
  }
  let current = child.existing;
  let depth = child.missing.length;
  for (;;) {
    if (sameEntry(parent.existing, current)) return depth === 0 ? "equal" : "inside";
    const next = dirname(current);
    if (next === current) return "none";
    current = next;
    depth += 1;
  }
}

/**
 * The output directory is deleted before the build, so it must be a dedicated location. Allowed:
 * a strict descendant of the real temporary directory or of `<repo>/.runtime/`; an existing
 * output must be a real directory carrying the demo marker. Independently, the filesystem root,
 * home directories, the working directory, the repository, its ancestors and the operator
 * source and compiled trees are refused. Exported as a pure check so tests never invoke the delete.
 */
export function assertSafeOutput(outputDirectory: string): void {
  if (!isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory)
    throw new Error(refusal);
  const runtimeRoot = resolve(repositoryRoot, ".runtime");
  const runtimeEntry = lstatSync(runtimeRoot, { throwIfNoEntry: false });
  if (runtimeEntry && !runtimeEntry.isDirectory()) throw new Error(refusal);
  const allowedRoots = [realpathSync.native(tmpdir()), runtimeRoot];
  if (!allowedRoots.some((root) => relation(root, outputDirectory) === "inside"))
    throw new Error(refusal);
  const protectedAncestors = [
    resolve("/"),
    homedir(),
    userInfo().homedir,
    process.cwd(),
    repositoryRoot,
  ];
  if (protectedAncestors.some((path) => relation(outputDirectory, path) !== "none"))
    throw new Error(refusal);
  const operatorTrees = [
    sourceOperatorDirectory,
    resolve(sourceOperatorDirectory, "dist"),
    operatorDirectory,
  ];
  if (
    operatorTrees.some(
      (tree) =>
        relation(outputDirectory, tree) !== "none" || relation(tree, outputDirectory) !== "none",
    )
  )
    throw new Error(refusal);
  const entry = lstatSync(outputDirectory, { throwIfNoEntry: false });
  const marker = lstatSync(resolve(outputDirectory, demoMarker), { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || !marker?.isFile()))
    throw new Error(`${refusal}; an existing output must contain ${demoMarker}`);
}

function pagesIndex(source: string): string {
  return source
    .replace('href="/favicon.svg"', 'href="./favicon.svg"')
    .replace('href="/styles.css"', 'href="./styles.css"')
    .replace('src="/app.js"', 'src="./demo/bootstrap.js"')
    .replace(
      "and no live or publish controls.",
      'and no live or publish controls. <a href="./demo/tour.html">Open the screenshot tour</a>.',
    );
}

/** Copies the real static assets and injects only the mock bootstrap for Pages. */
export async function buildDemo(
  outputDirectory = defaultOutput,
  { remove = rm }: { remove?: typeof rm } = {},
): Promise<string> {
  const output = resolve(outputDirectory);
  assertSafeOutput(output);
  // Only reached for an allowlisted output that is unborn or already carries the demo marker.
  await remove(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, demoMarker), "");
  await cp(staticDirectory, output, { recursive: true });
  await cp(demoDirectory, resolve(output, "demo"), { recursive: true });
  await cp(screenshotsDirectory, resolve(output, "demo", "screenshots"), { recursive: true });
  const bootstrapPath = resolve(output, "demo", "bootstrap.js");
  await writeFile(
    bootstrapPath,
    (await readFile(bootstrapPath, "utf8")).replaceAll("../static/", "../"),
  );
  await writeFile(
    resolve(output, "index.html"),
    pagesIndex(await readFile(resolve(staticDirectory, "index.html"), "utf8")),
  );
  await writeFile(resolve(output, ".nojekyll"), "");
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildDemo(parseOutput(process.argv.slice(2)));
  process.stdout.write(`Built browser-only operator demo in ${output}\n`);
}
