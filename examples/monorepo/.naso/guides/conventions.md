<!-- naso:guide -->
<!-- digest: 350d879ff49d4228 -->
# shop — Conventions

Read this when you write or change code. The NASO block in `AGENTS.md` links it, and `npx naso-dev briefing` checks it with the block. Edit it like the block: say which file proves a correction.

## Stack Rules

- App Router: folders under `apps/web/app/` are routes, and the `page`, `layout` and `route` files in them are special.
- Anything in a `NEXT_PUBLIC_` variable is sent to the browser; never put a secret there.

## Code Conventions

Package manager: pnpm (from package.json "packageManager": pnpm@9.12.0). Every command in this file uses it.
Modules: .js files are CommonJS (no "type": "module"), which covers `commitlint.config.js`; TypeScript source is compiled by its toolchain and uses import syntax whatever this says.
TypeScript ^5.6.0 (package.json range), no tsconfig.json.
