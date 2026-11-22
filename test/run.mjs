// Runs every test/*.test.mjs under `node --test`.
//
// `node --test test/*.test.mjs` relied on the shell to expand the glob. npm runs scripts
// through cmd.exe on Windows, which does not, and Node 20 does not expand it either, so on
// Windows no test ran at all. The files are listed here instead, the same on every platform.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(dir, name));
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
