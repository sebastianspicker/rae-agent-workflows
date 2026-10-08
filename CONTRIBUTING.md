# Contributing

RAE is an alpha candidate. Public interfaces may change, and local verification
must not be presented as release evidence.

## Before changing code

- Read `README.md` and the nearest package documentation.
- Confirm which package owns the behavior.
- Inspect the relevant source, schema, and current command output.
- Keep runtime state, local reports, credentials, and machine-specific
  files out of the public tree.
- Preserve unrelated working-tree changes.

Do not commit, push, publish, weaken a safety boundary, or add a production
dependency without maintainer authorization.

## Development setup

Use Node.js 24 or newer, npm, Git, CMake and a C compiler. Install the locked
workspaces and build the native bridge and TypeScript packages:

```sh
npm ci --ignore-scripts
npm run build
npm run rae -- doctor
```

On macOS, install the Xcode command-line tools. On Linux, install CMake, Make
and a C compiler.

`apps/platform/` is outside the root npm workspace. When that package or the
complete repository gate is in scope, install its lock separately:

```bash
npm ci --prefix apps/platform --ignore-scripts
```

## Change workflow

1. Reproduce the issue or establish the current behavior.
2. Make the smallest change that fixes the owning source.
3. Run the narrowest relevant package check.
4. Run the repository verifier.
5. Review `git diff --check`, the complete diff, and untracked files.

Synchronized orchestration adapters must be changed through
`integrations/agent-adapters/content/templates/` and regenerated with:

```bash
npm --workspace @rae/agent-adapters run generate --
npm run check:adapters
```

Task suites and experiment files under `experiments/` are immutable once a
digest has been pinned. Change them by adding a `revision` and pinning the new
digest. Never edit a suite's repository fixture after a retained report used
it.

## Verification

Test sources, fixtures, snapshots, and local test helpers are private and
gitignored. Keep them on disk; do not force-add them or remove their ignore
rules. The test commands below require a maintainer's local test files.

Narrow checks run against the compiled `dist/` output, so build first. Each
workspace suite has a root script named after its package: `test:engine`,
`test:operator`, `test:platform`, `test:ralph`, `test:agent-profiles`,
`test:coauthor-trailer-cleaner`, `test:repository-tools`, `test:dev-tools` and
`test:fs-bridge`. `npm test` runs them in sequence and skips the platform when
its dependencies are not installed. `npm run check:architecture`,
`npm run check:docs` and `npm run check:adapters` run the individual gates.

For a prepared public checkout without private tests:

```bash
npm run verify -- --skip-install --skip-tests
```

Use `npm run verify --` when dependencies still need to be installed.
`--skip-build` reuses an existing build, as CI does after its own build step.
`--skip-tests` omits private local suites and reports `VERDICT: PARTIAL`;
public CI uses it. Omit this option for full local verification.
`--skip-docs` is a partial mode that omits the VitePress documentation build. It does not satisfy the release gate.

Release candidates must run with the private local tests present:

```bash
npm run verify -- --release-candidate
```

Report every skipped or environment-blocked check.

## Documentation

- Put tutorials, how-to guides, reference material, explanations, research, and
  governance pages in their corresponding `docs/` sections.
- Add the required frontmatter to pages under `docs/`.
- Keep command references aligned with `--help` and the owning implementation.
- Document current behavior and current limitations.
- Remove obsolete instructions instead of preserving them in maintained pages.
- Link empirical claims from `docs/reference/claims/claims-ledger.md` to their
  evidence.

Maintained executable files need a concise purpose header. Public or non-obvious
functions should document policy, safety, or lifecycle intent.

## Pull requests

A change is ready for review when:

- its scope and user-visible effect are clear
- verification results and skipped checks are listed
- documentation and examples match the implementation
- synchronized files match their source templates
- the diff contains no local state, private data, or unrelated changes

Use [SECURITY.md](SECURITY.md) for private vulnerability reports. Use
[SUPPORT.md](SUPPORT.md) for usage questions.
