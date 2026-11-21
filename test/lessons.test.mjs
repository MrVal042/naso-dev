// Lessons: what a session learned, one file each, indexed one line each.
//
// Without them a correction made in one session is made again in the next. The index is
// what a briefing links; a lesson is read when its line applies. The audit catches the two
// ways a set of lessons rots: a path it cites is gone, and two lessons say the same thing or
// the opposite thing.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { withRepo, put, read, exists, naso, seedProject, driveFlow, readBriefing } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';
import { locateLessons } from '../tooling/lessons.mjs';

const tracked = (dir) => put(dir, '.naso/config.json', JSON.stringify({ track: true }));
const lesson = (dir, ...args) => naso(['lesson', ...args, dir], dir);

test('lesson writes one file with frontmatter, Why and How to apply, and one index line', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    const res = await lesson(dir, '--title', 'Run migrations before the app', '--why', 'The app reads columns the old schema lacks.', '--apply', 'Apply pending migrations first.', '--type', 'project');
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, '.naso/lessons/run-migrations-before-the-app.md');
    assert.match(text, /^---\nname: run-migrations-before-the-app\ndescription: Run migrations before the app\ntype: project\n---\n/);
    assert.match(text, /\*\*Why:\*\* The app reads columns the old schema lacks\./);
    assert.match(text, /\*\*How to apply:\*\* Apply pending migrations first\./);

    const index = await read(dir, '.naso/lessons/README.md');
    const lines = index.split('\n').filter((line) => line.startsWith('- '));
    assert.deepEqual(lines, ['- [Run migrations before the app](run-migrations-before-the-app.md) — project']);
  });
});

test('lesson needs a title, a why and how to apply, and a known type', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    assert.equal((await lesson(dir, '--title', 'x', '--why', 'y')).code, 1);
    assert.equal((await lesson(dir, '--title', 'x', '--why', 'y', '--apply', 'z', '--type', 'opinion')).code, 1);
    assert.equal(await exists(dir, '.naso/lessons'), false, 'a refused lesson writes nothing');
  });
});

test('a second lesson with the same title is refused, and the first is kept', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    await lesson(dir, '--title', 'Same', '--why', 'first', '--apply', 'a');
    const again = await lesson(dir, '--title', 'Same', '--why', 'second', '--apply', 'b');
    assert.equal(again.code, 1);
    assert.match(await read(dir, '.naso/lessons/same.md'), /first/);
  });
});

test('lessons kept out of git live in the git common dir, so every worktree shares them', async () => {
  const fixture = FIXTURES.find((entry) => entry.name === 'worktree');
  await withFixture(fixture, async ({ dir, main }) => {
    const res = await lesson(dir, '--title', 'Shared', '--why', 'w', '--apply', 'a');
    assert.equal(res.code, 0, res.stderr);
    const fromMain = await locateLessons(main);
    assert.equal(fromMain.where, 'git');
    assert.match(await readFile(path.join(fromMain.dir, 'README.md'), 'utf8'), /\[Shared\]/);
    const listed = await naso(['lessons', main], main);
    assert.match(listed.stdout, /Shared/);
  });
});

test('audit reports a lesson whose cited path is gone as an error, and changes nothing', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    await put(dir, 'src/keep.ts', 'x\n');
    await lesson(dir, '--title', 'Keep it', '--why', 'Used by `src/keep.ts`.', '--apply', 'Edit `src/keep.ts` only.');
    await lesson(dir, '--title', 'Gone', '--why', 'See `src/removed.ts`.', '--apply', 'Never edit `src/removed.ts`.');
    const before = await read(dir, '.naso/lessons/gone.md');
    const res = await naso(['lessons', 'audit', dir], dir);
    assert.equal(res.code, 1, res.stdout);
    assert.match(res.stdout, /ERROR\s+gone\s+cites src\/removed\.ts, which does not exist/);
    assert.doesNotMatch(res.stdout, /keep-it/);
    assert.equal(await read(dir, '.naso/lessons/gone.md'), before);
  });
});

test('audit warns about lessons that duplicate or contradict each other', async () => {
  await withRepo(async ({ dir }) => {
    await tracked(dir);
    await lesson(dir, '--title', 'Squash merge feature branches', '--why', 'History stays linear.', '--apply', 'Always squash merge feature branches.');
    await lesson(dir, '--title', 'Squash-merge feature branches!', '--why', 'Linear history.', '--apply', 'Squash.');
    await lesson(dir, '--title', 'Rebase policy', '--why', 'Keeps commits.', '--apply', 'Never squash merge feature branches.');
    const res = await naso(['lessons', 'audit', dir], dir);
    assert.equal(res.code, 0, 'duplicates and contradictions are warnings');
    assert.match(res.stdout, /WARN\s+squash-merge-feature-branches(-2)?\s.*duplicates/);
    assert.match(res.stdout, /WARN\s+.*contradicts/);
  });
});

test('the briefing links the lessons index, never the lessons, and says how to record one', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook', '--track'] });
    await lesson(dir, '--title', 'A lesson with a long body', '--why', 'Secret detail that must stay out of the briefing.', '--apply', 'x');
    await driveFlow(dir, { args: ['--yes', '--no-hook', '--track', '--force'] });
    const agents = await readBriefing(dir);
    assert.match(agents, /`\.naso\/lessons\/README\.md`/);
    assert.match(agents, /lesson --title/);
    assert.doesNotMatch(agents, /Secret detail/);
    const check = await naso(['briefing', dir, 'check'], dir);
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

for (const fixture of FIXTURES) {
  test(`lesson works in the ${fixture.name} fixture`, async () => {
    await withFixture(fixture, async ({ dir }) => {
      const res = await lesson(dir, '--title', 'Works here', '--why', 'w', '--apply', 'a');
      assert.equal(res.code, 0, res.stdout + res.stderr);
      const located = await locateLessons(dir);
      assert.ok(await readFile(path.join(located.dir, 'works-here.md'), 'utf8'));
    });
  });
}
