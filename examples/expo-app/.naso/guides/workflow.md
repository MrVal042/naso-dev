<!-- naso:guide -->
<!-- digest: 48d1f648976d3dc6 -->
# field-notes — Workflow

Read this when you start editing, commit, or open a pull request. The NASO block in `AGENTS.md` links it, and `npx naso-dev briefing` checks it with the block. Edit it like the block: say which file proves a correction.

## Scope

Before editing, name the path prefixes the task owns; the pre-commit hook reports
staged paths outside them, and refuses them with `NASO_SCOPE_STRICT=1`:

```bash
export NASO_SCOPE=path/to/area,other/area
```

The hook runs only where setup installed it, in .git/hooks on that machine; CI does not run it,
and a fresh clone has none until someone runs `npx naso-dev refresh` there, which installs it
and, at the version already vendored, changes nothing else. It checks staged files for secret-shaped lines and scope,
and adds a line to the block for a new top-level area; its branch-name check only warns. Its format and lint steps skip here: there is no Prettier config and no ESLint.
It does not type-check, run tests or read the commit message. If .naso/tooling/ is missing it
prints one line and lets the commit through.

## Commit Standard

- Do not bypass the pre-commit hook. Fix what it reports and commit again.
- When a commit adds a genuinely new area, the hook appends one line for it
  to the block in AGENTS.md and stages it with the commit. AGENTS.md and .naso/guides/
  are tracked, so they are reviewed like any other file: if the hook reports
  AGENTS.md unstaged, that is a finding to fix.
