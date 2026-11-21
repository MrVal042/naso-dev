// The handoff: where things stand, kept short enough to read every time.
//
// NOW is one current state that each session replaces, not a pile of updates: a handoff
// that only ever gained entries restated the last one every time and became a log nobody
// read. History has its own section, the log, and only the log ages out into a monthly
// archive. Open items are the exception to every limit: they stay until somebody closes
// them. Every worktree of a repository reads the same file.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { withRepo, put, read, exists, naso, seedProject, driveFlow, BIN } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';
import {
  locateHandoff,
  renderHandoff,
  setNow,
  logEntry,
  closeItem,
  trimLog,
  nowSection,
  logSection,
  openItems,
  NOW_CAP,
  LOG_CAP,
} from '../tooling/handoff.mjs';
import { measureSessionLoad, NOW_START } from '../tooling/stats.mjs';

const fresh = () => renderHandoff({ archiveShown: 'handoff-archive/' });
const lines = (text) => text.split('\n').filter((line) => line.trim() !== '');
const tracked = (dir) => put(dir, '.naso/config.json', JSON.stringify({ track: true }));

test('a new handoff has NOW, Decisions this week, Log and Archive, and says how each is kept', () => {
  const text = fresh();
  for (const heading of ['## NOW', '## Decisions this week', '## Log', '## Archive']) assert.match(text, new RegExp(heading));
  assert.match(text, /handoff set/);
  assert.match(text, /handoff log/);
  assert.match(text, /handoff done/);
  assert.match(text, /when a PR opens or merges, when a decision is made, and before you stop/);
});

test('set replaces NOW and gives each open item and waiting line an id', () => {
  let text = setNow(fresh(), 'Old state.\n- [ ] old item');
  const { text: next } = setNow(text.text, 'Parser rewrite is in review.\n\nNext: wire it into the CLI.\n- [ ] Benchmarks for large files\n- Waiting on the platform team: CI runner quota');
  const now = nowSection(next);
  assert.doesNotMatch(now, /Old state/);
  assert.match(now, /Parser rewrite is in review\./);
  assert.match(now, /- \[ \] \(2\) Benchmarks for large files/);
  assert.match(now, /- \[ \] \(3\) Waiting on the platform team: CI runner quota/);
  assert.deepEqual(openItems(next).map((item) => item.id), [2, 3]);
});

test('an item left out of a set is closed, and the log says so', () => {
  const first = setNow(fresh(), '- [ ] Keep me\n- [ ] Drop me', { today: '2026-11-20' }).text;
  const { text, closed } = setNow(first, 'State.\n- [ ] (1) Keep me', { today: '2026-11-21' });
  assert.deepEqual(closed.map((item) => item.id), [2]);
  assert.match(logSection(text), /- 2026-11-21: closed \(2\) Drop me/);
});

test('set without touching the log', () => {
  let text = fresh();
  text = logEntry(text, 'opened the PR', { today: '2026-11-20' });
  const before = logSection(text);
  text = setNow(text, 'New state.', { today: '2026-11-21' }).text;
  assert.equal(logSection(text), before);
});

test('done closes one open item by id and logs it; an unknown id changes nothing', () => {
  const text = setNow(fresh(), 'State.\n- [ ] First\n  with detail\n- [ ] Second').text;
  const result = closeItem(text, 1, { today: '2026-11-21' });
  assert.ok(result.closed);
  assert.doesNotMatch(nowSection(result.text), /First|with detail/);
  assert.match(nowSection(result.text), /\(2\) Second/);
  assert.match(logSection(result.text), /- 2026-11-21: done \(1\) First/);
  assert.equal(closeItem(text, 9).closed, null);
});

test('done removes only the item: the rest of NOW, blank lines included, is kept as written', () => {
  const text = setNow(fresh(), 'State.\n\nNext:\n- step\n\n- [ ] Close me\n- [ ] Keep me').text;
  const after = nowSection(closeItem(text, 1).text);
  assert.equal(after, '\nState.\n\nNext:\n- step\n\n- [ ] (2) Keep me\n');
});

