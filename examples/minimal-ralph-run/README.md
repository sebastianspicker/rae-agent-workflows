# Minimal Ralph Example

This example shows the smallest useful Ralph path from the umbrella harness.

## Package-local validation

```bash
npm run rae -- ralph --validate-prd
npm run rae -- ralph --status
npm run rae -- ralph --list-stories
```

## Embedded bootstrap for another repository

```bash
mkdir -p /tmp/rae-demo-repo
npm run rae -- workflow repo-audit bootstrap /tmp/rae-demo-repo
cp /tmp/rae-demo-repo/.claude/ralph-audit/prd.json.example /tmp/rae-demo-repo/.claude/ralph-audit/prd.json
(cd /tmp/rae-demo-repo && MODE=audit node .claude/ralph-audit/dist/src/cli.js --check)
```

The bootstrapped install is self-contained Node (`dist/src/cli.js`); there is no
shell wrapper. `--check` needs `codex` on `PATH` and exits non-zero if it is
missing. Run stories from the same directory, for example
`MODE=audit node .claude/ralph-audit/dist/src/cli.js 1`.

This path demonstrates the real deployment model: Ralph is usually embedded
into a target repository and then run there under a repo-specific `prd.json`.
