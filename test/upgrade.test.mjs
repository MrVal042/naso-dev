// Blocks written before a section existed.
//
// A reviewed block is never regenerated, and refresh never rewrites prose, so a block from
// 1.5.x would keep its old shape for good unless something said so. The check says so as a
// notice, never a failure, and `review` tells the agent exactly what to add and where.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withRepo, put, read, naso, seedProject, driveFlow } from './helpers.mjs';

/** Set up, then cut the Read First section out of the block, as a 1.5.x block would be. */
async function oldShapeBlock(dir, git, args = []) {
  await seedProject(dir, git);
  const res = await driveFlow(dir, { args: ['--yes', '--no-hook', ...args] });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const text = await read(dir, 'AGENTS.md');
  const start = text.indexOf('## Read First');
  const end = text.indexOf('\n## ', start + 1);
  assert.ok(start !== -1 && end !== -1);
  await put(dir, 'AGENTS.md', text.slice(0, start) + text.slice(end + 1));
}

test('a block without Read First passes the check, with a notice naming the version that added it', async () => {
  await withRepo(async ({ dir, git }) => {
    await oldShapeBlock(dir, git);
    const res = await naso(['briefing', dir, 'check'], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /NOTICES \(1\)/);
    assert.match(res.stdout, /Read First missing \(added in 1\.6\.0\)/);
    assert.match(res.stdout, /naso-dev review/);
  });
});

test('a block that has Read First gets no notice', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    const res = await naso(['briefing', dir, 'check'], dir);
    assert.doesNotMatch(res.stdout, /NOTICES/);
  });
});

test('review tells the agent to add Read First inside the markers, with the text to add', async () => {
  await withRepo(async ({ dir, git }) => {
    await oldShapeBlock(dir, git);
    const res = await naso(['review', dir], dir);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /no Read First section \(added in 1\.6\.0\)/);
    assert.match(res.stdout, /inside the markers/);
    assert.match(res.stdout, /## Read First\n\n1\. The handoff's NOW section/);
    assert.match(res.stdout, /handoff set/);
  });
});

test('with a tracked handoff that does not exist yet, review says to create it first, so the cited file exists', async () => {
  await withRepo(async ({ dir, git }) => {
    await oldShapeBlock(dir, git, ['--track']);
    await (await import('node:fs/promises')).rm(`${dir}/.naso/HANDOFF.md`);
    const res = await naso(['review', dir], dir);
    assert.match(res.stdout, /`\.naso\/HANDOFF\.md`/);
    assert.match(res.stdout, /Run `[^`]*handoff[^`]*` first/);
  });
});

test('after the agent pastes what review gave it, the check passes with no notice', async () => {
  await withRepo(async ({ dir, git }) => {
    await oldShapeBlock(dir, git);
    const prompt = (await naso(['review', dir], dir)).stdout;
    const section = prompt.slice(prompt.indexOf('## Read First'), prompt.indexOf('\n```', prompt.indexOf('## Read First')));
    const text = await read(dir, 'AGENTS.md');
    const at = text.indexOf('## Which Document Wins');
    await put(dir, 'AGENTS.md', `${text.slice(0, at)}${section.trim()}\n\n${text.slice(at)}`);
    const res = await naso(['briefing', dir, 'check'], dir);
    assert.equal(res.code, 0, res.stdout);
    assert.doesNotMatch(res.stdout, /NOTICES/);
  });
});
