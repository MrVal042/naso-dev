// Claude Code extras: deny rules, session hooks and skills. All opt-in, all merged into
// files the person may already have, none of them needed for NASO to work.
//
// Deny rules go to .claude/settings.local.json: which owners "we" are is per person, and a
// shared file would deny the same paths to every teammate. Hooks run the vendored toolset
// in exec form (no shell), so the same entry works on macOS, Linux and Windows, and they
// exit 0 whatever happens. A file NASO did not write is never overwritten.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, writeFile, utimes } from 'node:fs/promises';
import { withRepo, put, read, exists, naso, seedProject, driveFlow, exec, TOOL_DIR, answerRealQuestions } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';
import { denyRule, mergeDeny, mergeHooks, SKILL_NAMES } from '../tooling/claude.mjs';

const LOCAL = '.claude/settings.local.json';
const SHARED = '.claude/settings.json';
const json = async (dir, rel) => JSON.parse(await read(dir, rel));

async function ownersRepo(dir, git) {
  await seedProject(dir, git);
  await put(dir, 'infra/main.tf', 'terraform {}\n');
  await put(dir, 'docs/a.md', '# a\n');
  await put(dir, '.github/CODEOWNERS', '* @us\n/infra/ @ops\n/docs/a.md @writers\n');
  await git('add', '-A');
  await git('commit', '-qm', 'owners');
}

