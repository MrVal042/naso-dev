// `stats`: what an agent loads at session start, in estimated tokens, and the largest parts.
//
// Every later phase reports its before and after against these numbers, so the counting
// itself has to be right: each file once, imports followed the way Claude Code follows them,
// only the NOW part of the handoff, and nothing outside the repository.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withRepo, put, naso } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';
import { measureSessionLoad, estimateTokens } from '../tooling/stats.mjs';

const tokensOf = (text) => Math.ceil(text.length / 4);

test('tokens are estimated at four characters each, rounded up, with no dependency', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('AGENTS.md imported by CLAUDE.md is counted once, and the total is the sum of the files', async () => {
  await withRepo(async ({ dir }) => {
    const agents = '# Project\n\n## Commands\n\nnpm test runs everything.\n';
    const claude = 'Claude Code reads this file.\n\n@AGENTS.md\n';
    await put(dir, 'AGENTS.md', agents);
    await put(dir, 'CLAUDE.md', claude);

    const load = await measureSessionLoad(dir);
    const paths = load.files.map((file) => file.path);
    assert.deepEqual(paths.sort(), ['AGENTS.md', 'CLAUDE.md']);
    assert.equal(load.total.tokens, tokensOf(agents) + tokensOf(claude));
    assert.equal(load.total.chars, agents.length + claude.length);
  });
});

test('imports are followed from the importing file, recursively, and a cycle ends', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, 'CLAUDE.md', '@docs/agent/one.md\n');
    await put(dir, 'docs/agent/one.md', 'One. See @two.md for more.\n');
    await put(dir, 'docs/agent/two.md', 'Two, which points back at @one.md.\n');

    const load = await measureSessionLoad(dir);
    assert.deepEqual(
      load.files.map((file) => file.path).sort(),
      ['CLAUDE.md', 'docs/agent/one.md', 'docs/agent/two.md'],
    );
    const two = load.files.find((file) => file.path === 'docs/agent/two.md');
    assert.equal(two.via, 'docs/agent/one.md');
  });
});

test('an @ in a code span, a code block or an e-mail address is not an import', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, 'CLAUDE.md', [
      'Write `@ignored-span.md` to import.',
      '```',
      '@ignored-block.md',
      '```',
      'Mail someone@ignored-mail.md.',
      '@real.md',
      '',
    ].join('\n'));
    for (const name of ['ignored-span.md', 'ignored-block.md', 'ignored-mail.md', 'real.md']) {
      await put(dir, name, `${name}\n`);
    }

    const load = await measureSessionLoad(dir);
    assert.deepEqual(load.files.map((file) => file.path).sort(), ['CLAUDE.md', 'real.md']);
  });
});

test('an import outside the repository is listed as skipped and never read', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, 'CLAUDE.md', '@~/private-notes.md\n@../outside.md\n@missing.md\n');

    const load = await measureSessionLoad(dir);
    assert.deepEqual(load.files.map((file) => file.path), ['CLAUDE.md']);
    const reasons = Object.fromEntries(load.skipped.map((entry) => [entry.import, entry.reason]));
    assert.equal(reasons['~/private-notes.md'], 'outside the repository');
    assert.equal(reasons['../outside.md'], 'outside the repository');
    assert.equal(reasons['missing.md'], 'not found');
  });
});

test('an import alias written in prose (@/ or @/src/lib) is not reported as an import', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, 'CLAUDE.md', 'The alias @/ resolves to the root, so write @/src/lib/utils.\n');
    const load = await measureSessionLoad(dir);
    assert.deepEqual(load.skipped, []);
  });
});

test('only the NOW part of the handoff counts; the rest of the file is read on request', async () => {
  await withRepo(async ({ dir }) => {
    const now = '\n- Waiting on review of the parser change.\n';
    await put(
      dir,
      '.naso/HANDOFF.md',
      `# Handoff\n\n<!-- naso:now:start -->${now}<!-- naso:now:end -->\n\n## Older\n\n${'old entry\n'.repeat(200)}`,
    );

    const load = await measureSessionLoad(dir);
    const handoff = load.files.find((file) => file.path === '.naso/HANDOFF.md');
    assert.ok(handoff, 'the handoff NOW section must be counted');
    assert.equal(handoff.part, 'NOW');
    assert.equal(handoff.tokens, tokensOf(now));
  });
});

test('the largest sections are ranked by tokens, and the NASO block is measured on its own', async () => {
  await withRepo(async ({ dir }) => {
    const big = `## Commands\n\n${'run this before you stop\n'.repeat(40)}`;
    const small = '## Scope\n\nOne line.\n';
    const block = `<!-- naso:start -->\n${big}\n${small}<!-- naso:end -->\n`;
    await put(dir, 'AGENTS.md', `# Team notes\n\nWritten by people.\n\n${block}`);

    const load = await measureSessionLoad(dir);
    assert.equal(load.sections[0].heading, 'Commands');
    assert.equal(load.sections[0].file, 'AGENTS.md');
    assert.ok(load.sections[0].tokens > load.sections[1].tokens);
    assert.equal(load.nasoBlock.tokens, tokensOf(block.trimEnd()));
  });
});

test('a heading inside a code block does not start a section', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, 'AGENTS.md', '## Real\n\n```bash\n# not a heading\necho hi\n```\n');
    const load = await measureSessionLoad(dir);
    assert.deepEqual(load.sections.map((section) => section.heading), ['Real']);
  });
});

test('CRLF files count the same lines as LF files', async () => {
  await withRepo(async ({ dir }) => {
    await writeFile(path.join(dir, 'AGENTS.md'), '## A\r\n\r\none\r\ntwo\r\n');
    const load = await measureSessionLoad(dir);
    assert.equal(load.files[0].lines, 4);
    assert.deepEqual(load.sections.map((section) => section.heading), ['A']);
  });
});

test('stats prints the table, the total and the largest sections, and --json prints the same numbers', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, 'AGENTS.md', `## Commands\n\n${'line\n'.repeat(30)}`);
    await put(dir, 'CLAUDE.md', '@AGENTS.md\n');

    const text = await naso(['stats', dir], dir);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /AGENTS\.md/);
    assert.match(text.stdout, /CLAUDE\.md/);
    assert.match(text.stdout, /Total/);
    assert.match(text.stdout, /Largest sections/);
    assert.match(text.stdout, /4 characters/);

    const json = await naso(['stats', dir, '--json'], dir);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.charsPerToken, 4);
    assert.equal(parsed.total.tokens, (await measureSessionLoad(dir)).total.tokens);
  });
});

test('stats says plainly when nothing loads, and exits 0', async () => {
  await withRepo(async ({ dir }) => {
    const res = await naso(['stats', dir], dir);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Nothing loads at session start/);
  });
});

for (const fixture of FIXTURES) {
  test(`stats runs in the ${fixture.name} fixture without git, a manifest or a commit`, async () => {
    await withFixture(fixture, async ({ dir }) => {
      await put(dir, 'AGENTS.md', '## Rules\n\nOne rule.\n');
      const res = await naso(['stats', dir, '--json'], dir);
      assert.equal(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert.deepEqual(parsed.files.map((file) => file.path), ['AGENTS.md']);
    });
  });
}
