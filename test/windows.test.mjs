// How NASO starts other programs on Windows, tested on any platform.
//
// npm, npx, pnpm, yarn and bun are .cmd files on Windows. Node will not spawn a .cmd
// without a shell (EINVAL since Node 18.20.2 and 20.12.2), so with `shell: false`
// everywhere, `--save-dev` and the gate's Format and Lint steps could never run there.
// The plan is a pure function of the platform, PATH, PATHEXT and the files that exist,
// so these tests run on macOS and Linux too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnPlan, windowsQuote } from '../tooling/lib.mjs';

const winEnv = { Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const files = (...paths) => (candidate) => paths.map((p) => p.toLowerCase()).includes(candidate.toLowerCase());

test('off Windows, a command is spawned as it is, with no shell', () => {
  assert.deepEqual(spawnPlan('npm', ['install'], { platform: 'linux', env: {}, isFile: () => false }), {
    cmd: 'npm',
    args: ['install'],
    shell: false,
  });
});

test('on Windows, an .exe found on Path is spawned directly, with no shell', () => {
  const plan = spawnPlan('git', ['status'], { platform: 'win32', env: winEnv, isFile: files('C:\\Windows\\System32\\git.EXE') });
  assert.equal(plan.shell, false);
  assert.match(plan.cmd, /git\.EXE$/i);
  assert.deepEqual(plan.args, ['status']);
});

test('on Windows, a .cmd found on Path runs through the shell with every argument quoted', () => {
  const plan = spawnPlan('npm', ['install', '--save-dev', 'naso-dev@1.6.0'], {
    platform: 'win32',
    env: winEnv,
    isFile: files('C:\\Program Files\\nodejs\\npm.CMD'),
  });
  assert.equal(plan.shell, true);
  assert.deepEqual(plan.args, []);
  assert.equal(plan.cmd, '"C:\\Program Files\\nodejs\\npm.CMD" "install" "--save-dev" "naso-dev@1.6.0"');
});

test('PATHEXT order decides between an .exe and a .cmd of the same name', () => {
  const plan = spawnPlan('bun', [], {
    platform: 'win32',
    env: winEnv,
    isFile: files('C:\\Program Files\\nodejs\\bun.EXE', 'C:\\Program Files\\nodejs\\bun.CMD'),
  });
  assert.equal(plan.shell, false);
});

test('a command that is not on Path is left for spawn to report, unchanged', () => {
  assert.deepEqual(spawnPlan('missing', ['x'], { platform: 'win32', env: winEnv, isFile: () => false }), {
    cmd: 'missing',
    args: ['x'],
    shell: false,
  });
});

test('arguments with spaces, quotes and shell operators stay one argument each', () => {
  assert.equal(windowsQuote('src/a file.ts'), '"src/a file.ts"');
  assert.equal(windowsQuote('say "hi"'), '"say ""hi"""');
  assert.equal(windowsQuote('a&b|c>d'), '"a&b|c>d"');
});
