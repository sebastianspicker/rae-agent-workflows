# Changelog

## Unreleased

### Changed

- `--discard-transaction <id>` is refused once promotion started unless
  `--force` is given; forced discards keep sibling backups in place, list the
  possibly half-promoted live paths, move the journal last and remove the
  pointer last. A pointer whose journal is missing is kept with a warning.
- Journal an `installing` state before each staging-to-live rename, and block
  automatic cleanup after uncertain provider containment.
- Deny `.github/`, `.claude/`, `.codex/`, `.husky/`, `.git/`, agent policy
  files, Git attribute files, `package.json` and lockfiles regardless of story
  scope; reject absolute or escaping promoted symlinks.
- Scan forwarded environment values for credentials, put policy before story
  data in prompts, filter `--import-state` keys, harden stale-lock detection,
  make `--dry-run` lock- and log-free, and support targets outside the Ralph
  package via `RALPH_STATE_DIR` and caller-relative bundles.

## [0.4.0] - 2026-09-07

### Changed

- Add the strict Node.js TypeScript runtime, helper CLI, and compiled test
  runner while retaining the standalone launchers.
- Validate PRDs with JSON Schema, preserve the versioned state fingerprints,
  supervise provider process groups, and confine runtime writes through the
  native filesystem bridge.
- Promote read-only directory roots through identity-bound same-parent staging
  and backup entries with journaled crash recovery.

## [0.3.0] - 2026-07-16

### Changed

- Require Bash 5.3+ and Python 3.14.6+.
- Make Codex CLI the only execution backend.
- Resolve Codex to an absolute executable outside the repository and launch it
  with an exact environment allowlist.
- Supervise Codex with a positive deadline, 15-second graceful shutdown, and
  16 MiB raw-output / 2 MiB report limits.
- Run fixing providers in an external workspace with an immutable baseline,
  identity-bound metadata outside provider-writable temp roots, per-entry
  atomic quarantine and no-clobber installation, retained conflict evidence,
  and path-limited crash recovery with the same no-clobber transitions.
- Check report confinement before creating directories and before replacement.
- Keep `.claude/ralph-audit` as the only embedded discovery location.

### Removed

- Claude backend and documentation.
- `--tool`, `RALPH_TOOL`, tool aliases, `CODEX_TIMEOUT_SECONDS`,
  `RALPH_CAPTURE_CODEX_OUTPUT`, `--skip-security-check`, `CODEX.md` discovery,
  `.codex/ralph-audit` discovery, and `RALPH_FIXING_STATE_METHOD`.

## [0.1.0] - 2026-02-28

- Initial deterministic Ralph loop template.
