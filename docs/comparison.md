# NASO compared

Ways a team gives a coding agent what it needs to know about a repository, and where NASO
fits among them. Written by NASO's author, so read it with that in mind; corrections are
welcome as issues. What other tools do is described as of November 2026, from their own
documentation; check it before you rely on a detail.

## At a glance

| | Hand-written AGENTS.md | Claude Code `/init` | Rule-sync tools | Repository packers | NASO |
| --- | --- | --- | --- | --- | --- |
| Where the content comes from | A person | The model reads the code once | A person, once, in one place | The whole source tree | Files and git, read by code; then a model reviews it with citations |
| Checked against the repository later | No | No | No | Not applicable | `naso-dev briefing`: paths, quotes, claims; in CI or at session start |
| Grows or rots | Grows as people add to it | Stale after the first refactor | As the source rules do | Regenerated per use | New areas added by the pre-commit hook; a wrong line fails the check |
| Cost at session start | Whatever was written (the field repository's reviewed file: 4,583 tokens) | Not measured here; whatever the model wrote | One copy per agent's file | The whole repository, by design | 644–1,335 tokens in the samples, guides on demand |
| Between sessions | Nothing | Nothing | Nothing | Nothing | Bounded handoff, decisions, lessons |
| Several agents | Copy, or symlink | Claude Code | Copies the rules into each agent's file | Any that takes a file | One AGENTS.md, a one-line pointer per agent |
| Needs | An editor | Claude Code | Its CLI | Its CLI | Node 20, git |

## A hand-written AGENTS.md

The best briefing is the one a person who knows the repository writes and keeps correct.
Nothing generated knows why the team chose the queue it chose or which module everybody is
afraid of.

Where it goes wrong is the second half of that sentence. Nobody re-reads it after a folder
moves, so the agent is told about paths that are gone; and it only grows, so every session
pays for every paragraph ever added. The field repository in
[benchmarks.md](benchmarks.md) is a typical reviewed file: 4,583 tokens, most of it commands
and stack rules an agent needs only for one kind of task.

NASO does not replace what people write. Its block sits between markers in the same file,
anything outside them is never touched, and the `review` step has a coding agent add the
team's own rules into the block with a file and line for each. What NASO adds is the check
(a path that no longer exists fails `naso-dev briefing`, which CI can run) and the layout (detail moves to guides read
when a task needs them).

## Claude Code `/init`

`/init` has Claude read the repository and write a CLAUDE.md. It is fast, needs nothing
installed beyond Claude Code, and its prose is often better than NASO's: a model describing
code reads better than code describing code.

It is one pass by one model. Nothing checks it afterwards, so it rots the way a hand-written
file does, and it can state things that were never true: a plausible command, a folder
role guessed from its name. It is written for Claude Code; other agents need their own copy.

NASO's first pass is deterministic: the same repository gives the same block on any
machine, and a sentence it cannot derive from a file is left out rather than guessed. Its
second pass is a model, through `review`, which must cite a file and line for every change.
If you already have a CLAUDE.md from `/init`, keep it: NASO adds one `@AGENTS.md` line
to it and nothing else, or, when git tracks it and you did not pass `--track`, tells you the
line to add.

## Rule-sync tools

Tools such as Ruler keep the rules in one source and write them into each agent's own
file: CLAUDE.md, `.cursor/rules/`, `.github/copilot-instructions.md` and the rest. They solve
the "five agents, five files" problem well, and some do more than NASO does there (MCP
configuration, for one).

They copy; they do not check. The rules are as true as the person who last edited the
source, and each agent's file carries the full text. NASO points instead of copying: one
AGENTS.md, and a line in each agent's file that sends it there (34 to 57 tokens each). If
you use a rule-sync tool already, point it at AGENTS.md as its source, or let NASO's block
be part of what it copies.

## Repository packers

Tools such as Repomix pack a repository into one file to paste into a model. That is a
different job: giving a model the code itself, once, rather than a briefing it reads at the
start of every session. They are the right tool for asking a question about a whole
codebase in a chat window, and a poor one for a session that will read hundreds of files
on its own anyway.

## Where NASO is weaker

- **Its prose is plain.** Generated sentences say what a file shows and nothing more. The
  `review` step exists because the first pass is accurate but incomplete.
- **It needs Node.** Only NASO's runtime: nothing it writes assumes the repository uses
  Node, but a machine without Node 20 cannot run setup or the hook.
- **Its heuristics have gaps.** A Go `cmd/` folder is described as "role not derivable";
  a monorepo's `packages/` is called application source when it holds libraries. Gaps are
  left out or flagged rather than guessed, and [good-first-issues.md](good-first-issues.md)
  lists several.
- **The extras are Claude Code first.** Deny rules, session hooks and skills are written
  for Claude Code. The core (AGENTS.md, the handoff, decisions, lessons) works with any agent
  or none.
- **It writes files.** A pre-commit hook and a vendored toolset are more than some teams
  want. `--no-hook` skips the hook; without `--track`, nothing NASO writes reaches git.