test('50 log calls keep NOW the same size', () => {
  let text = setNow(fresh(), 'State.\n- [ ] Item').text;
  const now = nowSection(text);
  for (let i = 0; i < 50; i++) text = logEntry(text, `step ${i}`, { today: '2026-11-21' });
  assert.equal(nowSection(text), now);
  assert.equal(nowSection(trimLog(text, { today: '2026-11-21' }).text), now, 'trimming the log leaves NOW alone');
  assert.ok(lines(logSection(trimLog(text, { today: '2026-11-21' }).text)).length <= LOG_CAP);
});

test('a three-week-old open item survives trim; only the log ages out', () => {
  let text = setNow(fresh(), 'State.\n- [ ] 2026-10-30 waiting since then', { today: '2026-10-30' }).text;
  text = logEntry(text, 'old log line', { today: '2026-10-30' });
  text = logEntry(text, 'new log line', { today: '2026-11-20' });
  const { text: trimmed, moved } = trimLog(text, { today: '2026-11-21' });
  assert.match(nowSection(trimmed), /\(1\) 2026-10-30 waiting since then/);
  assert.deepEqual(moved, { '2026-10': ['- 2026-10-30: old log line'] });
  assert.match(logSection(trimmed), /new log line/);
});

test('the log stays under its cap by moving the oldest lines, newest kept', () => {
  let text = fresh();
  for (let i = 1; i <= LOG_CAP + 20; i++) text = logEntry(text, `entry ${i}`, { today: '2026-11-21' });
  const { text: trimmed, moved } = trimLog(text, { today: '2026-11-21' });
  assert.ok(lines(logSection(trimmed)).length <= LOG_CAP);
  assert.match(logSection(trimmed), new RegExp(`entry ${LOG_CAP + 20}\\b`));
  assert.equal(moved['2026-11'].length, 20);
});

test('handoff set, log, done and trim work from the command line, and the archive fills', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    assert.equal((await naso(['handoff', dir], dir)).code, 0);
    const set = await naso(['handoff', 'set', 'Release branch cut.\n- [ ] Changelog review\n- Waiting on design: icons', dir], dir);
    assert.equal(set.code, 0, set.stdout + set.stderr);
    assert.match(set.stdout, /\(1\) Changelog review/);
    assert.match(set.stdout, /\(2\) Waiting on design: icons/);

    await put(dir, '.naso/HANDOFF.md', (await read(dir, '.naso/HANDOFF.md')).replace('<!-- naso:log:start -->', '<!-- naso:log:start -->\n- 2020-01-05: long ago'));
    const logged = await naso(['handoff', 'log', 'Merged the parser PR.', dir], dir);
    assert.equal(logged.code, 0, logged.stderr);
    const text = await read(dir, '.naso/HANDOFF.md');
    assert.match(logSection(text), /Merged the parser PR/);
    assert.doesNotMatch(logSection(text), /long ago/, 'log trims on the way in');
    assert.match(await read(dir, '.naso/handoff-archive/2020-01.md'), /long ago/);

    const done = await naso(['handoff', 'done', '1', dir], dir);
    assert.equal(done.code, 0, done.stderr);
    assert.doesNotMatch(nowSection(await read(dir, '.naso/HANDOFF.md')), /Changelog review/);
    assert.equal((await naso(['handoff', 'done', '7', dir], dir)).code, 1, 'an unknown id is an error');

    const shown = await naso(['handoff', dir], dir);
    assert.match(shown.stdout, /Release branch cut/);
    assert.doesNotMatch(shown.stdout, /Merged the parser PR/, 'the default view is NOW, not the log');
  });
});

test('set reads NOW from a file or from stdin', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    await put(dir, 'state.md', 'From a file.\n');
    assert.equal((await naso(['handoff', 'set', '--file', path.join(dir, 'state.md'), dir], dir)).code, 0);
    assert.match(nowSection(await read(dir, '.naso/HANDOFF.md')), /From a file\./);

    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'handoff', 'set', '-', dir], { cwd: dir, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', resolve);
      child.stdin.end('From stdin.\n');
    });
    assert.equal(code, 0);
    assert.match(nowSection(await read(dir, '.naso/HANDOFF.md')), /From stdin\./);
  });
});

test('add still works, as log, and says once that it was renamed', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    const res = await naso(['handoff', 'add', 'an old script', dir], dir);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /handoff add is now handoff log/);
    assert.match(logSection(await read(dir, '.naso/HANDOFF.md')), /an old script/);
  });
});

