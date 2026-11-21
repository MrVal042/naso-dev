---
name: Bug report
about: NASO wrote something wrong, failed, or changed a file it should not have
labels: bug
---

**What happened**

**What you expected**

**How to reproduce**

The smallest repository shape that shows it: the manifest, the folders, the CI file. Leave
out anything private; a made-up name is fine.

```bash
npx naso-dev --version
npx naso-dev doctor
```

Paste both outputs. If a briefing line is wrong, paste that line and the file that
contradicts it.

**Environment**

- OS and shell (macOS / Linux / Windows PowerShell / Git Bash):
- Node (`node --version`):
- Git (`git --version`):
- Package manager, if any:
- Anything unusual about the git layout (worktree, submodule, shallow clone, `core.hooksPath`, husky, lefthook, pre-commit):

Never paste a secret, a `.env` file, or a token. NASO reports secrets by path only; do the same here.