function runHook(dir, event, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TOOL_DIR, 'session-hook.mjs'), event], {
      cwd: dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('a folder is denied as Edit(/folder/**), a file as Edit(/file), anchored at the project root', () => {
  assert.equal(denyRule({ path: 'infra', dir: true }), 'Edit(/infra/**)');
  assert.equal(denyRule({ path: 'docs/a.md', dir: false }), 'Edit(/docs/a.md)');
  assert.equal(denyRule({ path: 'odd*name.js', dir: false }), null, 'a glob character in a name cannot be written safely');
  assert.equal(denyRule({ path: '#notes', dir: false }), null);
});

test('merging keeps the person\'s rules and keys in order, and removes only what NASO added before', () => {
  const settings = { model: 'x', permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)', 'Edit(/infra/**)'] } };
  const first = mergeDeny(settings, ['Edit(/infra/**)', 'Edit(/docs/a.md)'], []);
  assert.deepEqual(first.settings.permissions.deny, ['Read(./.env)', 'Edit(/infra/**)', 'Edit(/docs/a.md)']);
  assert.deepEqual(first.added, ['Edit(/docs/a.md)'], 'a rule the person already had is not NASO\'s');
  assert.deepEqual(Object.keys(first.settings), ['model', 'permissions']);

  const second = mergeDeny(first.settings, ['Edit(/infra/**)'], first.added);
  assert.deepEqual(second.settings.permissions.deny, ['Read(./.env)', 'Edit(/infra/**)']);
  assert.deepEqual(second.removed, ['Edit(/docs/a.md)']);
});

test('naso-dev claude --deny writes the rules to settings.local.json and keeps it out of git', async () => {
  await withRepo(async ({ dir, git }) => {
    await ownersRepo(dir, git);
    await put(dir, LOCAL, '{\n    "permissions": {\n        "deny": ["Read(./.env)"]\n    }\n}\n');
    const res = await naso(['claude', dir, '--deny', '--owners', '@us'], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, LOCAL);
    assert.match(text, /^\{\n {4}"permissions"/, 'the file keeps its own indentation');
    assert.deepEqual((await json(dir, LOCAL)).permissions.deny, ['Read(./.env)', 'Edit(/docs/a.md)', 'Edit(/infra/**)']);
    assert.match(res.stdout, /2 deny rules/);
    const ignored = await exec('git', ['check-ignore', '-q', LOCAL], dir);
    assert.equal(ignored.code, 0, 'settings.local.json must not be committable by accident');
    const config = await json(dir, '.naso/config.json');
    assert.deepEqual(config.claude.deny.owners, ['@us']);
    assert.deepEqual(config.claude.deny.rules, ['Edit(/docs/a.md)', 'Edit(/infra/**)']);
  });
});

test('NASO_SCOPE is the source when no owners are given', async () => {
  await withRepo(async ({ dir, git }) => {
    await ownersRepo(dir, git);
    const res = await exec(process.execPath, [path.join(TOOL_DIR, '..', 'bin', 'naso-dev.mjs'), 'claude', dir, '--deny'], dir, { NASO_SCOPE: 'src' });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const deny = (await json(dir, LOCAL)).permissions.deny;
    assert.ok(deny.includes('Edit(/infra/**)') && deny.includes('Edit(/docs/**)') && deny.includes('Edit(/package.json)'), deny.join('\n'));
    assert.ok(!deny.some((rule) => /AGENTS|\.naso|\/src/.test(rule)));
  });
});

test('with nothing to go on, --deny writes nothing and says what it needs', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await exec(process.execPath, [path.join(TOOL_DIR, '..', 'bin', 'naso-dev.mjs'), 'claude', dir, '--deny'], dir, { NASO_SCOPE: '' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /no CODEOWNERS and no NASO_SCOPE/i);
    assert.equal(await exists(dir, LOCAL), false);
  });
});

test('a settings file that is not valid JSON is left alone, and the command says so', async () => {
  await withRepo(async ({ dir, git }) => {
    await ownersRepo(dir, git);
    await put(dir, LOCAL, '{ "permissions": { // a comment\n } }\n');
    const before = await read(dir, LOCAL);
    const res = await naso(['claude', dir, '--deny', '--owners', '@us'], dir);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /not valid JSON/);
    assert.equal(await read(dir, LOCAL), before);
  });
});

test('a path that cannot be written as a rule is reported, not guessed at', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'odd[1].txt', 'x\n');
    await git('add', '-A');
    await git('commit', '-qm', 'odd');
    const res = await exec(process.execPath, [path.join(TOOL_DIR, '..', 'bin', 'naso-dev.mjs'), 'claude', dir, '--deny'], dir, { NASO_SCOPE: 'src' });
    assert.match(res.stdout, /odd\[1\]\.txt.*cannot be written as a rule/);
  });
});

test('hooks run the vendored toolset in exec form, and a second run adds nothing', () => {
  const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  const once = mergeHooks(user);
  const twice = mergeHooks(once);
  assert.deepEqual(twice, once);
  const start = once.hooks.SessionStart[0].hooks[0];
  assert.equal(start.command, 'node', 'exec form: no shell, the same on every platform');
  assert.deepEqual(start.args, ['${CLAUDE_PROJECT_DIR}/.naso/tooling/session-hook.mjs', 'start']);
  assert.equal(once.hooks.Stop.length, 2, 'the person\'s Stop hook is kept');
  assert.equal(once.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.ok(start.timeout <= 15);
});

test('hooks go to settings.local.json when .naso/ is local, and to settings.json with --track', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    assert.equal((await naso(['claude', dir, '--hooks'], dir)).code, 0);
    assert.ok((await json(dir, LOCAL)).hooks.SessionStart);
    assert.equal(await exists(dir, SHARED), false);
  });
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook', '--track'] });
    assert.equal((await naso(['claude', dir, '--hooks'], dir)).code, 0);
    assert.ok((await json(dir, SHARED)).hooks.Stop);
  });
});

test('hooks are refused, and no hook written, while the vendored toolset lacks the hook script', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await naso(['claude', dir, '--hooks', '--skills'], dir);
    assert.equal(res.code, 1, res.stdout);
    assert.match(res.stderr, /\.naso\/tooling\/session-hook\.mjs is not there.*refresh/);
    assert.equal((await exists(dir, LOCAL)) && Boolean((await json(dir, LOCAL)).hooks), false, 'a hook that cannot run is not written');
    assert.ok(await exists(dir, '.claude/skills/naso-handoff/SKILL.md'), 'the other extras still are');
  });
});

test('doctor warns when hooks are set up but their script is gone', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook', '--claude-hooks'] });
    assert.match((await naso(['doctor', dir], dir)).stdout, /OK\s+Claude hooks/);
    await (await import('node:fs/promises')).rm(path.join(dir, '.naso/tooling/session-hook.mjs'));
    assert.match((await naso(['doctor', dir], dir)).stdout, /WARN\s+Claude hooks\s+.*session-hook\.mjs.*refresh/);
  });
});

test('the SessionStart hook prints the handoff NOW and one line about the briefing, and exits 0', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    await naso(['handoff', 'set', 'Parser in review.\n- [ ] Changelog', dir], dir);
    const res = await runHook(dir, 'start', { session_id: 's1', hook_event_name: 'SessionStart' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Parser in review\./);
    assert.match(res.stdout, /\(1\) Changelog/);
    assert.match(res.stdout, /briefing: consistent/i);
  });
});

test('the hooks exit 0 with no output that misleads when there is nothing to work with', async () => {
  await withFixture(FIXTURES.find((entry) => entry.name === 'non-git-parent'), async ({ dir }) => {
    for (const event of ['start', 'stop', 'nonsense']) {
      const res = await runHook(dir, event, { session_id: 'x' });
      assert.equal(res.code, 0, `${event}: ${res.stderr}`);
    }
  });
  await withRepo(async ({ dir }) => {
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(TOOL_DIR, 'session-hook.mjs'), 'stop'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('close', (code) => resolve({ code }));
      child.stdin.end('not json at all');
    });
    assert.equal(res.code, 0);
  });
});

test('the Stop hook reminds once when files changed and the handoff did not', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await naso(['handoff', 'set', 'State.', dir], dir);
    const session = { session_id: `s-${Date.now()}` };
    await runHook(dir, 'start', { ...session, hook_event_name: 'SessionStart' });
    // A clock that moves on: the edit must be newer than the session start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await put(dir, 'src/index.ts', 'export const x = 2;\n');
    const future = new Date(Date.now() + 2000);
    await utimes(path.join(dir, 'src/index.ts'), future, future);

    const first = await runHook(dir, 'stop', { ...session, hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(first.code, 0, first.stderr);
    const out = JSON.parse(first.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
    assert.match(out.hookSpecificOutput.additionalContext, /src\/index\.ts/);
    assert.match(out.hookSpecificOutput.additionalContext, /handoff set/);

    const again = await runHook(dir, 'stop', { ...session, hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(again.stdout.trim(), '', 'once per session');
  });
});

test('the Stop hook says nothing when the handoff was updated, or when it is already continuing', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const session = { session_id: `t-${Date.now()}` };
    await runHook(dir, 'start', session);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await put(dir, 'src/index.ts', 'export const x = 3;\n');
    const future = new Date(Date.now() + 2000);
    await utimes(path.join(dir, 'src/index.ts'), future, future);
    const active = await runHook(dir, 'stop', { ...session, stop_hook_active: true });
    assert.equal(active.stdout.trim(), '');

    await naso(['handoff', 'set', 'Updated before stopping.', dir], dir);
    const located = (await naso(['handoff', 'path', dir], dir)).stdout.trim();
    const later = new Date(Date.now() + 4000);
    await utimes(located, later, later);
    const updated = await runHook(dir, 'stop', { ...session, stop_hook_active: false });
    assert.equal(updated.stdout.trim(), '');
  });
});

test('skills are written with name and description, and one NASO did not write is never replaced', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, '.claude/skills/naso-decide/SKILL.md', '---\nname: naso-decide\ndescription: mine\n---\n\nMy own version.\n');
    const res = await naso(['claude', dir, '--skills'], dir);
    assert.equal(res.code, 0, res.stderr);
    for (const name of SKILL_NAMES.filter((skill) => skill !== 'naso-decide')) {
      const text = await read(dir, `.claude/skills/${name}/SKILL.md`);
      assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: \\S`), name);
    }
    assert.match(await read(dir, '.claude/skills/naso-decide/SKILL.md'), /My own version/);
    assert.match(res.stdout, /naso-decide.*not written by NASO, left as it is/);
    const prePr = await read(dir, '.claude/skills/naso-pre-pr/SKILL.md');
    for (const word of ['git ls-remote', 'network', 'disk', 'database', 'subprocess', 'concurren', 'secret']) {
      assert.match(prePr, new RegExp(word, 'i'), word);
    }
    assert.doesNotMatch(prePr, /npm |pytest|cargo |go test/, 'the checklist suits any language');
  });
});

test('doctor reports drift between ownership and the deny rules, and the command that fixes it', async () => {
  await withRepo(async ({ dir, git }) => {
    await ownersRepo(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    await naso(['claude', dir, '--deny', '--owners', '@us'], dir);
    assert.match((await naso(['doctor', dir], dir)).stdout, /OK\s+Claude deny rules\s+2 rules match/);

    await put(dir, '.github/CODEOWNERS', '* @us\n/infra/ @ops\n/docs/ @writers\n/src/ @ops\n');
    await git('add', '-A');
    await git('commit', '-qm', 'owners changed');
    const drift = (await naso(['doctor', dir], dir)).stdout;
    assert.match(drift, /WARN\s+Claude deny rules\s+.*not denied/);
    assert.match(drift, /naso-dev claude --deny/);
  });
});

test('setup writes no Claude extras unless asked, and writes the ones asked for, in its plan', async () => {
  await withRepo(async ({ dir, git }) => {
    await ownersRepo(dir, git);
    await driveFlow(dir, { args: ['--yes', '--no-hook'] });
    assert.equal(await exists(dir, '.claude'), false, 'opt-in only');
  });
  await withRepo(async ({ dir, git }) => {
    await ownersRepo(dir, git);
    const res = await driveFlow(dir, { args: ['--yes', '--no-hook', '--claude-deny', '--owners', '@us', '--claude-hooks', '--claude-skills'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\.claude\/settings\.local\.json/);
    assert.match(res.stdout, /\.claude\/skills\//);
    const local = await json(dir, LOCAL);
    assert.ok(local.permissions.deny.includes('Edit(/infra/**)'));
    assert.ok(local.hooks.SessionStart);
    assert.ok(await exists(dir, '.claude/skills/naso-sweep/SKILL.md'));
  });
});

test('in a terminal, setup asks about each extra, Enter answers No, and an owner can be picked', async () => {
  const none = { state: 'none' };
  const claude = { owners: ['@ops', '@us'], scope: [] };
  const defaults = await answerRealQuestions({ hook: none, hasBlock: false, claude }, ['\r', '\r', '\r', '\r', '\r']);
  assert.equal(defaults.answer.claudeDeny, undefined);
  assert.equal(defaults.answer.claudeHooks, false);
  assert.equal(defaults.answer.claudeSkills, false);
  assert.match(defaults.frames, /deny edits to paths that are not yours/);

  // Down twice: past No and @ops, to @us. Then yes to hooks, no to skills.
  const picked = await answerRealQuestions({ hook: none, hasBlock: false, claude }, ['\r', '\r', '\u001b[B', '\u001b[B', '\r', 'y', 'n']);
  assert.equal(picked.answer.claudeDeny, true);
  assert.deepEqual(picked.answer.owners, ['@us']);
  assert.equal(picked.answer.claudeHooks, true);
  assert.equal(picked.answer.claudeSkills, false);

  // No CODEOWNERS owners and no scope: the deny question is not asked at all.
  const noOwners = await answerRealQuestions({ hook: none, hasBlock: false, claude: { owners: [], scope: [] } }, ['\r', '\r', '\r', '\r']);
  assert.doesNotMatch(noOwners.frames, /deny edits/);
});

for (const fixture of FIXTURES) {
  test(`claude --skills, and the hooks, work in the ${fixture.name} fixture`, async () => {
    await withFixture(fixture, async ({ dir }) => {
      const res = await naso(['claude', dir, '--skills'], dir);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.ok(await exists(dir, '.claude/skills/naso-handoff/SKILL.md'));
      const start = await runHook(dir, 'start', { session_id: 'm' });
      assert.equal(start.code, 0, start.stderr);
    });
  });
}
