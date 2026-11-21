# Good first issues

Scoped changes that need no knowledge of the whole codebase. Each names the file to start
in and how to see the problem today. Every one needs a test that fails before the change
([CONTRIBUTING.md](../CONTRIBUTING.md)); `npm test` runs the suite with nothing to install.

Open an issue saying which one you are taking, so two people do not do the same work.

## 1. Title a repository from Cargo.toml, pyproject.toml or go.mod

**Today:** the briefing's title comes from `package.json` `name`, else the folder name. A
Rust crate named `slugline` in a folder named `rust-library` is titled `rust-library`
([examples/rust-library/AGENTS.md](../examples/rust-library/AGENTS.md)).
**Change:** use `[package] name` from Cargo.toml, `[project] name` from pyproject.toml, and the
last segment of the `module` line in go.mod, in that order after package.json.
**Start in:** `tooling/scan.mjs` (where `pkg.name` is read) and `tooling/stack.mjs`.

## 2. Say what a Go `cmd/` folder is

**Today:** `cmd/ — role not derivable from its name or a manifest`
([examples/go-cli/AGENTS.md](../examples/go-cli/AGENTS.md)). In a Go module, `cmd/<name>/`
holding `package main` is a command's entry point by convention.
**Change:** when go.mod is present and `cmd/*/main.go` exists, describe `cmd/` as the
commands this module builds, naming each. Only when the files are there.
**Start in:** `tooling/scan.mjs`, area roles.

## 3. Call a workspace's library folder a library

**Today:** in a pnpm monorepo whose `packages/ui/` is a library (`"main"`, no app),
Project Structure says `packages/ — application source`
([examples/monorepo/AGENTS.md](../examples/monorepo/AGENTS.md)), though What This Is already
calls `packages/ui/` a library.
**Change:** when every workspace package under a folder is a library, say so.
**Start in:** `tooling/render.mjs` (Project Structure) and `tooling/stack.mjs` (which already
knows each package's kind).

## 4. Read .NET and Elixir manifests

**Today:** a repository with a `*.csproj`, `*.sln` or `mix.exs` is told it has no manifest.
**Change:** add each as a manifest in `tooling/stack.mjs`: what the project is (a web app
from `Microsoft.NET.Sdk.Web`, a Phoenix app from `:phoenix` in deps), and nothing it cannot
read. One table row per framework.
**Start in:** `tooling/stack.mjs`; `test/stack.test.mjs` shows the pattern.

## 5. `naso-dev agents --remove`

**Today:** a pointer written by `naso-dev agents` can only be removed by hand.
**Change:** `--remove <name…|all>` deletes a file NASO created whole (Cursor, Windsurf), and
takes only the naso-marked lines out of one it appended to (Copilot, Gemini), leaving
everything else byte for byte.
**Start in:** `tooling/agents.mjs`; `test/agents.test.mjs`.

## 6. `doctor` reports agent pointers

**Today:** `doctor` checks the CLAUDE.md link but not the pointers for other agents.
**Change:** one row per pointer file that exists: OK when it still names AGENTS.md, WARN
when its naso markers are gone or empty.
**Start in:** `tooling/doctor.mjs`, next to the Claude rows; `planPointer` in
`tooling/agents.mjs` already says whether an agent is linked.

## 7. `workspace --depth <n>`

**Today:** `naso-dev workspace` looks two levels down for repositories.
**Change:** a `--depth` option, 1 to 4, remembered in `.naso/config.json` like `--read-only`.
**Start in:** `tooling/workspace.mjs` (`MAX_DEPTH`); `test/workspace.test.mjs`.
