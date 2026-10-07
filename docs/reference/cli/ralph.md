---
status: experimental
owner: loops
last_reviewed: 2026-10-07
source_of_truth: packages/ralph/src/cli.ts
evidence_links: ../claims/evidence-index.md
---

# Ralph CLI

Ralph is the repository's story-driven audit, linting, and scoped-fixing loop.
The umbrella entrypoint is:

```bash
npm run rae -- ralph --help
```

Common commands:

```bash
npm run rae -- ralph --check
npm run rae -- ralph --mode audit 20
npm run rae -- ralph --mode linting 10
npm run rae -- ralph --mode fixing 5
npm run rae -- ralph --status --status-format json
```

`audit` and `linting` are read-only. `fixing` uses an external workspace,
immutable baseline, private transaction journal, quarantine, and no-clobber
promotion. macOS and Linux provide the required promotion primitive;
unsupported platforms fail closed.

The umbrella CLI targets the Git top level of the calling directory. When
Ralph runs against another repository, it reads `prd.json` and
`INSTRUCTIONS.md` from the calling directory and keeps runtime state in
`<repo>/.runtime/ralph` (override with `RALPH_STATE_DIR`, which must stay inside
the repository).

Preview without side effects:

```bash
npm run rae -- ralph --dry-run 3
```

`--dry-run` takes no run lock, writes no logs, skips archive, branch sync,
model preflight and transaction recovery, and never prints
`<promise>COMPLETE</promise>`.

Retire a stuck fixing transaction. Find its journal id with `--doctor`
(`Pending transaction:`) or in the recovery error, then:

```bash
npm run rae -- ralph --doctor
npm run rae -- ralph --discard-transaction <journal-id>
npm run rae -- ralph --discard-transaction <journal-id> --force
```

The discard prints the evidence paths, then moves the mirror, external
quarantine and journal under `<state dir>/discarded/` and removes the pointer.
It never restores live files. Without `--force` it only accepts a transaction
whose promotion has not started (or that stopped with uncertain provider
containment, which blocks automatic cleanup). With `--force` it also retires a
promoting or conflicted transaction, leaves sibling backups in place in the
live tree, and prints every live path that may be half-promoted. `--force` also
removes a pointer whose journal is missing.

`prd.json` defines stories and acceptance criteria. It is local runtime state.
Use `packages/ralph/prd.json.example` as the public template.

The complete command, environment, runtime-file, recovery, and security
reference is the
[Ralph package README](https://github.com/sebastianspicker/rae-agent-workflows/blob/main/packages/ralph/README.md).

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../claims/bibliography.md#src-nosek-open-research)