test('log, set or done with nothing to say is an error and writes nothing', async () => {
  await withRepo(async ({ dir }) => {
    assert.equal((await naso(['handoff', 'log', dir], dir)).code, 1);
    assert.equal((await naso(['handoff', 'done', dir], dir)).code, 1);
    assert.equal((await naso(['handoff', 'set', dir], dir)).code, 1);
    assert.equal(await exists(dir, '.naso/HANDOFF.md'), false);
  });
});

test('decisions made this week are linked in the handoff, never copied', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    const today = new Date().toISOString().slice(0, 10);
    await put(dir, 'docs/decisions/0001-use-rest.md', `# 0001 Use REST\n\n- Status: accepted\n- Date: ${today}\n\nThe long reasoning that must not be copied.\n`);
    await put(dir, 'docs/decisions/0002-old.md', '# 0002 Old\n\n- Status: accepted\n- Date: 2020-01-01\n');
    await naso(['handoff', 'log', 'note', dir], dir);
    const text = await read(dir, '.naso/HANDOFF.md');
    const week = text.slice(text.indexOf('## Decisions this week'), text.indexOf('## Log'));
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

    const set = await naso(['handoff', 'set', 'written in the linked worktree', dir], dir);
    assert.equal(set.code, 0, set.stderr);
    const shown = await naso(['handoff', main], main);
    assert.match(shown.stdout, /written in the linked worktree/);
    assert.equal(await exists(dir, '.naso/HANDOFF.md'), false, 'nothing lands in the working tree');
  });
});

test('stats counts NOW, and neither the log nor the archive', async () => {
  await withRepo(async ({ dir }) => {
    await naso(['handoff', 'set', 'counted at session start', dir], dir);
    for (let i = 0; i < 20; i++) await naso(['handoff', 'log', `history line ${i} ${'x'.repeat(80)}`, dir], dir);
    const load = await measureSessionLoad(dir);
    const handoff = load.files.find((file) => file.part === 'NOW');
    assert.ok(handoff, JSON.stringify(load.files));
    assert.match(handoff.path, /\.git\/naso\/HANDOFF\.md$/);
    assert.ok(handoff.tokens < 40, `NOW is ${handoff.tokens} tokens; the log must not count`);
  });
});

test('the gate warns, and never blocks, when NOW is over its cap', async () => {
  await withRepo(async ({ dir, git, raw }) => {
    await seedProject(dir, git);
    await tracked(dir);
    const state = Array.from({ length: NOW_CAP + 10 }, (_, i) => `line ${i}`).join('\n');
    await put(dir, '.naso/HANDOFF.md', fresh().replace(NOW_START, `${NOW_START}\n${state}`));
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
    assert.match(readFirst, /handoff set/);
    assert.match(readFirst, /handoff log/);
    assert.match(readFirst, /when a PR opens or merges, when a decision is made, and before you stop/i);

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

test('setup never replaces a handoff that already has a state', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await naso(['handoff', 'set', 'keep me', dir], dir);
    await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    const located = await locateHandoff(dir);
    assert.match(await readFile(located.file, 'utf8'), /keep me/);
  });
});

for (const fixture of FIXTURES) {
  test(`handoff set and log work in the ${fixture.name} fixture`, async () => {
    await withFixture(fixture, async ({ dir }) => {
      const set = await naso(['handoff', 'set', 'a state', dir], dir);
      assert.equal(set.code, 0, set.stdout + set.stderr);
      const log = await naso(['handoff', 'log', 'a note', dir], dir);
      assert.equal(log.code, 0, log.stdout + log.stderr);
      const located = await locateHandoff(dir);
      const text = await readFile(located.file, 'utf8');
      assert.match(nowSection(text), /a state/);
      assert.match(logSection(text), /a note/);
      if (fixture.git === 'none') assert.equal(located.where, 'repo', 'outside git the handoff stays in the folder');
    });
  });
}

test('the archive is read only on request: nothing in it counts toward the session load', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    await naso(['handoff', dir], dir);
    await put(dir, '.naso/handoff-archive/2020-01.md', 'x'.repeat(4000));
    const load = await measureSessionLoad(dir);
    assert.ok(!load.files.some((file) => file.path.includes('handoff-archive')));
    assert.deepEqual(await readdir(path.join(dir, '.naso/handoff-archive')), ['2020-01.md']);
  });
});
