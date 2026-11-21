<!-- naso:guide -->
<!-- digest: d8464672cbd9155b -->
# shop — Decisions

Read this when you propose an approach, or before asking the person a question. The NASO block in `AGENTS.md` links it, and `npx naso-dev briefing` checks it with the block. Edit it like the block: say which file proves a correction.

## Decisions

Decisions the team already made are recorded one per file, with who decided and where. No decision is recorded yet; the first one creates the list beside it.

- Before proposing an approach, read the accepted decisions in it that apply to the paths you are changing, and follow them. Do not reopen one unless the person asks to.
- Before asking the person a question, check the list: an accepted decision may already answer it, and a rejected or superseded one says why an option was turned down. Do not offer a turned-down option again without saying it was.
- When the person decides something in a session, record it before the session ends, so the next session, account or agent starts from it: `pnpm dlx naso-dev decide --title "…" --source "…" --decision "…" --why "…"`, with one `--considered "<option> — <why not>"` per option turned down. It is written as proposed, and `decide` refuses a title that is already recorded.
- Never accept, reject or supersede a decision yourself; ask the person. A proposed decision is not binding.
- `pnpm dlx naso-dev decisions audit` lists records that no longer hold. It changes nothing.
