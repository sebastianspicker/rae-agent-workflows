#!/usr/bin/env node
/** Enforce engine layering and the single public engine entrypoint for applications and Ralph. */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";

/** Lower rank means lower layer; a file may import only from its own rank or below. */
const layerRanks: Record<string, number> = {
  primitives: 0,
  graph: 1,
  agents: 2,
  run: 3,
  workflow: 3,
  cli: 4,
};
const engineSource = "packages/engine/src/";
/** Repository areas the engine must never import, by path prefix and by package name. */
const forbiddenEnginePaths = [
  "apps/",
  "packages/ralph/",
  "packages/dev-tools/",
  "profiles/",
  "tools/",
];
const forbiddenEnginePackages = [
  "@rae/operator",
  "@rae/experimental-platform",
  "@rae/ralph",
  "@rae/dev-tool-verification",
  "@rae/dev-tools-shared",
  "quality-gate-skill",
  "multi-model-review-skill",
  "trace-collector-skill",
  "@rae/agent-profiles",
  "@rae/coauthor-trailer-cleaner",
];
const importPatterns = [
  /\b(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s*from\s*["']([^"'\n]+)["']/g,
  /^\s*import\s+["']([^"'\n]+)["']/gm,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
];

interface ImportReference {
  specifier: string;
  line: number;
}

export interface Violation {
  file: string;
  line: number;
  message: string;
}

function importsOf(source: string): ImportReference[] {
  const references: ImportReference[] = [];
  for (const pattern of importPatterns)
    for (const match of source.matchAll(pattern))
      references.push({
        specifier: match[1],
        line: source.slice(0, match.index).split("\n").length,
      });
  return references.sort((left, right) => left.line - right.line);
}

function repositoryPath(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return relative(repositoryRoot, resolve(repositoryRoot, dirname(file), specifier))
    .split(sep)
    .join("/");
}

function engineLayer(path: string): string {
  return path.slice(engineSource.length).split("/")[0];
}

function packageMatches(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

/** Checks one engine source file against the layer order and the engine's import boundary. */
export function checkEngineFile(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const layer = engineLayer(file);
  const rank = layerRanks[layer];
  if (layer !== "public" && rank === undefined)
    violations.push({ file, line: 1, message: `engine file is outside a known layer (${layer})` });
  for (const { specifier, line } of importsOf(source)) {
    if (forbiddenEnginePackages.some((name) => packageMatches(specifier, name))) {
      violations.push({ file, line, message: `engine must not import ${specifier}` });
      continue;
    }
    const target = repositoryPath(file, specifier);
    if (target === undefined) continue;
    if (forbiddenEnginePaths.some((prefix) => target.startsWith(prefix))) {
      violations.push({ file, line, message: `engine must not import ${target}` });
      continue;
    }
    if (!target.startsWith(engineSource) || layer === "public" || rank === undefined) continue;
    const targetLayer = engineLayer(target);
    const targetRank = layerRanks[targetLayer];
    if (targetRank === undefined || targetRank > rank)
      violations.push({
        file,
        line,
        message: `layer ${layer} must not import ${targetLayer} (${specifier})`,
      });
  }
  return violations;
}

/** Consumers reach the engine only through the `@rae/engine` package root. */
export function checkConsumerFile(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  for (const { specifier, line } of importsOf(source)) {
    if (specifier.startsWith("@rae/engine/"))
      violations.push({ file, line, message: `import @rae/engine instead of ${specifier}` });
    const target = repositoryPath(file, specifier);
    if (target?.startsWith("packages/engine/"))
      violations.push({ file, line, message: `import @rae/engine instead of ${specifier}` });
  }
  return violations;
}

/** Path prefixes of repository code that consumes the engine and may import only its root. */
const consumerPrefixes = [
  "apps/",
  "packages/ralph/src/",
  "packages/dev-tools/",
  "scripts/src/",
  "profiles/",
  "tools/",
];

export interface SourceRecord {
  path: string;
  content: string;
}

/** Pure check over in-memory sources; `path` is repository-relative with forward slashes. */
export function checkSources(sources: readonly SourceRecord[]): Violation[] {
  const violations: Violation[] = [];
  for (const { path, content } of sources) {
    if (!path.endsWith(".ts") || path.split("/").includes("node_modules")) continue;
    const engine = path.startsWith(engineSource);
    const consumer = consumerPrefixes.some((prefix) => path.startsWith(prefix));
    if (!engine && !consumer) continue;
    violations.push(
      ...(engine ? checkEngineFile(path, content) : checkConsumerFile(path, content)),
    );
  }
  return violations;
}

export function checkArchitecture(files = repositoryFiles()): Violation[] {
  const sources: SourceRecord[] = [];
  for (const file of files)
    if (file.endsWith(".ts"))
      sources.push({ path: file, content: readFileSync(resolve(repositoryRoot, file), "utf8") });
  return checkSources(sources);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const violations = checkArchitecture();
    for (const { file, line, message } of violations) console.error(`${file}:${line}: ${message}`);
    if (violations.length > 0) process.exitCode = 1;
    else console.log("Architecture check passed");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
