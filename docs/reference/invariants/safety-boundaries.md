---
status: stable
owner: core
last_reviewed: 2026-10-08
source_of_truth: editorial
evidence_links: ../claims/claims-ledger.md
---

# Safety Boundaries

## Repository boundaries

- public profiles must not ship private overlays or host-specific secrets
- imported modules should remain runnable without absorbing unrelated state from
  neighboring modules
- eval artifacts must not silently mutate source repositories

## Documentation boundaries

- explanation pages must not masquerade as benchmark evidence
- benchmark claims require frozen metadata and provenance
- provisional claims must be labeled as such

## Tooling boundaries

- focused repo-hygiene tools must keep destructive actions explicit
- deterministic loops must constrain write scope and state mutation
- orchestration gates must remain distinct from the artifacts they evaluate
- worktree-backed orchestration runs must record workspace root, primary repo
  root, branch, and cleanup contract in pipeline state and trace artifacts
- isolated orchestration runs must not silently mutate the primary checkout when
  the operator selected worktree-backed execution

## Experiment boundaries

- the experiment runner deletes only `work/<trial_id>` below an output
  directory that carries the `.rae-experiment` marker, through a pure allowlist
  guard with an injectable delete, after verifying retained execution evidence
- acceptance checks and seeded-defect detectors execute agent-written code, so
  they run with the sealed child environment: no provider credentials, proxy
  settings or certificate overrides
- failure excerpts and check details pass through the provider redaction
  filter; logs are owner-readable. Raw execution archives retain exact bytes
  and remain private, outside ordinary analysis exports. Review exported free
  text and paths before sharing
- suite repositories of kind `git` must name an `https://`, `ssh://`, `git://`
  or `user@host:path` remote; local paths and option-like strings are rejected,
  and materialization never inherits `GIT_*` redirection from the caller
- execution locks fingerprint selected input contents and one process owns
  each running experiment; existing outcome records, including failures, are
  retained on resume. Starts and finishes are durable, non-overwriting
  receipts; interrupted or uncertain child execution blocks further dispatch
  until explicitly acknowledged. Unknown usage is never budgeted as zero
- `report` and `export` refuse trial records whose digests or trial identity do
  not match the experiment's plan

## Thesis validation

Safety comes from explicit boundaries on write scope, publication, and
destructive operations, not from informal operator caution. Boundaries can be
tested; habits cannot.

## Related dossiers

- [CLM-017 documentation reliability](../claims/dossiers/clm-017-documentation-reliability.md)

## Interpretation limits

- boundary rules reduce common failure modes but still depend on runtime
  enforcement and review discipline

## Source note

- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Bainbridge automation](../claims/bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../claims/bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../claims/bibliography.md#src-endsley-situation-awareness)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
