#!/usr/bin/env node
/** Copy the built VitePress site into the Pages demo output under `.runtime/operator-demo/docs`. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";

/** Every directory on the write path must be a real directory so the copy stays under `.runtime/`. */
function assertRealDirectory(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isDirectory())
    throw new Error(`${path} must be an existing, non-symlinked directory`);
}

/** Written into every copy this script creates; only a marked directory may be replaced. */
export const docsMarker = ".rae-docs-copy";

/** Removes a previous copy, but only a real marker-protected directory below `.runtime/`. */
function removePreviousCopy(docsDirectory: string): void {
  const entry = lstatSync(docsDirectory, { throwIfNoEntry: false });
  if (!entry) return;
  const marker = lstatSync(resolve(docsDirectory, docsMarker), { throwIfNoEntry: false });
  if (!entry.isDirectory() || !marker?.isFile())
    throw new Error(
      `${docsDirectory} already exists and is not a copy made by this script (missing ${docsMarker}); remove it manually`,
    );
  rmSync(docsDirectory, { recursive: true });
}

/** The root argument lets tests exercise the fixed Pages layout in a disposable repository. */
export function copyDocsSite(root = repositoryRoot): string {
  const siteDirectory = resolve(root, "site");
  const runtimeDirectory = resolve(root, ".runtime");
  const demoDirectory = resolve(runtimeDirectory, "operator-demo");
  const docsDirectory = resolve(demoDirectory, "docs");
  if (!existsSync(resolve(siteDirectory, "index.html")))
    throw new Error("VitePress output missing; run npm run docs:build first");
  assertRealDirectory(runtimeDirectory);
  assertRealDirectory(demoDirectory);
  removePreviousCopy(docsDirectory);
  mkdirSync(docsDirectory, { recursive: false });
  assertRealDirectory(docsDirectory);
  writeFileSync(resolve(docsDirectory, docsMarker), "");
  for (const entry of readdirSync(siteDirectory))
    cpSync(resolve(siteDirectory, entry), resolve(docsDirectory, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  return docsDirectory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`Copied documentation site to ${copyDocsSite()}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
