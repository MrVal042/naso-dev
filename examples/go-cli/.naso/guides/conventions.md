<!-- naso:guide -->
<!-- digest: 07c6d08782e82c3a -->
# go-cli — Conventions

Read this when you write or change code. The NASO block in `AGENTS.md` links it, and `npx naso-dev briefing` checks it with the block. Edit it like the block: say which file proves a correction.

## Stack Rules

- `go.sum` is maintained by `go mod tidy`; never edit it by hand.
