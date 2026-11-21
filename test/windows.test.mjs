// How NASO starts other programs on Windows, tested on any platform.
//
// npm, npx, pnpm, yarn and bun are .cmd files on Windows. Node 18.20.2, 20.12.2 and 21.7.3
// and later refuse to spawn a .cmd or .bat without a shell (EINVAL), after CVE-2024-27980
// ("BatBadBut"): cmd.exe reads %, ^, &, |, <, >, ( ) and quotes in its arguments as syntax,
// so quoting alone lets an argument run a command. NASO escapes the way cross-spawn does
// and runs cmd.exe itself with verbatim arguments. The plan is a pure function of the
// platform, PATH, PATHEXT and the files that exist, so most of these tests run anywhere;
// the last one runs a real .cmd and only runs on Windows.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { spawnPlan, escapeArgument, escapeCommand, run } from '../tooling/lib.mjs';

const winEnv = { Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
const files = (...paths) => (candidate) => paths.map((p) => p.toLowerCase()).includes(candidate.toLowerCase());

test('off Windows, a command is spawned as it is, with no shell', () => {
  assert.deepEqual(spawnPlan('npm', ['install'], { platform: 'linux', env: {}, isFile: () => false }), {
    cmd: 'npm',
    args: ['install'],
    shell: false,
    verbatim: false,
  });
});

test('on Windows, an .exe found on Path is spawned directly, with no shell', () => {
  const plan = spawnPlan('git', ['status', 'a&b'], { platform: 'win32', env: winEnv, isFile: files('C:\\Windows\\System32\\git.EXE') });
  assert.equal(plan.shell, false);
  assert.equal(plan.verbatim, false);
  assert.match(plan.cmd, /git\.EXE$/i);
  assert.deepEqual(plan.args, ['status', 'a&b'], 'no shell reads an .exe argument, so none is escaped');
});

test('on Windows, a .cmd runs as ComSpec /d /s /c with one escaped line and verbatim arguments', () => {
  const plan = spawnPlan('npm', ['install', '--save-dev', 'naso-dev@1.6.0'], {
    platform: 'win32',
    env: winEnv,
    isFile: files('C:\\Program Files\\nodejs\\npm.CMD'),
  });
  assert.equal(plan.cmd, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(plan.shell, false);
  assert.equal(plan.verbatim, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    plan.args[3],
    '"C:\\Program^ Files\\nodejs\\npm.CMD ^^^"install^^^" ^^^"--save-dev^^^" ^^^"naso-dev@1.6.0^^^""',
  );
});

test('every cmd.exe metacharacter in an argument is escaped, twice for a .cmd shim', () => {
  const cases = [
    ['a b', '^"a^ b^"'],
    ['x&y', '^"x^&y^"'],
    ['a|b', '^"a^|b^"'],
    ['<in>', '^"^<in^>^"'],
    ['100%PATH%', '^"100^%PATH^%^"'],
    ['c^d', '^"c^^d^"'],
    ['(p)', '^"^(p^)^"'],
    ['say "hi"', '^"say^ \\^"hi\\^"^"'],
    ['dir\\', '^"dir\\\\^"'],
    ['a\\"b', '^"a\\\\\\^"b^"'],
  ];
  for (const [arg, once] of cases) {
    assert.equal(escapeArgument(arg, false), once, arg);
    assert.equal(escapeArgument(arg, true), once.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1'), `${arg}, doubled`);
  }
});

test('the command path is escaped too, so a folder named with & cannot split the line', () => {
  assert.equal(escapeCommand('C:\\a&b (x)\\npm.cmd'), 'C:\\a^&b^ ^(x^)\\npm.cmd');
});

test('PATHEXT order decides between an .exe and a .cmd of the same name', () => {
  const plan = spawnPlan('bun', [], {
    platform: 'win32',
    env: winEnv,
    isFile: files('C:\\Program Files\\nodejs\\bun.EXE', 'C:\\Program Files\\nodejs\\bun.CMD'),
  });
  assert.equal(plan.verbatim, false);
});

test('a command that is not on Path is left for spawn to report, unchanged', () => {
  assert.deepEqual(spawnPlan('missing', ['x'], { platform: 'win32', env: winEnv, isFile: () => false }), {
    cmd: 'missing',
    args: ['x'],
    shell: false,
    verbatim: false,
  });
});

const HOSTILE = ['plain', 'with space', 'a&b', 'a|b', '<x>', '100%PATH%', 'c^d', '(paren)', 'say "hi"', 'trailing\\', 'x;y,z', '!bang!', '*?'];

/**
 * A .cmd that forwards %* to node, like every package-manager shim, in a folder whose name
 * has a space, an ampersand and parentheses. What reaches node must be the arguments as
 * given, each one whole, and nothing may have run as a command.
 */
test('a real .cmd shim receives every hostile argument exactly, and runs nothing else', { skip: process.platform !== 'win32' && 'needs cmd.exe' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'naso-cmd-'));
  try {
    const bin = path.join(root, 'odd & dir (1)');
    await mkdir(bin, { recursive: true });
    const out = path.join(root, 'argv.json');
    const dump = path.join(bin, 'dump.cjs');
    await writeFile(dump, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
    await writeFile(path.join(bin, 'fakepm.cmd'), `@"${process.execPath}" "${dump}" %*\r\n`);
    const saved = process.env.Path ?? process.env.PATH;
    process.env.Path = `${bin};${saved}`;
    try {
      const res = await run('fakepm', HOSTILE, { cwd: root });
      assert.equal(res.ok, true, res.stderr);
    } finally {
      process.env.Path = saved;
    }
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), HOSTILE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('on any platform, run() passes hostile arguments through to the program unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'naso-argv-'));
  try {
    const out = path.join(root, 'argv.json');
    const dump = path.join(root, 'dump.cjs');
    await writeFile(dump, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
    const res = await run(process.execPath, [dump, ...HOSTILE], { cwd: root });
    assert.equal(res.ok, true, res.stderr);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), HOSTILE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
