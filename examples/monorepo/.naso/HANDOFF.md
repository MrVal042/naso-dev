# Handoff

What the last session left for the next one. Read NOW at the start of a session; read the
log only when you need the history.

- NOW is one current state, replaced whole with `pnpm dlx naso-dev handoff set`: where things stand, the
  next steps, and the open items. Write an open item as `- [ ] …` or `- Waiting on <who>: …`;
  it gets an id, never ages out, and leaves only with `pnpm dlx naso-dev handoff done <id>` or
  `set --close <id>`. A set that leaves one out carries it over.
- The log is dated history, newest first: `pnpm dlx naso-dev handoff log "…"`. Lines older than 14
  days, and the oldest past 60, move to the archive on their own.

Update both when a PR opens or merges, when a decision is made, and before you stop.

## NOW

<!-- naso:now:start -->
<!-- naso:now:end -->

## Decisions this week

Links to the records, never copies. Refreshed every time this file is written.

<!-- naso:week:start -->
<!-- naso:week:end -->

## Log

<!-- naso:log:start -->
<!-- naso:log:end -->

## Archive

Older log lines are in `.naso/handoff-archive/`, one file per month (YYYY-MM.md). Read them only
when somebody asks about older work.
