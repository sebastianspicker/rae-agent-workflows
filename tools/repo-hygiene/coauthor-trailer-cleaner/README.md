# Coauthor Trailer Cleaner

The compiled TypeScript cleaner removes configured `Co-authored-by: Name <email>`
trailers using Git object plumbing. It preserves trees, ordered parent topology
and byte-exact identity metadata. Message transformation preserves the existing
trailer matching and repeated-blank-line cleanup without decoding message bytes.

The cleaner accepts one or more co-author identities through CLI flags or a
JSON configuration file. Its default target is
`Cursor <cursoragent@cursor.com>`.

## Requirements

- Node.js 24 or newer
- Git with the `reference-transaction` hook capability

Build from the repository root:

```text
npm --prefix tools/repo-hygiene/coauthor-trailer-cleaner run build
```

The cleaner probes Git hook support before changing refs and fails closed if
the attachment guard is unavailable.

## Usage

```text
npm run rae -- hygiene coauthor-cleaner [OPTIONS] [<github_repo_url> <absolute_local_repo_path> ...]
npm run rae -- hygiene coauthor-cleaner [OPTIONS] --repos-file <file>
npm run rae -- hygiene coauthor-cleaner [OPTIONS] --config <config.json>
```

Key options:

- `--apply`: perform the rewrite. Without it the cleaner runs as a dry run
- `--target "Name <email>"`: remove this co-author identity; repeatable
- `--push`: push rewritten history with an exact pre-rewrite upstream OID lease
- `--no-push`: rewrite locally only (default)
- `--dry-run`: walk history and report how many commits and signatures would
  change, without writing objects or moving refs (the default without
  `--apply`)
- `--backup-remote <name>`: push the recovery ref to this remote. The push runs
  only with `--push` or `--allow-backup-push`, and the remote must be a
  configured remote whose push URLs do not point at the repository being
  cleaned (that would republish the original history), unless
  `--allow-backup-push` is passed. The backup holds the original history, so it
  retains the targeted trailers (reported at the end).
- `--allow-backup-push`: allow the backup push without `--push`, and to any
  remote, including the repository being cleaned
- `--delete-recovery-branch`: delete the recovery ref after success, locally
  and on `--backup-remote` (kept by default; the recovery ref name is printed)
- `--validate-only`: validate inputs only
- `--config <file>`: load defaults, targets, and optionally repos from JSON
- `--repos-file <file>`: load `url path` pairs or a JSON array of repos

Accepted repository URLs:

- `https://github.com/<user>/<repo>`
- `git@github.com:<user>/<repo>`
- `ssh://git@github.com/<user>/<repo>`

## Target Configuration

If no targets are provided, the script defaults to:

```json
[
  { "name": "Cursor", "email": "cursoragent@cursor.com" }
]
```

You can override that with repeated CLI flags:

```bash
npm run rae -- hygiene coauthor-cleaner \
  --target "Pair Bot <pairbot@example.com>" \
  --target "Example Contributor <contributor@example.com>" \
  --no-push --apply \
  https://github.com/user/repo /path/to/repo
```

or with a config file (configuration cannot enable rewriting; pass `--apply`,
while `defaults.dryRun: true` forces a dry run even then):

```json
{
  "defaults": {
    "noPush": true
  },
  "targets": [
    { "name": "Pair Bot", "email": "pairbot@example.com" },
    { "name": "Example Contributor", "email": "contributor@example.com" }
  ],
  "repos": [
    { "url": "https://github.com/user/repo", "path": "/path/to/repo" }
  ]
}
```

Schema: [coauthor-trailer-cleaner.schema.json](coauthor-trailer-cleaner.schema.json)
Example: [coauthor-trailer-cleaner.example.json](coauthor-trailer-cleaner.example.json)

## Safety Model

- is a dry run by default; rewriting requires `--apply`, and remote mutation
  additionally requires `--push`
- pushes the recovery backup only with `--allow-backup-push` or when pushing
  is enabled
- rejects detached HEAD
- requires a clean worktree before rewrite
- requires an in-sync tracking branch before push rewrite
- captures the exact upstream commit before rewriting and pushes only with
  `--force-with-lease=<upstream-ref>:<captured-OID>`
- requires an absolute local path
- leaves remote configuration unchanged
- creates a uniquely named recovery ref under
  `refs/coauthor-trailer-cleaner/recovery/<suffix>` for the current run
- lists, after a run, any remaining refs that still contain rewritten commits
- transforms raw commit objects and keeps a private ref pinned to the captured
  original OID; the branch is promoted only by an exact compare-and-swap
- revalidates the branch, HEAD, index, and worktree immediately before the
  recovery/rewrite boundary and before a remote update
- records the rewritten HEAD and refuses automatic rollback if the branch,
  recovery ref, worktree, or index changed during the transaction
- verifies that original and rewritten trees match, then rolls back only the
  branch ref with an exact old/new OID compare-and-swap; it never resets the
  worktree or index
- revalidates local state after a successful push before deleting recovery
  data; concurrent changes retain both recovery and rewritten transaction refs
- deletes the private transaction ref (and the recovery ref only with
  `--delete-recovery-branch`) in one atomic ref transaction that verifies the
  expected OIDs and the rewritten branch OID
- keeps the local recovery ref after success unless `--delete-recovery-branch`
  is passed; it lives outside `refs/heads/`, so branch push globs do not publish
  it. It reaches `--backup-remote` only with `--push` or `--allow-backup-push`;
  remote recovery refs are never wildcard-deleted
- verifies the rewritten messages before the branch compare-and-swap and any push
- supports `--validate-only` for a no-mutation preflight pass

A private prepared-phase Git hook checks the captured HEAD attachment while
Git holds the ref locks. Existing reference-transaction hooks still receive
their phases and input. A concurrent branch switch aborts promotion, rollback
or cleanup and retains recovery refs.

Signatures on changed commits cannot remain valid. The cleaner strips those
invalid signatures, reports their count, and leaves signatures on unchanged
objects intact. Commits whose messages contain no target trailer are never
rewritten, even if they contain repeated blank lines. Unrelated branches,
tags and remote-tracking refs are not rewritten, so any that contain rewritten
commits still expose the original trailers; the cleaner lists them as residual
exposure after the run (the recovery ref is reported separately). Delete or
rewrite them, and expire reflogs, before treating the trailers as removed.

Use an external backup or throwaway clone before rewriting shared history.

## Verification smoke path

```bash
npm run rae -- hygiene coauthor-cleaner --help
```

## Files

- `src/cli.ts`: argument parsing, configuration validation and orchestration
- `src/objects.ts`: byte-preserving message and parent transformation
- `src/git.ts`: object plumbing, leased pushes and recovery transactions
- `src/ref-guard.ts`: prepared-phase HEAD attachment guard
- `coauthor-trailer-cleaner.schema.json`: JSON schema for config files
- `coauthor-trailer-cleaner.example.json`: example config

## License

MIT. See [LICENSE](LICENSE).

Identity deduplication uses the vendored Unicode 16 full case-folding table to
preserve the former Python 3.14 behavior. The first spelling of each identity
still controls raw-byte trailer matching. The table and its license are in
`data/`; its checksum is verified when the CLI loads.
