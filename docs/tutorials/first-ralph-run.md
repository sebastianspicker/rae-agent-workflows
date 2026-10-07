---
status: stable
owner: loops
last_reviewed: 2026-10-07
source_of_truth: packages/ralph/README.md
evidence_links: ../reference/claims/evidence-index.md
---

# First Ralph Run

This is the minimum local Ralph `0.4.0` path. Ralph is Codex-only: `audit` and
`linting` are read-only, while `fixing` applies one story through a recoverable
filesystem transaction.

## Assumptions

- you are inside the Git repository Ralph should inspect; `rae ralph` resolves
  its top level with `git rev-parse --show-toplevel`
- the Ralph package has a `prd.json` (copy `packages/ralph/prd.json.example`)
- Node.js 24+, the compiled RAE packages, and the Codex CLI are available
- you only want to validate the loop surface first

## 1. Validate the PRD

```bash
npm run rae -- ralph --validate-prd
```

## 2. Inspect current state

```bash
npm run rae -- ralph --status
npm run rae -- ralph --list-stories
```

Preview the next stories without invoking Codex or changing anything. A dry
run takes no lock and writes no logs:

```bash
npm run rae -- ralph --dry-run 3
```

## 3. Run a small audit batch

```bash
MODE=audit npm run rae -- ralph 1
```

Runtime state and logs are kept under `<repository>/.runtime/ralph`; set
`RALPH_STATE_DIR` to choose another location. Codex execution uses a positive
deadline, a 15-second graceful shutdown, and bounded output (16 MiB raw output
and 2 MiB final report). Try `MODE=fixing` only after reviewing the selected
story and transaction boundary. If a fixing run is interrupted, `--doctor`
lists its transaction journal; `--discard-transaction <journal-id>` discards
it, and journals past the `prepared` state also require `--force`.

## 4. Run repository verification

```bash
npm run verify -- --skip-install
```

## 5. Bootstrap the embedded template into another repo

```bash
mkdir -p /tmp/rae-demo-repo
npm run rae -- workflow repo-audit bootstrap /tmp/rae-demo-repo
```

## What this demonstrates

- deterministic story selection
- explicit mode control
- state-aware loop execution
- regression-backed safety behavior

## Thesis validation

This is the smallest useful Ralph loop: one bounded story, selected
deterministically and confined to an approved path.

## Interpretation limits

- tutorial success does not substitute for frozen benchmark evidence

## Source note

- [Amdahl 1967](../reference/claims/bibliography.md#src-amdahl-1967)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
