# Thread

1/ Your coding agent trusts your AGENTS.md completely. Nobody has checked it since the last
refactor. I built a CLI that generates it from the repository and checks it against the code. 🧵

2/ `npx naso-dev` reads manifests, CI, CODEOWNERS and CONTRIBUTING (any stack, or none) and
writes a briefing where every path exists and every rule has a source. What it cannot
derive, it leaves out.

3/ `naso-dev briefing` checks every path and quote against the code. Put it in CI and a
renamed folder fails the build instead of misleading the next session.

4/ It is layered: a short root every session reads, guides read only when a task needs them.
Median load on seven public repos: 1,670 → 849 tokens. One team's reviewed briefing:
4,583 → 1,335.

5/ Between sessions: a bounded handoff (one NOW section, replaced, never appended), decisions
recorded once with their source, and lessons from your corrections.

6/ Works with Claude Code, Codex, Cursor, Copilot, Gemini CLI and Windsurf. No dependencies,
no network, nothing written until you accept.
github.com/MrVal042/naso-dev
