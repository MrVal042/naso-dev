// Pointers from other agents' instruction files to AGENTS.md. One line each, never a copy,
// opt-in, and appended inside naso markers to a file a person already keeps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withRepo, put, read, exists, naso, seedProject, driveFlow, answerRealQuestions } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';
import { AGENTS, pointerContent } from '../tooling/agents.mjs';

const POINTER_FILES = Object.values(AGENTS).map((agent) => agent.file);

test('agents all writes one pointer per agent, each naming AGENTS.md and holding no briefing text', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await naso(['agents', 'all', dir], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    for (const file of POINTER_FILES) {
      const text = await read(dir, file);
      assert.match(text, /AGENTS\.md/, file);
      assert.ok(text.split('\n').length <= 9, `${file} is a pointer, not a copy`);
    }
    // Cursor and Windsurf read front matter only when it is the first thing in the file.
    assert.match(await read(dir, '.cursor/rules/naso.mdc'), /^---\n[^]*alwaysApply: true\n---\n<!-- naso:start -->/);
    assert.match(await read(dir, '.windsurf/rules/naso.md'), /^---\ntrigger: always_on\n---\n/);
    // Gemini CLI follows @imports, as Claude Code does.
    assert.match(await read(dir, 'GEMINI.md'), /^@AGENTS\.md$/m);
    assert.match(res.stdout, /Codex|Cursor/);
  });
});

test('a pointer file this creates in a local run stays out of git; with --track it does not', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await naso(['agents', 'cursor', 'gemini', dir], dir);
    const status = (await git('status', '--porcelain', '--untracked-files=all')).stdout;
    assert.doesNotMatch(status, /naso\.mdc|GEMINI\.md/, status);
  });
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await naso(['agents', 'cursor', dir, '--track'], dir);
    assert.match((await git('status', '--porcelain', '--untracked-files=all')).stdout, /\.cursor\/rules\/naso\.mdc/);
  });
});

test('a file a person keeps is appended to below what is there, and a tracked one is left with advice', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, '.github/copilot-instructions.md', '# Ours\n\nUse tabs.\n');
    const res = await naso(['agents', 'copilot', dir], dir);
    assert.equal(res.code, 0, res.stderr);
    const text = await read(dir, '.github/copilot-instructions.md');
    assert.ok(text.startsWith('# Ours\n\nUse tabs.\n\n<!-- naso:start -->\n'), text);
  });
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'GEMINI.md', '# Team notes\n');
    await git('add', 'GEMINI.md');
    await git('commit', '-qm', 'gemini');
    const res = await naso(['agents', 'gemini', dir], dir);
    assert.equal(await read(dir, 'GEMINI.md'), '# Team notes\n', 'tracked file untouched in a local run');
    assert.match(res.stdout, /tracked in git[^]*@AGENTS\.md/);
    await naso(['agents', 'gemini', dir, '--track'], dir);
    assert.match(await read(dir, 'GEMINI.md'), /^# Team notes\n\n<!-- naso:start -->/);
  });
});

test('an agent already sent to AGENTS.md, by any of its files or by its settings, gets nothing', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, '.cursorrules', 'Follow AGENTS.md.\n');
    await put(dir, '.gemini/settings.json', JSON.stringify({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } }));
    const res = await naso(['agents', 'cursor', 'gemini', dir], dir);
    assert.equal(await exists(dir, '.cursor/rules/naso.mdc'), false);
    assert.equal(await exists(dir, 'GEMINI.md'), false);
    assert.match(res.stdout, /\.cursorrules already points at AGENTS\.md/);
    assert.match(res.stdout, /\.gemini\/settings\.json already points at AGENTS\.md/);
  });
});

test('running it twice writes the pointer once', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, '.github/copilot-instructions.md', '# Ours\n');
    await naso(['agents', 'all', dir, '--track'], dir);
    const first = await Promise.all(POINTER_FILES.map((file) => read(dir, file)));
    await naso(['agents', 'all', dir, '--track'], dir);
    assert.deepEqual(await Promise.all(POINTER_FILES.map((file) => read(dir, file))), first);
  });
});

