#!/usr/bin/env node
// Regenerates what NASO writes for each example repository in this folder.
//
// Each example is a small repository's own files, checked in as plain files. This copies one
// into a scratch git repository, runs the real setup (`--yes --no-hook --track`, no network),
// and copies back what an agent reads: AGENTS.md, CLAUDE.md, .naso/guides/ and the empty
// handoff, .naso/HANDOFF.md. The toolset,
// the hook and config.json are left out, being the same in every repository. Then it writes
// the table in README.md between its markers, with each example's session-start load.
//
//   node examples/build.mjs            every example
//   node examples/build.mjs go-cli     one

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'naso-dev.mjs');
/** What NASO writes, never copied in as input, and replaced by the run's output. */
export const OUTPUTS = ['AGENTS.md', 'CLAUDE.md', '.naso'];

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Example',
  GIT_AUTHOR_EMAIL: 'example@example.invalid',
  GIT_COMMITTER_NAME: 'Example',
  GIT_COMMITTER_EMAIL: 'example@example.invalid',
  NO_COLOR: '1',
};

function sh(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} in ${cwd}: ${res.stderr || res.stdout}`);
  return res.stdout;
}

/** The example's input files copied into a fresh git repository with one commit. */
export async function seedExample(name, into) {
  await cp(path.join(HERE, name), into, { recursive: true, filter: (src) => !OUTPUTS.includes(path.relative(path.join(HERE, name), src).split(path.sep)[0]) });
  sh('git', ['init', '-q', '-b', 'main'], into);
  sh('git', ['add', '-A'], into);
  sh('git', ['commit', '-qm', 'example'], into);
}

async function build(name) {
  // Named after the example: a repository whose manifest names no project is titled by its folder.
  const parent = await mkdtemp(path.join(os.tmpdir(), 'naso-example-'));
  const scratch = path.join(parent, name);
  try {
    await seedExample(name, scratch);
    sh(process.execPath, [BIN, scratch, '--yes', '--no-hook', '--track'], scratch);
    const stats = JSON.parse(sh(process.execPath, [BIN, 'stats', scratch, '--json'], scratch));
    const target = path.join(HERE, name);
    for (const out of OUTPUTS) await rm(path.join(target, out), { recursive: true, force: true });
    await cp(path.join(scratch, 'AGENTS.md'), path.join(target, 'AGENTS.md'));
    await cp(path.join(scratch, 'CLAUDE.md'), path.join(target, 'CLAUDE.md'));
    await mkdir(path.join(target, '.naso'), { recursive: true });
    await cp(path.join(scratch, '.naso', 'guides'), path.join(target, '.naso', 'guides'), { recursive: true });
    await cp(path.join(scratch, '.naso', 'HANDOFF.md'), path.join(target, '.naso', 'HANDOFF.md'));
    const guides = (await readdir(path.join(scratch, '.naso', 'guides'))).sort();
    return { name, tokens: stats.total.tokens, guides };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const START = '<!-- examples:start -->';
const END = '<!-- examples:end -->';

async function main() {
  const all = (await readdir(HERE, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const wanted = process.argv.slice(2);
  const results = [];
  for (const name of wanted.length > 0 ? wanted : all) {
    results.push(await build(name));
    console.log(`${name}: ${results.at(-1).tokens} tokens at session start`);
  }
  if (wanted.length > 0) return;
  const readme = path.join(HERE, 'README.md');
  const text = await readFile(readme, 'utf8');
  const rows = results.map((row) => `| [${row.name}/](${row.name}/AGENTS.md) | ${row.tokens.toLocaleString('en-US')} | ${row.guides.map((guide) => `[${guide}](${row.name}/.naso/guides/${guide})`).join(', ')} |`);
  const table = ['| Example | Tokens at session start | Guides, read when a task needs one |', '| --- | ---: | --- |', ...rows].join('\n');
  await writeFile(readme, text.replace(new RegExp(`${START}[^]*${END}`), `${START}\n${table}\n${END}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
