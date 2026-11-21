// The handoff: what one session leaves for the next, kept short enough to read every time.
//
// Unbounded, a handoff passed 1,500 lines in the field and cost more to read than it saved.
// These tests hold the bound: NOW stays under its cap, older entries move to a monthly
// archive nobody loads by default, and every worktree of a repository reads the same file.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { withRepo, put, read, exists, naso, seedProject, driveFlow, exec } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';
import {
  locateHandoff,
  renderHandoff,
  addEntry,
  trimHandoff,
  nowSection,
  NOW_CAP,
} from '../tooling/handoff.mjs';
import { measureSessionLoad } from '../tooling/stats.mjs';
import { NOW_START, NOW_END } from '../tooling/stats.mjs';

const nowLines = (text) => nowSection(text).split('\n').filter((line) => line.trim() !== '');

test('a new handoff has NOW, Decisions this week and Archive, and says when to update it', () => {
  const text = renderHandoff({ archiveShown: '.naso/handoff-archive/' });
  assert.ok(text.includes(NOW_START) && text.includes(NOW_END));
  assert.match(text, /## NOW/);
  assert.match(text, /## Decisions this week/);
  assert.match(text, /## Archive/);
  assert.match(text, /\.naso\/handoff-archive\//);
  assert.match(text, /when a PR opens or merges, when a decision is made, and before you stop/);
});

test('add puts a dated entry at the top of NOW', () => {
  let text = renderHandoff({ archiveShown: 'a/' });
  text = addEntry(text, 'first', { today: '2026-11-01' });
  text = addEntry(text, 'second\nwith a second line', { today: '2026-11-02' });
  const lines = nowLines(text);
  assert.equal(lines[0], '- 2026-11-02: second');
  assert.equal(lines[1], '  with a second line');
  assert.equal(lines[2], '- 2026-11-01: first');
});

test('trim moves entries older than the limit into the archive for their month, newest first', () => {
  let text = renderHandoff({ archiveShown: 'a/' });
  for (const day of ['2026-09-30', '2026-10-02', '2026-10-20', '2026-11-20']) text = addEntry(text, `on ${day}`, { today: day });
  const { text: kept, moved } = trimHandoff(text, { today: '2026-11-21', days: 14, cap: NOW_CAP });
  assert.deepEqual(nowLines(kept), ['- 2026-11-20: on 2026-11-20']);
  assert.deepEqual(Object.keys(moved).sort(), ['2026-09', '2026-10']);
  assert.deepEqual(moved['2026-10'], ['- 2026-10-20: on 2026-10-20', '- 2026-10-02: on 2026-10-02']);
});

test('trim keeps NOW under the line cap by moving the oldest entries, even recent ones', () => {
  let text = renderHandoff({ archiveShown: 'a/' });
  for (let i = 1; i <= 80; i++) text = addEntry(text, `entry ${i}`, { today: '2026-11-21' });
  const { text: kept, moved } = trimHandoff(text, { today: '2026-11-21', days: 14, cap: NOW_CAP });
  const lines = nowLines(kept);
  assert.ok(lines.length <= NOW_CAP, `NOW is ${lines.length} lines`);
  assert.equal(lines[0], '- 2026-11-21: entry 80', 'the newest entry stays');
  assert.equal(moved['2026-11'].length, 80 - lines.length);
});

test('text a person wrote above the entries in NOW is never moved', () => {
  let text = renderHandoff({ archiveShown: 'a/' }).replace(NOW_START, `${NOW_START}\nWaiting on the security review.\n`);
  text = addEntry(text, 'old', { today: '2026-01-01' });
  const { text: kept } = trimHandoff(text, { today: '2026-11-21', days: 14, cap: NOW_CAP });
  assert.deepEqual(nowLines(kept), ['Waiting on the security review.']);
});

test('handoff creates the file, add writes to it, and trim fills the monthly archive', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, '.naso/config.json', JSON.stringify({ track: true }));
    const created = await naso(['handoff', dir], dir);
    assert.equal(created.code, 0, created.stderr);
    assert.ok(await exists(dir, '.naso/HANDOFF.md'));

    await put(
      dir,
      '.naso/HANDOFF.md',
      (await read(dir, '.naso/HANDOFF.md')).replace(NOW_START, `${NOW_START}\n- 2020-01-05: long ago`),
    );
    const added = await naso(['handoff', 'add', 'Opened the parser PR; waiting on review.', dir], dir);
    assert.equal(added.code, 0, added.stderr);
    const text = await read(dir, '.naso/HANDOFF.md');
    assert.match(nowSection(text), /Opened the parser PR/);
    assert.doesNotMatch(nowSection(text), /long ago/, 'add trims on the way in');
    assert.match(await read(dir, '.naso/handoff-archive/2020-01.md'), /long ago/);

    const shown = await naso(['handoff', dir], dir);
    assert.match(shown.stdout, /Opened the parser PR/);
    assert.doesNotMatch(shown.stdout, /long ago/);
  });
});

test('add with no text is an error and writes nothing', async () => {
  await withRepo(async ({ dir }) => {
    const res = await naso(['handoff', 'add', dir], dir);
    assert.equal(res.code, 1);
    assert.equal(await exists(dir, '.naso/HANDOFF.md'), false);
  });
});

