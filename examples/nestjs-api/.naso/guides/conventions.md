<!-- naso:guide -->
<!-- digest: a5b70059ced55fcf -->
# orders-api — Conventions

Read this when you write or change code. The NASO block in `AGENTS.md` links it, and `npx naso-dev briefing` checks it with the block. Edit it like the block: say which file proves a correction.

## Code Conventions

Package manager: npm (from package-lock.json). Every command in this file uses it.
Modules: CommonJS: tsconfig.json sets "module": "commonjs" and package.json has no "type", so the compiled output uses require; write TypeScript source with import syntax.
TypeScript ^5.6.0 (package.json range), tsconfig.json present, "strict": true.
Tests: runner jest, 1 test file (under `test/`), `npm run test` names no path, so it discovers its own inputs.
Lint: ESLint configured by `eslint.config.mjs`.
Format: Prettier configured by `.prettierrc`: singleQuote true, trailingComma "all"; every other option is Prettier's default.
