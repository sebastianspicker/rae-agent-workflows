# Agent Environments

Public, sanitized agent environment layer.

This included public surface is part of the proposed `v0.1.0-alpha.1` public
alpha candidate. Interfaces may change; it is not a published release.

## Current committed surface

- `README.md`
  Explains the boundary of the public profile lane.
- `shared/policy/README.md`
  Records the minimum rule set for safe public extraction.
- `shared/policy/operator-policy.md`
  Ships the generic public operator policy.
- `templates/codex/config.toml`
  Provides a sanitized Codex profile template for RAE-shaped targets.
- `templates/claude/settings.json`
  Provides a sanitized Claude profile template for RAE-shaped targets.
- `src/cli.ts` and `src/profile.ts`
  Implement the Node install/uninstall CLI and manifest orchestration.
- `src/io.ts` and `src/receipts.ts`
  Preserve descriptor-relative no-follow transactions, guarded quarantine,
  hash-verified backups, rollback and retained recovery evidence.

From a built RAE checkout, run `npm run rae -- profile install /canonical/target`
or `npm run rae -- profile uninstall /canonical/target`.

## Publication rule

Only machine-agnostic, sanitized material belongs here. Private overlays,
secrets, host-local hooks, and workstation-specific state stay out of the
public repo until they have been reduced to a reusable public core.

## Support boundary

The published installer is intentionally narrow.

- Supported target: an RAE-shaped repository with a Node verifier and a `package.json` `verify` script
- Unsupported target: a generic empty directory or unrelated repo shape

Install success now means the shipped templates can point at a real target-side
verification entrypoint instead of creating a superficially installed but broken
profile.

Manifest v2 records SHA-256 hashes for every installed target and every original
backup. Both install and uninstall prevalidate the complete operation before
mutation and fail closed for legacy v1 manifests, missing or modified files,
tampered backups, symlinks, and non-regular managed paths. The installer holds
no-follow directory descriptors through the transaction; if a concurrent edit
prevents a guarded rollback, it leaves the competing edit untouched and retains
the original material in `.rae-profile-recovery-*/RECOVERY.json` for manual,
reviewed recovery.

New installs require `scripts/src/verify.ts` or `scripts/dist/verify.js` and a
package verification command. Uninstall still accepts legacy verifier layouts
so existing manifest-v2 receipts remain recoverable. The historical installer
identifier stored in those receipts is unchanged.

## Transaction journal and leftovers

Install and uninstall both run as one transaction in the target root. Before the
first live file is touched the transaction writes `.rae-profile-journal.json`
(format version 2). It records the action, the owning process id and start
time, and, per managed path, the SHA-256 digest and size of the original file,
the digest of the file being installed, and every quarantine name (journaled
before the rename that creates it). The original bytes themselves live in
`.rae-profile-journal.d/<n>.expected`, a directory carrying a `.marker` file;
the installer only deletes that directory when the marker is present. The
journal is removed, then the sidecar directory, when the transaction ends.

If a run crashes, the next install or uninstall recovers it first:

- Recovery refuses while the journaled process is still alive
  (`Profile install is still running (pid N)`); wait for it, or, if the
  process is gone, review and remove the journal by hand. A live pid whose
  start time cannot be compared counts as running.
- Recovery takes an advisory lock file, `.rae-profile-recovery.lock`, so two
  recoveries cannot overlap; a lock whose process is gone is replaced.
- Every journaled path returns to its original bytes. A path that another
  actor changed is left alone and recorded in `.rae-profile-recovery-*/`
  (`RECOVERY.json`, `before/`), and the journal is removed.

Operations refuse to start while any of these remain: `.rae-profile-journal.json`
or `.rae-profile-journal.d` (a journal that could not be recovered or an
interrupted cleanup), `.rae-profile-recovery-*` directories, or
`.profile-*.quarantine` files next to managed paths. Uninstall is affected the
same way as install. To clear them, compare the retained files with the live
ones (`RECOVERY.json` lists the conflicts and quarantines), restore what you
need, then delete the leftover entries by hand and re-run. Do not delete the
journal while its process might still be running.
