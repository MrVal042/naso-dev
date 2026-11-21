// `naso-dev workspace`: a briefing for a folder that holds several repositories and is not
// one itself. It runs no git in the folder, changes nothing inside a repository, and writes
// nothing before the plan is accepted.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { put, read, exists, naso, exec, treeHash } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';
import { renderWorkspace, blockState } from '../tooling/workspace.mjs';

const PARENT = FIXTURES.find((fixture) => fixture.name === 'non-git-parent');

async function snapshot(root, children) {
  return Promise.all(children.map((child) => treeHash(path.join(root, child))));
}

test('workspace prints its plan and writes nothing without --yes, exiting 2 with no terminal', async () => {
  await withFixture(PARENT, async ({ dir, children }) => {
    const res = await naso(['workspace', dir], dir);
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.match(res.stdout, /Found 2 repositories: service-a\/, service-b\//);
    assert.match(res.stdout, /nothing is written until you accept/);
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.naso']) assert.equal(await exists(dir, file), false, file);
    const dry = await naso(['workspace', dir, '--dry-run'], dir);
    assert.equal(dry.code, 0);
    assert.equal(await exists(dir, 'AGENTS.md'), false);
    assert.equal(children.length, 2);
  });
});

test('workspace --yes writes the folder briefing, the CLAUDE.md link and a shared handoff, and nothing inside a repository', async () => {
  await withFixture(PARENT, async ({ dir, children }) => {
    await put(path.join(dir, 'service-a'), '.github/CODEOWNERS', '* @team-a\n/docs/ @writers\n');
    await exec('git', ['add', '-A'], path.join(dir, 'service-a'));
    await exec('git', ['commit', '-qm', 'owners'], path.join(dir, 'service-a'));
    const before = await snapshot(dir, children);

    const res = await naso(['workspace', dir, '--yes'], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const agents = await read(dir, 'AGENTS.md');
    assert.match(agents, /^<!-- naso:start -->\n/);
    assert.match(agents, /It holds 2 repositories/);
    assert.match(agents, /\| service-a\/ \| none yet: `[^`]*naso-dev service-a` \| @team-a \(\.github\/CODEOWNERS\) \|/);
    assert.match(agents, /\| service-b\/ \| none yet: [^|]+\|\s+\|/);
    assert.doesNotMatch(agents, /We may write/, 'no repository says what may be written, so the column is left out');
    assert.match(agents, /\.naso\/HANDOFF\.md/);
    assert.match(await read(dir, 'CLAUDE.md'), /^@AGENTS\.md$/m);
    assert.ok(await exists(dir, '.naso/HANDOFF.md'));
    assert.deepEqual(await snapshot(dir, children), before, 'the repositories are unchanged');
  });
});

test('a second run with nothing new writes nothing, and a new repository is added on the next run', async () => {
  await withFixture(PARENT, async ({ dir }) => {
    await naso(['workspace', dir, '--yes'], dir);
    const first = await read(dir, 'AGENTS.md');
    const again = await naso(['workspace', dir, '--yes'], dir);
    assert.match(again.stdout, /current; nothing to write/);
    assert.equal(await read(dir, 'AGENTS.md'), first);

    await mkdir(path.join(dir, 'group', 'service-c'), { recursive: true });
    await exec('git', ['init', '-q'], path.join(dir, 'group', 'service-c'));
    await naso(['workspace', dir, '--yes'], dir);
    assert.match(await read(dir, 'AGENTS.md'), /It holds 3 repositories[^]*\| group\/service-c\/ \|/);
  });
});

test('--read-only is shown, remembered, and an AGENTS.md of the folder\'s own keeps its text', async () => {
  await withFixture(PARENT, async ({ dir }) => {
    await writeFile(path.join(dir, 'AGENTS.md'), '# Our notes\n\nKeep this.\n');
    await naso(['workspace', dir, '--yes', '--read-only', 'service-b'], dir);
    let agents = await read(dir, 'AGENTS.md');
    assert.ok(agents.startsWith('# Our notes\n\nKeep this.\n\n<!-- naso:start -->'), agents);
    assert.match(agents, /\| service-b\/ \|[^\n]*\| nothing: read only \|/);
    await mkdir(path.join(dir, 'service-d'), { recursive: true });
    await exec('git', ['init', '-q'], path.join(dir, 'service-d'));
    await naso(['workspace', dir, '--yes'], dir);
    agents = await read(dir, 'AGENTS.md');
    assert.match(agents, /\| service-b\/ \|[^\n]*\| nothing: read only \|/, 'remembered from config.json');
    assert.equal(agents.match(/naso:start/g).length, 1);
  });
});

test('a block people edited is kept, and --force replaces it after a backup', async () => {
  await withFixture(PARENT, async ({ dir }) => {
    await naso(['workspace', dir, '--yes'], dir);
    const edited = (await read(dir, 'AGENTS.md')).replace('## Repositories', '## Repositories\n\nservice-b deploys on Fridays only.');
    await writeFile(path.join(dir, 'AGENTS.md'), edited);
    await mkdir(path.join(dir, 'service-e'), { recursive: true });
    await exec('git', ['init', '-q'], path.join(dir, 'service-e'));
    const kept = await naso(['workspace', dir, '--yes'], dir);
    assert.match(kept.stdout, /changed by hand since NASO wrote it, so it is kept/);
    assert.equal(await read(dir, 'AGENTS.md'), edited);
    await naso(['workspace', dir, '--yes', '--force'], dir);
    assert.match(await read(dir, 'AGENTS.md'), /service-e/);
    assert.ok(await exists(dir, '.naso/backups'));
  });
});

test('the shared handoff is the folder\'s even when the folder sits inside another git repository', async () => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'naso-outer-'));
  try {
    await exec('git', ['init', '-q'], outer);
    const dir = path.join(outer, 'work');
    for (const child of ['one', 'two']) {
      await mkdir(path.join(dir, child), { recursive: true });
      await exec('git', ['init', '-q'], path.join(dir, child));
    }
    const res = await naso(['workspace', dir, '--yes'], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const set = await naso(['handoff', 'set', 'Both repositories move to the new token format.', dir], dir);
    assert.equal(set.code, 0, set.stderr);
    assert.match(await read(dir, '.naso/HANDOFF.md'), /new token format/);
    assert.equal(await exists(outer, '.naso'), false, 'nothing in the outer repository');
    assert.equal(await exists(path.join(outer, '.git'), 'naso'), false);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test('workspace refuses a git repository and a folder with no repository, and writes nothing', async () => {
  await withFixture(FIXTURES.find((fixture) => fixture.name === 'go'), async ({ dir }) => {
    const res = await naso(['workspace', dir, '--yes'], dir);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /is a git repository/);
    assert.equal(await exists(dir, 'CLAUDE.md'), false);
  });
  const empty = await mkdtemp(path.join(os.tmpdir(), 'naso-empty-'));
  try {
    await mkdir(path.join(empty, 'notes'));
    const res = await naso(['workspace', empty, '--yes'], empty);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /nothing to brief/);
    assert.equal(await exists(empty, 'AGENTS.md'), false);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('a linked worktree counts as a repository, and hidden and dependency folders are not searched', async () => {
  await withFixture(FIXTURES.find((fixture) => fixture.name === 'worktree'), async ({ root }) => {
    await mkdir(path.join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
    await mkdir(path.join(root, '.cache', 'thing', '.git'), { recursive: true });
    const res = await naso(['workspace', root, '--dry-run'], root);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Found 2 repositories: linked\/, main\//);
  });
});

test('the block names a repository with its own AGENTS.md, links it, and its digest tells an edit apart', () => {
  const block = renderWorkspace({
    name: 'w',
    handoff: '.naso/HANDOFF.md',
    rows: [
      { rel: 'a', briefing: 'naso', owners: null, write: 'only `src`' },
      { rel: 'b', briefing: 'own', owners: { file: 'CODEOWNERS', owners: [] }, write: null },
    ],
  });
  assert.match(block, /\| \[a\/\]\(a\/AGENTS\.md\) \| AGENTS\.md, kept by NASO \|  \| only `src` \|/);
  assert.match(block, /\| \[b\/\]\(b\/AGENTS\.md\) \| AGENTS\.md \| per path, in CODEOWNERS \|  \|/);
  assert.equal(blockState(block).edited, false);
  assert.equal(blockState(block.replace('Read First', 'Read first')).edited, true);
});