test('agents with no name reports what the repository uses, writes nothing, and codex needs no file', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, '.windsurf/.keep', '');
    await put(dir, '.codex/config.toml', '');
    const res = await naso(['agents', dir], dir);
    assert.match(res.stdout, /Windsurf\s+\.windsurf — does not load AGENTS\.md/);
    assert.match(res.stdout, /Codex\s+\.codex — reads AGENTS\.md itself/);
    assert.equal(await exists(dir, '.windsurf/rules'), false);
    const codex = await naso(['agents', 'codex', dir], dir);
    assert.match(codex.stdout, /Codex: reads AGENTS\.md itself; nothing to write/);
    const bad = await naso(['agents', 'cursr', dir], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /'cursr' is not an agent NASO knows/);
  });
});

test('setup writes pointers only when asked, lists them in its plan, and names a detected agent', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, '.cursor/.keep', '');
    const res = await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    for (const file of POINTER_FILES) assert.equal(await exists(dir, file), false, `${file}: opt-in only`);
    assert.match(res.stdout, /Cursor is set up here \(\.cursor\)\. `--agents cursor` points it at AGENTS\.md/);
  });
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await driveFlow(dir, { args: ['--yes', '--no-hook', '--agents', 'cursor,gemini'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\.cursor\/rules\/naso\.mdc/);
    assert.equal(await read(dir, '.cursor/rules/naso.mdc'), pointerContent(AGENTS.cursor));
    assert.match(await read(dir, 'GEMINI.md'), /@AGENTS\.md/);
    assert.equal(await exists(dir, '.github/copilot-instructions.md'), false);
  });
});

test('in a terminal, setup asks about other agents, Enter answers No, and the detected ones can be picked', async () => {
  const none = { state: 'none' };
  const agents = [{ name: 'cursor', label: 'Cursor', signs: ['.cursor'] }];
  const defaults = await answerRealQuestions({ hook: none, hasBlock: false, agents }, ['\r', '\r', '\r']);
  assert.equal(defaults.answer.agents, undefined);
  assert.match(defaults.frames, /Point other agents at AGENTS\.md/);
  assert.match(defaults.frames, /The ones set up here: Cursor/);

  const picked = await answerRealQuestions({ hook: none, hasBlock: false, agents }, ['\r', '\r', '\u001b[B', '\r']);
  assert.deepEqual(picked.answer.agents, ['cursor']);

  const all = await answerRealQuestions({ hook: none, hasBlock: false, agents: [] }, ['\r', '\r', '\u001b[B', '\r']);
  assert.deepEqual(all.answer.agents, ['all']);
});

for (const fixture of FIXTURES.filter((entry) => entry.git !== 'none')) {
  test(`agents all works in the ${fixture.name} fixture`, async () => {
    await withFixture(fixture, async ({ dir }) => {
      const res = await naso(['agents', 'all', dir], dir);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      for (const file of POINTER_FILES) assert.ok(await exists(dir, file), `${fixture.name}: ${file}`);
    });
  });
}

test('a Copilot pointer committed where there was no .github/ does not make .github/ an area', async () => {
  const { topLevelEntries } = await import('../tooling/scan.mjs');
  const names = (files) => topLevelEntries(files).filter((entry) => entry.isDir).map((entry) => entry.name);
  assert.deepEqual(names(['.github/copilot-instructions.md', '.github/instructions/go.instructions.md', 'src/a.js']), ['src']);
  assert.deepEqual(names(['.github/copilot-instructions.md', '.github/workflows/ci.yml', 'src/a.js']), ['.github', 'src']);

  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await naso([dir, '--yes', '--no-hook', '--track'], dir);
    await naso(['agents', 'copilot', dir, '--track'], dir);
    await git('add', '-A');
    await git('commit', '-qm', 'pointer');
    const res = await naso(['briefing', dir], dir);
    assert.equal(res.code, 0, res.stdout);
    assert.doesNotMatch(res.stdout, /UNCOVERED/);
  });
});
