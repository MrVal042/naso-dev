#!/usr/bin/env node
// Smoke test: NASO as a user gets it, through the real npm and npx.
//
// The unit tests prove the cmd.exe escaping against a hand-written shim. This runs the
// shims Node ships: `npm pack` and `npx <tarball>`, both started by NASO's own run(), from
// folders whose names hold "&", spaces and parentheses. On Windows those are npm.cmd and
// npx.cmd, the case CVE-2024-27980 is about; elsewhere it is the same check on the real
// binaries. Not part of `npm test`: it needs a working npm, and CI runs it as its own step.
//
// Exits 1 with the output of the step that failed. Writes only under a temporary folder.

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run } from '../../tooling/lib.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(step, res) {
  console.error(`smoke: ${step} failed (exit ${res.code})`);
  console.error(res.stdout);
  console.error(res.stderr);
  process.exit(1);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'naso-smoke-'));
try {
  const pkgDir = path.join(tmp, 'pkg & (1)');
  const repo = path.join(tmp, 'repo & (1)');
  await mkdir(pkgDir, { recursive: true });
  await mkdir(repo, { recursive: true });

  const pack = await run('npm', ['pack', '--pack-destination', pkgDir], { cwd: PACKAGE_ROOT });
  if (!pack.ok) fail('npm pack', pack);
  const tarballs = (await readdir(pkgDir)).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) fail('npm pack (no tarball written)', pack);
  const tarball = path.join(pkgDir, tarballs[0]);

  for (const args of [['init', '-q'], ['config', 'user.email', 'ci@example.invalid'], ['config', 'user.name', 'CI']]) {
    const res = await run('git', args, { cwd: repo });
    if (!res.ok) fail(`git ${args[0]}`, res);
  }
  await writeFile(path.join(repo, 'README.md'), '# smoke\n');
  await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src', 'index.js'), 'export const x = 1;\n');
  await run('git', ['add', '-A'], { cwd: repo });
  const commit = await run('git', ['commit', '-qm', 'init'], { cwd: repo });
  if (!commit.ok) fail('git commit', commit);

  // --package names what to install; the next word is the bin to run. Given a bare path,
  // npx takes the path itself as the command and hands it to a shell unescaped.
  const dry = await run('npx', ['--yes', '--package', tarball, 'naso-dev', '--dry-run', '--no-color'], { cwd: repo });
  if (!dry.ok) fail('npx --package <tarball> naso-dev --dry-run', dry);
  for (const expected of ['NASO', 'repo & (1)', 'nothing was written']) {
    if (!dry.stdout.includes(expected)) fail(`npx <tarball> --dry-run (output lacks "${expected}")`, dry);
  }
  const written = (await readdir(repo)).filter((name) => !['.git', 'README.md', 'src'].includes(name));
  if (written.length > 0) fail(`--dry-run (it wrote ${written.join(', ')})`, dry);

  console.log(`smoke: ok. npm packed ${tarballs[0]} into "pkg & (1)", and npx ran it as a dry run in "repo & (1)".`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
