// The documentation outside the README: every link in it resolves, and every example's
// briefing is still true of the example's own files.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { naso, exec, exists, PACKAGE_ROOT } from './helpers.mjs';

const ROOT = PACKAGE_ROOT;

async function markdownUnder(rel) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory() && entry.name !== '.naso') out.push(...(await markdownUnder(child)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child);
  }
  return out;
}

test('every relative link in docs/, examples/README.md and the GitHub templates resolves', async () => {
  const files = [...(await markdownUnder('docs')), 'examples/README.md', ...(await markdownUnder('.github'))];
  assert.ok(files.includes(path.join('docs', 'reference.md')));
  for (const file of files) {
    const text = await readFile(path.join(ROOT, file), 'utf8');
    const links = [...text.matchAll(/\]\(([^)#\s][^)\s]*)\)/g)].map((match) => match[1]).filter((target) => !/^(?:https?:|mailto:)/.test(target));
    for (const target of links) {
      const resolved = path.join(path.dirname(file), decodeURI(target.split('#')[0]));
      assert.ok(await exists(ROOT, resolved), `${file} links to ${target}, which does not exist`);
    }
  }
});

const EXAMPLES = (await readdir(path.join(ROOT, 'examples'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

test('there is an example for each stack the README names', () => {
  for (const name of ['expo-app', 'nestjs-api', 'python-service', 'go-cli', 'rust-library', 'terraform-module', 'monorepo']) {
    assert.ok(EXAMPLES.includes(name), name);
  }
});

for (const name of EXAMPLES) {
  test(`the briefing in examples/${name} passes briefing check against the example's files`, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'naso-doc-example-'));
    const dir = path.join(parent, name);
    try {
      await cp(path.join(ROOT, 'examples', name), dir, { recursive: true });
      const git = (...args) => exec('git', args, dir);
      await git('init', '-q', '-b', 'main');
      await git('add', '-A');
      await git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'example');
      const res = await naso(['briefing', dir], dir);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.ok(await exists(dir, 'CLAUDE.md'));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
}
