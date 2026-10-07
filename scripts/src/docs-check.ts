#!/usr/bin/env node
/** Check documentation frontmatter, source-of-truth references and relative Markdown links. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";

const requiredKeys = ["status", "owner", "last_reviewed", "source_of_truth", "evidence_links"];
/** Editorial pages own their content; `implementation` names no checkable source and is refused. */
const editorialSource = "editorial";
const linkPatterns = [
  /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  // The outer link of a linked image: `[![alt](image)](page)`.
  /\)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
];

export interface DocsViolation {
  file: string;
  line: number;
  message: string;
}

export interface DocsRecord {
  path: string;
  content: string;
}

interface Entry {
  value: string;
  line: number;
  /** Items of a block (`- item`) or flow (`[a, b]`) list; empty for scalars. */
  items: Array<{ text: string; line: number }>;
}

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

function frontmatter(lines: string[]): { entries: Map<string, Entry>; end: number } | undefined {
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;
  const entries = new Map<string, Entry>();
  let current: Entry | undefined;
  for (let index = 1; index < end; index++) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (match) {
      current = { value: match[2].trim(), line: index + 1, items: [] };
      const flow = /^\[(.*)\]$/.exec(current.value);
      if (flow)
        current.items = flow[1]
          .split(",")
          .map((text) => text.trim())
          .filter(Boolean)
          .map((text) => ({ text, line: index + 1 }));
      entries.set(match[1], current);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(lines[index]);
    if (item && current && current.value === "")
      current.items.push({ text: item[1].trim(), line: index + 1 });
  }
  return { entries, end };
}

type Exists = (path: string) => boolean;

/** A relative link resolves to a file, a directory, or a VitePress page without `.md`. */
function linkResolves(file: string, target: string, exists: Exists): boolean {
  let path = target.split("#")[0].split("?")[0];
  if (path === "") return true;
  try {
    path = decodeURIComponent(path);
  } catch {
    return false;
  }
  const absolute = resolve(repositoryRoot, dirname(file), path);
  const candidates = [absolute, `${absolute}.md`, resolve(absolute, "index.md")];
  if (absolute.endsWith(".html")) candidates.push(absolute.replace(/\.html$/, ".md"));
  return candidates.some((candidate) => exists(candidate));
}

function isRelativeLink(target: string): boolean {
  return !target.startsWith("#") && !target.startsWith("/") && !/^[A-Za-z][\w+.-]*:/.test(target);
}

/** Checks one documentation page; `source` is its full Markdown text. */
export function checkDocsFile(
  file: string,
  source: string,
  exists: Exists = existsSync,
): DocsViolation[] {
  const violations: DocsViolation[] = [];
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  const parsed = frontmatter(lines);
  if (!parsed) violations.push({ file, line: 1, message: "missing YAML frontmatter" });
  else {
    const { entries } = parsed;
    for (const key of requiredKeys) {
      const entry = entries.get(key);
      if (!entry?.value && !entry?.items.length)
        violations.push({ file, line: 1, message: `frontmatter is missing ${key}` });
    }
    const truth = entries.get("source_of_truth");
    const value = truth ? unquote(truth.value) : "";
    if (truth && value && value !== editorialSource) {
      const resolvable =
        value !== "implementation" &&
        (exists(resolve(repositoryRoot, value)) ||
          exists(resolve(repositoryRoot, dirname(file), value)));
      if (!resolvable)
        violations.push({
          file,
          line: truth.line,
          message: `source_of_truth must name an existing repository path, not ${value}`,
        });
    }
    for (const { text, line } of entries.get("evidence_links")?.items ?? []) {
      const path = unquote(text);
      if (!path || !isRelativeLink(path)) continue;
      const fromRoot = exists(resolve(repositoryRoot, path.split("#")[0]));
      if (!fromRoot && !linkResolves(file, path, exists))
        violations.push({ file, line, message: `broken evidence_links entry ${path}` });
    }
  }
  let fence: { char: string; length: number } | undefined;
  for (let index = parsed ? parsed.end + 1 : 0; index < lines.length; index++) {
    const text = lines[index];
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (marker) {
      const char = marker[1][0];
      if (!fence) {
        fence = { char, length: marker[1].length };
        continue;
      }
      if (char === fence.char && marker[1].length >= fence.length && marker[2].trim() === "") {
        fence = undefined;
        continue;
      }
    }
    if (fence) continue;
    const visible = text.replace(/`[^`]*`/g, "");
    const targets: string[] = [];
    for (const pattern of linkPatterns)
      for (const match of visible.matchAll(pattern)) targets.push(match[1]);
    const reference = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*<?([^\s>]+)>?(?:\s+.*)?$/.exec(visible);
    if (reference) targets.push(reference[1]);
    for (const target of targets)
      if (isRelativeLink(target) && !linkResolves(file, target, exists))
        violations.push({ file, line: index + 1, message: `broken relative link ${target}` });
  }
  return violations;
}

/** Pure check over in-memory pages; `exists` decides whether a resolved path is present. */
export function checkDocsRecords(
  records: readonly DocsRecord[],
  exists: Exists = existsSync,
): DocsViolation[] {
  return records.flatMap(({ path, content }) => checkDocsFile(path, content, exists));
}

export function checkDocs(files = repositoryFiles()): DocsViolation[] {
  return checkDocsRecords(
    files
      .filter(
        (file) =>
          file.startsWith("docs/") && file.endsWith(".md") && !file.startsWith("docs/.vitepress/"),
      )
      .map((path) => ({ path, content: readFileSync(resolve(repositoryRoot, path), "utf8") })),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const violations = checkDocs();
    for (const { file, line, message } of violations) console.error(`${file}:${line}: ${message}`);
    if (violations.length > 0) process.exitCode = 1;
    else console.log("Documentation check passed");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
