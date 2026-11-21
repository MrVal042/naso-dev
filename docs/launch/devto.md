---
title: Your AGENTS.md is lying to your coding agent. Make the repository check it.
tags: ai, productivity, devtools, opensource
---

Every coding agent session starts the same way: the agent knows nothing about your
repository. So we write it a briefing (AGENTS.md, CLAUDE.md, `.cursor/rules/`) and the
first week it is great.

Then a folder moves. A script is renamed. The team decides to stop using the ORM for
migrations. The briefing still says the old thing, the agent believes it, and nobody notices
until a pull request does something strange.

The problem is not the agent. A briefing is documentation, and documentation is never
re-checked against the code.

## Make the briefing checkable

[NASO](https://github.com/MrVal042/naso-dev) treats the briefing like code:

1. **Generate it from files, not memory.** `npx naso-dev` reads the manifests (package.json,
   pyproject, go.mod, Cargo.toml, Gradle and others, or none), CI, CODEOWNERS,
   CONTRIBUTING and git history, and writes only what those files show. A path in the
   briefing exists. A count was counted. A rule has a source.
2. **Check it like code.** `naso-dev briefing` fails when a path in the briefing no longer
   exists or a quoted line no longer says what the briefing claims. Run it in CI and stale
   briefings fail like broken tests. A pre-commit hook stops staged secrets and adds a line
   when a commit creates a new top-level folder.
3. **Let your agent finish it, with citations.** `naso-dev review` prints a prompt for your
   own coding agent to correct and extend the block, citing a file and line for every change.

## Keep it small

Every token of a briefing is read at the start of every session. In 2.0.0 the block keeps
only what every session needs and links guides for the rest ("when you commit, read
`.naso/guides/workflow.md`"):

| | Before | After |
| --- | ---: | ---: |
| Median of seven public repositories | 1,670 tokens | 849 |
| One team's reviewed briefing | 4,583 tokens | 1,335 |

`npx naso-dev stats` prints the number for your repository.

## Remember between sessions

Three things a session should leave for the next:

- **A handoff**, bounded: one NOW section that is replaced each time, so it never grows into
  a 1,500-line diary, and open items that cannot be dropped by accident.
- **Decisions**, recorded once: `naso-dev decide --title … --source "CONTRIBUTING.md line 12"`.
  The briefing tells every agent to check them before asking.
- **Lessons**: when you correct the agent, `naso-dev lesson` keeps the correction, with why.

## Try it

```bash
npx naso-dev@latest --save-dev
```

It shows the plan and writes nothing until you accept. No dependencies, no network.
[examples/](https://github.com/MrVal042/naso-dev/tree/Dev/examples) has what it writes for
an Expo app, a NestJS API, a Python service, a Go CLI, a Rust library, a Terraform module
and a pnpm monorepo.
