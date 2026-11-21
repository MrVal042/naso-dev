# Show HN

**Title** (80 characters at most):

Show HN: NASO – an AGENTS.md generated from your repo, and a check that keeps it true

**URL:** https://github.com/MrVal042/naso-dev

**First comment:**

I kept watching coding agents start a session by confidently describing folders that had
been renamed months earlier. The AGENTS.md / CLAUDE.md in those repositories had been
correct once. Nobody re-reads a briefing after a refactor.

NASO is a CLI (`npx naso-dev`) that writes the briefing by reading the repository instead
of asking a model to: manifests in any ecosystem, CI files, CODEOWNERS, CONTRIBUTING,
commitlint, git history. Every path it writes is checked to exist, and a sentence it cannot
derive from a file is left out rather than guessed. `naso-dev briefing` then checks every
path, quote and claim against the code, so a stale path fails a CI step instead of
misleading the next session; a pre-commit hook stops staged secrets and adds a line when a
commit creates a new top-level folder. A second step prints a prompt that has your own coding agent
review the block, with a file and line cited for every change.

Things I added after using it daily:

- A layered briefing. Most of a briefing is needed for one kind of task, so the root an
  agent reads every session is short and links guides it reads when the task calls for one.
  On seven public repositories the median load went from 1,670 to 849 tokens; a reviewed
  briefing from one team went from 4,583 to 1,335.
- A handoff between sessions with a hard bound: one NOW section that is replaced, never
  appended to, and open items that survive an agent rewriting it carelessly.
- Decisions recorded once, with who decided and where, so agents stop re-proposing the
  option the team already turned down.
- One-line pointers for Cursor, Copilot, Gemini and Windsurf to AGENTS.md, never copies.

It has no dependencies, needs no network, and writes nothing until you accept the plan it
shows. It works with no package.json at all (Go, Rust, Python, Terraform, docs-only), on
macOS, Linux and Windows.

Where it is weaker: generated prose is plain, and a few heuristics have gaps; the
comparison page says which. I would like to hear where the briefing it writes for your
repository is wrong.