test('decisions made this week are linked in the handoff, never copied', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, '.naso/config.json', JSON.stringify({ track: true }));
    const today = new Date().toISOString().slice(0, 10);
    await put(dir, 'docs/decisions/0001-use-rest.md', `# 0001 Use REST\n\n- Status: accepted\n- Date: ${today}\n\nThe long reasoning that must not be copied.\n`);
    await put(dir, 'docs/decisions/0002-old.md', '# 0002 Old\n\n- Status: accepted\n- Date: 2020-01-01\n');
    await naso(['handoff', 'add', 'note', dir], dir);
    const text = await read(dir, '.naso/HANDOFF.md');
    const week = text.slice(text.indexOf('## Decisions this week'), text.indexOf('## Archive'));
    assert.match(week, /docs\/decisions\/0001-use-rest\.md/);
    assert.doesNotMatch(week, /0002/);
    assert.doesNotMatch(text, /long reasoning/);
  });
});

test('a handoff kept out of git lives in the git common dir, so every worktree shares it', async () => {
  const fixture = FIXTURES.find((entry) => entry.name === 'worktree');
  await withFixture(fixture, async ({ dir, main }) => {
    const fromLinked = await locateHandoff(dir);
    const fromMain = await locateHandoff(main);
    assert.equal(fromLinked.where, 'git');
    assert.equal(fromLinked.file, fromMain.file);

    const added = await naso(['handoff', 'add', 'written in the linked worktree', dir], dir);
    assert.equal(added.code, 0, added.stderr);
    const shown = await naso(['handoff', main], main);
    assert.match(shown.stdout, /written in the linked worktree/);
    assert.equal(await exists(dir, '.naso/HANDOFF.md'), false, 'nothing lands in the working tree');
  });
});

test('stats counts the NOW section of a handoff kept in the git directory', async () => {
  await withRepo(async ({ dir }) => {
    await naso(['handoff', 'add', 'counted at session start', dir], dir);
    const load = await measureSessionLoad(dir);
    const handoff = load.files.find((file) => file.part === 'NOW');
    assert.ok(handoff, JSON.stringify(load.files));
    assert.match(handoff.path, /\.git\/naso\/HANDOFF\.md$/);
  });
});

test('the gate warns, and never blocks, when NOW is over its cap', async () => {
  await withRepo(async ({ dir, git, raw }) => {
    await seedProject(dir, git);
    await put(dir, '.naso/config.json', JSON.stringify({ track: true }));
    const entries = Array.from({ length: NOW_CAP + 10 }, (_, i) => `- 2026-11-21: entry ${i}`).join('\n');
    await put(dir, '.naso/HANDOFF.md', renderHandoff({ archiveShown: 'a/' }).replace(NOW_START, `${NOW_START}\n${entries}`));
    await put(dir, 'src/more.ts', 'export const z = 3;\n');
    await git('add', 'src/more.ts');
    const res = await raw('validate.mjs', ['--staged']);
    assert.match(res.stdout, /\[WARN\] Handoff — NOW is \d+ lines, over its cap of 60/);
    assert.equal(res.code, 0, res.stdout);
  });
});

test('setup writes the handoff, and the briefing says to read it first and keep it current', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    assert.equal(res.code, 0, res.stderr);
    const located = await locateHandoff(dir);
    assert.equal(located.where, 'git', 'a local setup keeps the handoff out of the working tree');
    assert.ok(await readFile(located.file, 'utf8'));

    const agents = await read(dir, 'AGENTS.md');
    const readFirst = agents.slice(agents.indexOf('## Read First'));
    assert.match(readFirst, /1\. The handoff's NOW section/);
    assert.match(readFirst, /2\. This briefing/);
    assert.match(readFirst, /3\. .*[Dd]ecisions/);
    assert.match(readFirst, /when a PR opens or merges, when a decision is made, and before you stop/);

    const check = await naso(['briefing', dir, 'check'], dir);
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

test('with --track the handoff is in .naso/ and the briefing names the file', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await driveFlow(dir, { args: ['--yes', '--no-hook', '--track'] });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(await exists(dir, '.naso/HANDOFF.md'));
    assert.match(await read(dir, 'AGENTS.md'), /`\.naso\/HANDOFF\.md`/);
    const check = await naso(['briefing', dir, 'check'], dir);
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

test('setup never replaces a handoff that already has entries', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await naso(['handoff', 'add', 'keep me', dir], dir);
    await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    const located = await locateHandoff(dir);
    assert.match(await readFile(located.file, 'utf8'), /keep me/);
  });
});

for (const fixture of FIXTURES) {
  test(`handoff add works in the ${fixture.name} fixture`, async () => {
    await withFixture(fixture, async ({ dir }) => {
      const res = await naso(['handoff', 'add', 'a note', dir], dir);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      const located = await locateHandoff(dir);
      assert.match(nowSection(await readFile(located.file, 'utf8')), /a note/);
      if (fixture.git === 'none') assert.equal(located.where, 'repo', 'outside git the handoff stays in the folder');
    });
  });
}

test('the archive is read only on request: nothing in it counts toward the session load', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, '.naso/config.json', JSON.stringify({ track: true }));
    await naso(['handoff', dir], dir);
    await put(dir, '.naso/handoff-archive/2020-01.md', 'x'.repeat(4000));
    const load = await measureSessionLoad(dir);
    assert.ok(!load.files.some((file) => file.path.includes('handoff-archive')));
    assert.deepEqual(await readdir(path.join(dir, '.naso/handoff-archive')), ['2020-01.md']);
  });
});
