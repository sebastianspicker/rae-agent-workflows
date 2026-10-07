/** Creates a new file atomically: no reader ever sees a partial file and nothing is overwritten. */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** Drops the temporary name; one that is already gone must not mask the link error. */
function removeTemporary(temporary: string): void {
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Makes a new directory entry durable where the platform can fsync a directory. */
function syncDirectory(directory: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(directory, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!["EISDIR", "EPERM", "EINVAL"].includes(String(errorCode(error)))) throw error;
  } finally {
    closeSync(descriptor);
  }
}

/** Exclusive but non-atomic create for filesystems without hard links; readers may see a prefix. */
function writeExclusiveFileDirect(pathValue: string, content: string): void {
  const descriptor = openSync(pathValue, "wx", 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Writes `content` to a temporary sibling, syncs it, then hard-links it to `pathValue` and
 * removes the temporary name. The link fails with EEXIST when `pathValue` exists, which keeps the
 * no-overwrite guarantee of an exclusive create. Where the filesystem cannot hard-link (EPERM,
 * ENOTSUP, EXDEV) the file is created exclusively in place instead, without the atomic guarantee.
 */
export function writeExclusiveFileAtomic(pathValue: string, content: string): void {
  const directory = dirname(pathValue);
  const temporary = resolve(
    directory,
    `.${basename(pathValue)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, pathValue);
    } catch (error) {
      if (!["EPERM", "ENOTSUP", "EXDEV"].includes(String(errorCode(error)))) throw error;
      writeExclusiveFileDirect(pathValue, content);
    }
    syncDirectory(directory);
  } finally {
    removeTemporary(temporary);
  }
}
