# NASO — Agent Briefing System

**A briefing your coding agent can trust: generated from your repository, checked against it, and short enough to read every session.**

[![npm version](https://img.shields.io/npm/v/naso-dev)](https://www.npmjs.com/package/naso-dev)
[![npm downloads](https://img.shields.io/npm/dm/naso-dev)](https://www.npmjs.com/package/naso-dev)
[![tests](https://github.com/MrVal042/naso-dev/actions/workflows/test.yml/badge.svg)](https://github.com/MrVal042/naso-dev/actions/workflows/test.yml)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license: MIT](https://img.shields.io/npm/l/naso-dev)](LICENSE)

![A real run: npx naso-dev --yes on a Go command-line tool, then npx naso-dev stats](docs/demo/setup.svg)

<sub>A real run on [examples/go-cli](examples/go-cli/AGENTS.md), shortened: `node docs/demo/record.mjs` records it again.</sub>

NASO (Never Assume, Scan Once) reads your repository and writes an `AGENTS.md` briefing in which every path exists, every count was counted and every rule is your repository's own. Then it keeps it true: `naso-dev briefing` checks every claim against the code, a pre-commit gate stops secrets and adds new areas as commits create them, a handoff carries state from one session to the next, and decisions are recorded once so no agent asks again. No dependencies, no network, nothing written before you accept.

## Quick start

```bash
npx naso-dev@latest --save-dev     # read the repository, show the plan, ask, write
npx naso-dev review                # a prompt your coding agent uses to check and correct the briefing
npx naso-dev stats                 # what an agent now loads at session start, in tokens
```

From a script, CI or an agent: `npx naso-dev --yes`. Before you decide: `npx naso-dev --why`. No colour: `NO_COLOR=1` or `--no-color`. Node 20+, git 2.30+, macOS, Linux and Windows.

## Works with

**Claude Code** (`CLAUDE.md` imports the briefing) · **Codex** (reads `AGENTS.md` itself) · **Cursor** · **GitHub Copilot** · **Gemini CLI** · **Windsurf** (`naso-dev agents` writes a one-line pointer in each, never a copy) · any agent, or person, that reads `AGENTS.md`.

Any stack: package.json, pyproject and requirements, go.mod, Cargo.toml, Gemfile, Maven and Gradle, composer.json, pubspec.yaml, or no manifest at all. Any host: GitHub, GitLab, Bitbucket, Azure DevOps, or none.

## Tokens an agent loads at session start

Measured with `npx naso-dev stats` on the same public repositories at the same commits ([docs/benchmarks.md](docs/benchmarks.md) has the method and every row):

| | 1.5.4 | 2.0.0 | Change |
| --- | ---: | ---: | ---: |
| Median of seven repositories (Node monorepo, Python, Go, Rust, Java, Terraform, this one) | 1,670 | **849** | −49% |
| A field repository, as its team reviewed and corrected it | 4,583 | **1,335** | −71% |

The rest of the briefing moved into guides an agent reads only when a task needs one. Every example in [examples/](examples/README.md) (Expo, NestJS, Python, Go, Rust, Terraform, a pnpm monorepo) loads 644 to 966 tokens.

## What you get

- **A briefing that is checked, not written from memory.** `AGENTS.md` between `<!-- naso:start -->` and `<!-- naso:end -->`; everything outside the markers stays yours, byte for byte. `npx naso-dev briefing` checks every path, quote and claim; run it in CI, or let the opt-in Claude Code hook print it at session start. The pre-commit gate refuses staged secrets, checks scope, runs your own format and lint on staged files, and adds a line for a new top-level area.
- **A short root and guides on demand.** About 30 to 45 lines every session reads, and a **When You Touch** table that sends the agent to `.naso/guides/` for conventions, workflow, decisions and each documented area.
- **Rules that are easy to get wrong**, at most ten, each with its source: CODEOWNERS, commitlint, branch patterns, committed env templates, and decisions that state a constraint.
- **A bounded handoff between sessions**: one NOW section, replaced and never appended to, with open items that cannot be dropped by mistake; older history ages into an archive nothing reads at session start. Shared by every worktree.
- **Decisions and lessons, said once.** `naso-dev decide` records who decided what and where; `naso-dev lesson` keeps what a person corrected or confirmed.
- **Opt-in extras:** Claude Code deny rules from CODEOWNERS or `NASO_SCOPE`, session hooks and skills (`naso-dev claude`); pointers for other agents (`naso-dev agents`); a briefing for a folder that holds several repositories (`naso-dev workspace`).

## Documentation

- [docs/reference.md](docs/reference.md) — everything: the setup flow screen by screen, every command and option, what the briefing says and where each line comes from, the gate, decisions, the handoff.
- [docs/benchmarks.md](docs/benchmarks.md) — the token numbers, how they were measured, and how to reproduce them.
- [docs/comparison.md](docs/comparison.md) — NASO beside a hand-written AGENTS.md, Claude Code's `/init`, and other tools.
- [examples/](examples/README.md) — seven small repositories and what NASO wrote for each.
- [tooling/README.md](tooling/README.md) — how the toolset is built, file by file.
- [CHANGELOG.md](CHANGELOG.md) — what changed in each release.

## Author

Created and maintained by **Valentine Asogwa (MrVal)**.

- GitHub: [@MrVal042](https://github.com/MrVal042)
- Email: contactmrval@gmail.com

## Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so the approach can be agreed before the work is done. [docs/good-first-issues.md](docs/good-first-issues.md) lists scoped places to start.

```bash
git clone https://github.com/MrVal042/naso-dev.git && cd naso-dev
npm test
```

There is nothing to install first: NASO has no dependencies, and the tests run on Node's built-in test runner. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Every behavior change needs a test that fails before the fix.

## Contributors

Thanks to everyone who has contributed. See the [contributors graph](https://github.com/MrVal042/naso-dev/graphs/contributors).

## Support

Email: contactmrval@gmail.com

## License

MIT — see [LICENSE](LICENSE).
