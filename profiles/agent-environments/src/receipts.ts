/** Quarantine receipts preserve inode evidence through commit, rollback and conflicts. */
import { closeSync, fstatSync, fsyncSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  linkAt,
  openDirectoryAt,
  openParent,
  readDirectory,
  renameAt,
  unlinkAt,
} from "@rae/fs-bridge";
import {
  absent,
  attached,
  code,
  fileState,
  readNamed,
  same,
  writeNoClobber,
  writeRecovery,
  type FileState,
} from "./io.js";
import { holderAlive, processStart } from "./process.js";

export type Hook = (point: string, relative?: string) => void | Promise<void>;
export interface Mutation {
  relative: string;
  expected: FileState;
  replacement: Buffer | null;
}
interface Receipt extends Mutation {
  parent: number;
  name: Buffer;
  oldQuarantine: string | null;
  installed: FileState;
  stage: "pending" | "captured" | "installed";
  retained: string[];
  /** Journals a quarantine name before the rename that creates it. */
  record: (name: string) => void;
}

/** On-disk journal written before the first quarantine rename; a leftover means a crash. */
export const JOURNAL = ".rae-profile-journal.json";
/** Marker-protected directory holding the pre-transaction bytes the journal only digests. */
const SIDECARS = ".rae-profile-journal.d";
const SIDECAR_MARKER = `${SIDECARS}/.marker`;
const SIDECAR_NAME = /^\.rae-profile-journal\.d\/\d{1,4}\.expected$/u;
/** Advisory lock taken while an interrupted transaction is recovered. */
const RECOVERY_LOCK = ".rae-profile-recovery.lock";
const QUARANTINE_NAME = /^\.profile-[0-9a-f-]{36}\.quarantine$/u;
const RECOVERY_PREFIX = ".rae-profile-recovery-";
interface JournalEntry {
  relative: string;
  /** Digest and size of the pre-transaction file (bytes live in the sidecar), or null if absent. */
  expected: { sha256: string; size: number; sidecar: string } | null;
  /** SHA-256 of the bytes this transaction installs, or null when it removes the file. */
  installed: string | null;
  quarantines: string[];
}
interface JournalData {
  version: 2;
  action: string;
  /** Process that owns the transaction; recovery refuses while it is alive. */
  pid: number;
  started: number | null;
  /** `preparing` until every sidecar is durable; nothing live has been touched before `active`. */
  state: "preparing" | "active";
  entries: JournalEntry[];
}
const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
function journalBytes(journal: JournalData): Buffer {
  return Buffer.from(`${JSON.stringify(journal)}\n`);
}
/** Removes the sidecar directory, but only when it carries this module's marker. */
function removeSidecars(root: number): void {
  let directory: number;
  try {
    directory = openDirectoryAt(root, SIDECARS);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  try {
    if (!fileState(root, SIDECAR_MARKER).exists)
      throw new Error(`${SIDECARS} lacks its marker; remove it manually`);
    for (const name of readDirectory(directory)) unlinkAt(directory, name);
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  unlinkAt(root, SIDECARS, true);
  fsyncSync(root);
}
function removeJournal(root: number): void {
  unlinkAt(root, JOURNAL);
  fsyncSync(root);
  try {
    removeSidecars(root);
  } catch {
    /* A leftover sidecar directory is reported by assertNoLeftovers on the next run. */
  }
}

function quarantine(parent: number, name: Buffer, record: (name: string) => void): string | null {
  const temporary = `.profile-${randomUUID()}.quarantine`;
  record(temporary);
  try {
    renameAt(parent, name, parent, temporary);
    fsyncSync(parent);
    return temporary;
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}
function alias(parent: number, from: string, to: Buffer): boolean {
  try {
    linkAt(parent, from, parent, to);
    fsyncSync(parent);
    return true;
  } catch (error) {
    if (code(error) === "EEXIST" || code(error) === "ENOTEMPTY") return false;
    throw error;
  }
}
function liveMatches(receipt: Receipt, expected: FileState): boolean {
  try {
    return same(readNamed(receipt.parent, receipt.name), expected);
  } catch {
    return false;
  }
}
function retain(receipt: Receipt, name: string | null): void {
  if (name && !receipt.retained.includes(name)) receipt.retained.push(name);
}
function preserveCompeting(receipt: Receipt, name: string | null): void {
  if (!name) return;
  alias(receipt.parent, name, receipt.name);
  retain(receipt, name);
}
function recovery(root: number, receipts: Receipt[], conflicts: string[], reason: string): string {
  const directory = `.rae-profile-recovery-${randomUUID().replaceAll("-", "")}`;
  const retained: Array<{ path: string; name: string; parent: { device: number; inode: number } }> =
    [];
  for (const receipt of receipts) {
    if (receipt.expected.exists)
      writeRecovery(root, `${directory}/before/${receipt.relative}`, receipt.expected.data);
    if (receipt.installed.exists)
      writeRecovery(root, `${directory}/installed/${receipt.relative}`, receipt.installed.data);
    for (const [index, name] of [receipt.oldQuarantine, ...receipt.retained]
      .filter((name): name is string => name !== null)
      .entries()) {
      const metadata = fstatSync(receipt.parent);
      retained.push({
        path: receipt.relative,
        name,
        parent: { device: metadata.dev, inode: metadata.ino },
      });
      try {
        const state = readNamed(receipt.parent, name);
        if (state.exists)
          writeRecovery(root, `${directory}/quarantine/${index}/${receipt.relative}`, state.data);
      } catch {
        /* Unsafe entries stay retained in place and are never followed. */
      }
    }
  }
  writeRecovery(
    root,
    `${directory}/RECOVERY.json`,
    Buffer.from(
      JSON.stringify(
        {
          reason,
          conflicts,
          retained_quarantines: retained,
          manual_recovery: "Compare before/, installed/, and quarantine/ before restoring.",
        },
        null,
        2,
      ) + "\n",
    ),
  );
  return directory;
}
async function apply(root: number, receipt: Receipt, action: string, hook: Hook): Promise<void> {
  if (!attached(root, receipt.relative, receipt.parent))
    throw new Error(`Managed parent changed: ${receipt.relative}`);
  await hook(`${action}-before-capture`, receipt.relative);
  if (receipt.expected.exists) {
    receipt.oldQuarantine = quarantine(receipt.parent, receipt.name, receipt.record);
    // A missing expected file belongs to a concurrent actor. Do not resurrect it.
    if (!receipt.oldQuarantine)
      throw new Error(`Managed file changed before mutation: ${receipt.relative}`);
    let actual: FileState;
    try {
      actual = readNamed(receipt.parent, receipt.oldQuarantine);
    } catch (error) {
      // A concurrent symlink or special file still owns its live pathname.
      // Restore only an alias, preserving the captured inode for recovery.
      preserveCompeting(receipt, receipt.oldQuarantine);
      receipt.oldQuarantine = null;
      throw error;
    }
    if (!same(actual, receipt.expected)) {
      preserveCompeting(receipt, receipt.oldQuarantine);
      receipt.oldQuarantine = null;
      throw new Error(`Managed file changed before mutation: ${receipt.relative}`);
    }
  }
  receipt.stage = "captured";
  if (receipt.replacement !== null) {
    await hook(`${action}-before-replacement`, receipt.relative);
    writeNoClobber(receipt.parent, receipt.name, receipt.replacement);
  }
  receipt.stage = "installed";
  await hook(`${action}-after-replacement`, receipt.relative);
  if (!attached(root, receipt.relative, receipt.parent))
    throw new Error(`Managed parent changed: ${receipt.relative}`);
  fsyncSync(receipt.parent);
}
function discardGuarded(receipt: Receipt, quarantineName: string, expected: FileState): boolean {
  if (!liveMatches(receipt, expected)) return false;
  unlinkAt(receipt.parent, quarantineName);
  fsyncSync(receipt.parent);
  return liveMatches(receipt, expected);
}
async function rollbackReceipt(root: number, receipt: Receipt, hook: Hook): Promise<boolean> {
  if (receipt.stage === "pending") return !receipt.oldQuarantine && receipt.retained.length === 0;
  let capture = quarantine(receipt.parent, receipt.name, receipt.record);
  let actual: FileState;
  try {
    actual = capture ? readNamed(receipt.parent, capture) : absent();
  } catch (error) {
    preserveCompeting(receipt, capture);
    throw error;
  }
  const expected = receipt.stage === "installed" ? receipt.installed : absent();
  if (!same(actual, expected) && !actual.exists) {
    const owned = receipt.retained.find((name) => same(readNamed(receipt.parent, name), expected));
    if (owned) {
      capture = owned;
      actual = readNamed(receipt.parent, owned);
      receipt.retained = receipt.retained.filter((name) => name !== owned);
    }
  }
  if (!same(actual, expected)) {
    preserveCompeting(receipt, capture);
    return false;
  }
  if (receipt.expected.exists) {
    if (receipt.oldQuarantine) {
      if (!alias(receipt.parent, receipt.oldQuarantine, receipt.name)) {
        retain(receipt, capture);
        return false;
      }
    } else {
      try {
        writeNoClobber(receipt.parent, receipt.name, receipt.expected.data);
      } catch {
        retain(receipt, capture);
        return false;
      }
    }
    await hook("rollback-after-hardlink-before-quarantine-unlink", receipt.relative);
  }
  if (!liveMatches(receipt, receipt.expected)) {
    retain(receipt, capture);
    return false;
  }
  if (receipt.oldQuarantine) {
    if (!discardGuarded(receipt, receipt.oldQuarantine, receipt.expected)) {
      retain(receipt, capture);
      return false;
    }
    receipt.oldQuarantine = null;
  }
  if (capture && !discardGuarded(receipt, capture, receipt.expected)) {
    retain(receipt, capture);
    return false;
  }
  return attached(root, receipt.relative, receipt.parent);
}
async function commit(
  root: number,
  receipts: Receipt[],
  action: string,
  hook: Hook,
): Promise<void> {
  const captures: Array<{ receipt: Receipt; name: string | null }> = [];
  for (const receipt of receipts) {
    const name = quarantine(receipt.parent, receipt.name, receipt.record);
    let actual: FileState;
    try {
      actual = name ? readNamed(receipt.parent, name) : absent();
    } catch (error) {
      preserveCompeting(receipt, name);
      throw error;
    }
    if (!same(actual, receipt.installed)) {
      preserveCompeting(receipt, name);
      throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
    }
    retain(receipt, name);
    captures.push({ receipt, name });
  }
  for (const { receipt, name } of captures) {
    await hook(`${action}-after-match-before-unlink`, receipt.relative);
    if (name && !alias(receipt.parent, name, receipt.name))
      throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
    if (name)
      await hook(`${action}-commit-after-hardlink-before-quarantine-unlink`, receipt.relative);
    if (
      !attached(root, receipt.relative, receipt.parent) ||
      !liveMatches(receipt, receipt.installed)
    )
      throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
  }
  for (const { receipt, name } of captures) {
    if (name) {
      if (!discardGuarded(receipt, name, receipt.installed))
        throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
      receipt.retained = receipt.retained.filter((value) => value !== name);
    }
    if (receipt.oldQuarantine) {
      if (!discardGuarded(receipt, receipt.oldQuarantine, receipt.installed))
        throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
      receipt.oldQuarantine = null;
    }
  }
}
export async function transact(
  root: number,
  mutations: Mutation[],
  action: "install" | "uninstall",
  hook: Hook = () => {},
): Promise<void> {
  const journal: JournalData = {
    version: 2,
    action,
    pid: process.pid,
    started: processStart(process.pid) ?? null,
    state: "preparing",
    entries: mutations.map((mutation, index) => ({
      relative: mutation.relative,
      expected: mutation.expected.exists
        ? {
            sha256: digest(mutation.expected.data),
            size: mutation.expected.data.length,
            sidecar: `${SIDECARS}/${index}.expected`,
          }
        : null,
      installed: mutation.replacement === null ? null : digest(mutation.replacement),
      quarantines: [],
    })),
  };
  // No-clobber: an existing journal means an interrupted run that must be recovered first.
  writeNoClobber(root, JOURNAL, journalBytes(journal));
  const receipts: Receipt[] = [];
  try {
    // Sidecars are durable before the journal turns active and before any live file is touched.
    writeRecovery(root, SIDECAR_MARKER, Buffer.from("rae-profile-journal sidecars\n"));
    for (const [index, mutation] of mutations.entries())
      if (mutation.expected.exists)
        writeRecovery(root, `${SIDECARS}/${index}.expected`, mutation.expected.data);
    journal.state = "active";
    writeNoClobber(root, JOURNAL, journalBytes(journal), true);
    for (const [index, mutation] of mutations.entries()) {
      if (mutation.relative === ".rae-profile-install.json") await hook(`${action}-after-files`);
      const parent = openParent(root, mutation.relative, mutation.replacement !== null);
      const entry = journal.entries[index];
      const receipt: Receipt = {
        ...mutation,
        parent: parent.fd,
        name: parent.name,
        oldQuarantine: null,
        installed: {
          exists: mutation.replacement !== null,
          data: mutation.replacement ?? Buffer.alloc(0),
        },
        stage: "pending",
        retained: [],
        record: (name) => {
          entry?.quarantines.push(name);
          writeNoClobber(root, JOURNAL, journalBytes(journal), true);
        },
      };
      receipts.push(receipt);
      await apply(root, receipt, action, hook);
    }
    await commit(root, receipts, action, hook);
  } catch (error) {
    const conflicts: string[] = [];
    for (const receipt of [...receipts].reverse()) {
      try {
        if (!(await rollbackReceipt(root, receipt, hook))) conflicts.push(receipt.relative);
      } catch {
        conflicts.push(receipt.relative);
      }
    }
    if (conflicts.length) {
      const retained = recovery(
        root,
        receipts,
        conflicts,
        "concurrent modification prevented rollback",
      );
      removeJournal(root);
      throw new Error(
        `Concurrent edit prevented rollback; recovery retained at ${retained}/RECOVERY.json`,
        { cause: error },
      );
    }
    removeJournal(root);
    throw error;
  } finally {
    for (const receipt of receipts) closeSync(receipt.parent);
  }
  removeJournal(root);
}

function parseJournal(data: Buffer, managed: readonly string[]): JournalData {
  const invalid = (): Error =>
    new Error(`Invalid profile transaction journal ${JOURNAL}; review it manually`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw invalid();
  }
  const journal = value as Partial<JournalData>;
  if (
    journal?.version !== 2 ||
    typeof journal.action !== "string" ||
    !Number.isSafeInteger(journal.pid) ||
    (journal.started !== null && !Number.isSafeInteger(journal.started)) ||
    (journal.state !== "preparing" && journal.state !== "active") ||
    !Array.isArray(journal.entries)
  )
    throw invalid();
  for (const entry of journal.entries as unknown[]) {
    const item = entry as Partial<JournalEntry>;
    const expected = item?.expected;
    if (
      !item ||
      typeof item.relative !== "string" ||
      !managed.includes(item.relative) ||
      (expected !== null &&
        (typeof expected !== "object" ||
          typeof expected.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(expected.sha256) ||
          !Number.isSafeInteger(expected.size) ||
          typeof expected.sidecar !== "string" ||
          !SIDECAR_NAME.test(expected.sidecar))) ||
      (item.installed !== null &&
        (typeof item.installed !== "string" || !/^[a-f0-9]{64}$/u.test(item.installed))) ||
      !Array.isArray(item.quarantines) ||
      !item.quarantines.every((name) => typeof name === "string" && QUARANTINE_NAME.test(name))
    )
      throw invalid();
  }
  return journal as JournalData;
}

/** Reads one entry's pre-transaction bytes from its sidecar and checks them against the journal. */
function loadExpected(root: number, entry: JournalEntry): Buffer | null {
  if (entry.expected === null) return null;
  const state = fileState(root, entry.expected.sidecar);
  if (
    !state.exists ||
    state.data.length !== entry.expected.size ||
    digest(state.data) !== entry.expected.sha256
  )
    throw new Error(
      `Profile transaction sidecar ${entry.expected.sidecar} is missing or does not match ${JOURNAL}; review it manually`,
    );
  return state.data;
}

/**
 * Moves the live entry aside and returns its quarantine name, or null when another actor owns
 * it. The quarantine name is journaled before the rename, so a crash leaves nothing unjournaled.
 */
function captureLive(
  parent: number,
  name: Buffer,
  owned: (state: FileState) => boolean,
  record: (name: string) => void,
): string | null | undefined {
  const temporary = `.profile-${randomUUID()}.quarantine`;
  record(temporary);
  try {
    renameAt(parent, name, parent, temporary);
    fsyncSync(parent);
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
  let state: FileState | undefined;
  try {
    state = readNamed(parent, temporary);
  } catch {
    state = undefined;
  }
  if (state && owned(state)) return temporary;
  // Not ours: put the competing entry back under its live name.
  renameAt(parent, temporary, parent, name);
  fsyncSync(parent);
  return null;
}

/** Restores one journaled path to its pre-transaction bytes; false leaves evidence retained. */
function recoverEntry(
  root: number,
  entry: JournalEntry,
  expectedData: Buffer | null,
  retained: string[],
  persist: () => void,
): boolean {
  let parent: { fd: number; name: Buffer };
  try {
    parent = openParent(root, entry.relative);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    return entry.expected === null;
  }
  try {
    const expected: FileState =
      expectedData === null ? absent() : { exists: true, data: expectedData };
    const installed = (state: FileState): boolean =>
      entry.installed !== null && state.exists && digest(state.data) === entry.installed;
    const ours = (state: FileState): boolean => same(state, expected) || installed(state);
    let live: FileState | undefined;
    try {
      // Live targets use the single-link open; only transaction-owned names may be aliased.
      live = readNamed(parent.fd, parent.name, false);
    } catch {
      live = undefined;
    }
    let clean = true;
    if (!live || !same(live, expected)) {
      const moved =
        live?.exists === false
          ? undefined
          : captureLive(parent.fd, parent.name, installed, (name) => {
              entry.quarantines.push(name);
              persist();
            });
      if (moved === null) {
        // The competing entry went back; the journaled temporary name no longer exists.
        entry.quarantines.pop();
        retained.push(...entry.quarantines);
        return false;
      }
      if (expected.exists) {
        const source = entry.quarantines.find((name) => {
          try {
            return same(readNamed(parent.fd, name), expected);
          } catch {
            return false;
          }
        });
        if (source) {
          renameAt(parent.fd, source, parent.fd, parent.name);
          fsyncSync(parent.fd);
        } else writeNoClobber(parent.fd, parent.name, expected.data);
      }
      try {
        clean = same(readNamed(parent.fd, parent.name, false), expected);
      } catch {
        clean = false;
      }
    }
    // Discard only quarantines holding this transaction's own bytes; keep anything else.
    for (const name of entry.quarantines) {
      let state: FileState;
      try {
        state = readNamed(parent.fd, name);
      } catch {
        retained.push(name);
        clean = false;
        continue;
      }
      if (!state.exists) continue;
      if (ours(state)) {
        unlinkAt(parent.fd, name);
        fsyncSync(parent.fd);
      } else {
        retained.push(name);
        clean = false;
      }
    }
    return clean;
  } finally {
    closeSync(parent.fd);
  }
}

/** Takes the advisory recovery lock, replacing one whose owner is gone. */
function lockRecovery(root: number): () => void {
  const payload = Buffer.from(
    `${JSON.stringify({ pid: process.pid, started: processStart(process.pid) ?? null })}\n`,
  );
  for (let attempt = 0; ; attempt++) {
    try {
      writeNoClobber(root, RECOVERY_LOCK, payload);
      return () => {
        try {
          unlinkAt(root, RECOVERY_LOCK);
          fsyncSync(root);
        } catch {
          /* already gone */
        }
      };
    } catch (error) {
      if (code(error) !== "EEXIST" || attempt > 0) throw error;
    }
    let owner: { pid?: unknown; started?: unknown } = {};
    try {
      owner = JSON.parse(fileState(root, RECOVERY_LOCK).data.toString("utf8")) as typeof owner;
    } catch {
      /* unreadable lock: treat the owner as unknown and fail closed below */
      throw new Error(`Profile recovery lock ${RECOVERY_LOCK} is unreadable; remove it manually`);
    }
    const started = typeof owner.started === "number" ? owner.started : null;
    if (typeof owner.pid !== "number" || holderAlive(owner.pid, started))
      throw new Error(`Another profile recovery is running (lock ${RECOVERY_LOCK})`);
    unlinkAt(root, RECOVERY_LOCK);
  }
}

/**
 * Recovers a transaction interrupted by a crash: every journaled path returns to its
 * pre-transaction bytes. Refuses while the journaled process is alive. Paths changed by another
 * actor are left alone and recorded in a `.rae-profile-recovery-*` directory, which blocks
 * further installs until reviewed.
 */
export function recoverInterrupted(root: number, managed: readonly string[]): boolean {
  const state = fileState(root, JOURNAL);
  if (!state.exists) {
    // A finished transaction whose sidecars outlived its journal.
    removeSidecars(root);
    return false;
  }
  const journal = parseJournal(state.data, managed);
  if (holderAlive(journal.pid, journal.started))
    throw new Error(
      `Profile ${journal.action} is still running (pid ${journal.pid}); wait for it to finish. If that process is gone, remove ${JOURNAL} only after reviewing it`,
    );
  const unlock = lockRecovery(root);
  try {
    if (journal.state === "preparing") {
      // Sidecars were still being written, so no live file was touched.
      removeJournal(root);
      return true;
    }
    const expectedData = journal.entries.map((entry) => loadExpected(root, entry));
    const persist = (): void => writeNoClobber(root, JOURNAL, journalBytes(journal), true);
    const conflicts: string[] = [];
    const retained: string[] = [];
    for (const [index, entry] of [...journal.entries.entries()].reverse()) {
      try {
        if (!recoverEntry(root, entry, expectedData[index] ?? null, retained, persist))
          conflicts.push(entry.relative);
      } catch {
        conflicts.push(entry.relative);
      }
    }
    if (conflicts.length) {
      const directory = `${RECOVERY_PREFIX}${randomUUID().replaceAll("-", "")}`;
      for (const [index, entry] of journal.entries.entries()) {
        const data = expectedData[index];
        if (data && conflicts.includes(entry.relative))
          writeRecovery(root, `${directory}/before/${entry.relative}`, data);
      }
      writeRecovery(
        root,
        `${directory}/RECOVERY.json`,
        Buffer.from(
          `${JSON.stringify(
            {
              reason: `interrupted ${journal.action} could not be fully recovered`,
              conflicts,
              retained_quarantines: retained,
              manual_recovery: "Compare before/ with the live files and retained quarantines.",
            },
            null,
            2,
          )}\n`,
        ),
      );
      removeJournal(root);
      throw new Error(
        `Interrupted profile ${journal.action} left concurrent changes; review ${directory}/RECOVERY.json`,
      );
    }
    removeJournal(root);
    return true;
  } finally {
    unlock();
  }
}

/** Refuses to start while quarantine or recovery evidence from an earlier run remains. */
export function assertNoLeftovers(root: number, managed: readonly string[]): void {
  const found: string[] = [];
  for (const name of readDirectory(root)) {
    const text = name.toString("utf8");
    if (text.startsWith(RECOVERY_PREFIX) || text === JOURNAL || text === SIDECARS) found.push(text);
  }
  const directories = new Set(
    managed.map((path) => path.split("/").slice(0, -1).join("/")).filter(Boolean),
  );
  for (const directory of ["", ...directories]) {
    let fd = root;
    if (directory) {
      try {
        fd = openParent(root, `${directory}/probe`).fd;
      } catch (error) {
        if (code(error) === "ENOENT") continue;
        throw error;
      }
    }
    try {
      for (const name of readDirectory(fd)) {
        const text = name.toString("utf8");
        if (/^\.profile-.*\.quarantine$/u.test(text))
          found.push(directory ? `${directory}/${text}` : text);
      }
    } finally {
      if (fd !== root) closeSync(fd);
    }
  }
  if (found.length)
    throw new Error(
      `Refusing profile operation while earlier quarantine or recovery entries remain: ${found.sort().join(", ")}`,
    );
}
