# Examples

Seven small repositories in different stacks, and what NASO wrote for each. Every file
other than `AGENTS.md`, `CLAUDE.md`, `.naso/guides/` and `.naso/HANDOFF.md` is the repository's own: what a
team would have before running NASO. Open an example's `AGENTS.md` to see the block an
agent reads at the start of every session, and its guides to see what it reads only when a
task needs it.

<!-- examples:start -->
| Example | Tokens at session start | Guides, read when a task needs one |
| --- | ---: | --- |
| [expo-app/](expo-app/AGENTS.md) | 804 | [conventions.md](expo-app/.naso/guides/conventions.md), [decisions.md](expo-app/.naso/guides/decisions.md), [workflow.md](expo-app/.naso/guides/workflow.md) |
| [go-cli/](go-cli/AGENTS.md) | 733 | [conventions.md](go-cli/.naso/guides/conventions.md), [decisions.md](go-cli/.naso/guides/decisions.md), [internal.md](go-cli/.naso/guides/internal.md), [workflow.md](go-cli/.naso/guides/workflow.md) |
| [monorepo/](monorepo/AGENTS.md) | 918 | [conventions.md](monorepo/.naso/guides/conventions.md), [decisions.md](monorepo/.naso/guides/decisions.md), [workflow.md](monorepo/.naso/guides/workflow.md) |
| [nestjs-api/](nestjs-api/AGENTS.md) | 972 | [conventions.md](nestjs-api/.naso/guides/conventions.md), [decisions.md](nestjs-api/.naso/guides/decisions.md), [workflow.md](nestjs-api/.naso/guides/workflow.md) |
| [python-service/](python-service/AGENTS.md) | 749 | [conventions.md](python-service/.naso/guides/conventions.md), [decisions.md](python-service/.naso/guides/decisions.md), [workflow.md](python-service/.naso/guides/workflow.md) |
| [rust-library/](rust-library/AGENTS.md) | 693 | [decisions.md](rust-library/.naso/guides/decisions.md), [workflow.md](rust-library/.naso/guides/workflow.md) |
| [terraform-module/](terraform-module/AGENTS.md) | 644 | [decisions.md](terraform-module/.naso/guides/decisions.md), [workflow.md](terraform-module/.naso/guides/workflow.md) |
<!-- examples:end -->

Tokens are characters divided by four (`npx naso-dev stats`), CLAUDE.md and AGENTS.md
together, with an empty handoff.

The output is generated, never edited by hand. To regenerate it after a change to NASO:

```bash
node examples/build.mjs
```

That copies each example into a scratch git repository, runs
`naso-dev --yes --no-hook --track` there (no network), and copies back what an agent reads.
The toolset in `.naso/tooling/` and the hook are left out: they are the same in every
repository. These are the files as generated, before the `review` step, in which a coding
agent checks the block against the repository's own rules and corrects it.
