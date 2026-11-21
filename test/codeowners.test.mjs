// Which paths are someone else's: CODEOWNERS and NASO_SCOPE, turned into paths to deny.
//
// A deny rule that is wrong in the strict direction blocks an agent from its own work; one
// that is wrong in the loose direction lets it edit another team's code. So every glob is
// read with the semantics its file format has, last match wins, a pattern this cannot
// translate is reported and denies nothing, and a whole directory is denied only when no
// rule could ever hand a path under it back to us.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodeowners, matchesPattern, deniedPaths } from '../tooling/codeowners.mjs';

const matches = (pattern, file) => matchesPattern(pattern, file);

test('patterns match the way GitHub documents them', () => {
  // `/build/logs/` — the directory at the root and everything under it.
  assert.ok(matches('/build/logs/', 'build/logs/a.txt'));
  assert.ok(matches('/build/logs/', 'build/logs/deep/b.txt'));
  assert.ok(!matches('/build/logs/', 'src/build/logs/a.txt'));
  // `docs/*` — files directly in docs/ at the root, not nested ones.
  assert.ok(matches('docs/*', 'docs/getting-started.md'));
  assert.ok(!matches('docs/*', 'docs/build-app/troubleshooting.md'));
  assert.ok(!matches('docs/*', 'src/docs/a.md'));
  // `apps/` — an apps directory anywhere.
  assert.ok(matches('apps/', 'apps/a.js'));
  assert.ok(matches('apps/', 'packages/x/apps/b.js'));
  // `**/logs` — a logs directory anywhere, and what is under it.
  assert.ok(matches('**/logs', 'build/logs/x'));
  assert.ok(matches('**/logs', 'deeply/nested/logs/y'));
  assert.ok(matches('**/logs', 'logs/z'));
  // `*.js` — a file name anywhere.
  assert.ok(matches('*.js', 'a.js'));
  assert.ok(matches('*.js', 'src/deep/b.js'));
  assert.ok(!matches('*.js', 'src/b.jsx'));
  // `*` and `?` never cross a slash; `a/**/b` spans zero or more folders.
  assert.ok(!matches('/src/*.ts', 'src/deep/a.ts'));
  assert.ok(matches('/src/?.ts', 'src/a.ts'));
  assert.ok(matches('/a/**/b', 'a/b'));
  assert.ok(matches('/a/**/b', 'a/x/y/b'));
  assert.ok(matches('/a/**', 'a/x/y'));
  // A pattern naming a directory without a trailing slash still covers its contents.
  assert.ok(matches('/docs', 'docs/a.md'));
  assert.ok(matches('/docs', 'docs'));
});

test('parse reads owners, skips comments, and reports what it cannot translate, by line', () => {
  const { entries, skipped } = parseCodeowners('# comment\n\n*.js @js\n!keep.js @nobody\n/src/[ab].ts @x\n/a\\ b/ @y\n/docs/ @docs # trailing\n');
  assert.deepEqual(entries.map((entry) => [entry.pattern, entry.owners, entry.line]), [['*.js', ['@js'], 3], ['/docs/', ['@docs'], 7]]);
  assert.deepEqual(skipped.map((entry) => entry.line), [4, 5, 6]);
  assert.ok(skipped.every((entry) => entry.reason));
});

test('last match wins, and a pattern with no owners makes its paths nobody\'s', () => {
  const codeowners = parseCodeowners('* @everyone\n/apps/ @octocat\n/apps/github\n/apps/mine/ @us\n');
  const files = ['README.md', 'apps/a.js', 'apps/github/b.js', 'apps/mine/c.js'];
  const { denied } = deniedPaths({ files, codeowners, owners: ['@us'] });
  assert.deepEqual(denied.files.sort(), ['README.md', 'apps/a.js'], 'unowned paths and our own are left editable');
});

test('GitLab sections are evaluated separately, and a section\'s default owners apply to its bare lines', () => {
  const codeowners = parseCodeowners('[Backend] @backend\n/src/\n/api/ @api\n\n^[Docs][2] @writers\n/docs/\n/src/README.md\n');
  assert.deepEqual(codeowners.entries.map((entry) => [entry.pattern, entry.owners, entry.section]), [
    ['/src/', ['@backend'], 'Backend'],
    ['/api/', ['@api'], 'Backend'],
    ['/docs/', ['@writers'], 'Docs'],
    ['/src/README.md', ['@writers'], 'Docs'],
  ]);
  const files = ['src/a.ts', 'src/README.md', 'api/b.ts', 'docs/c.md'];
  const { denied } = deniedPaths({ files, codeowners, owners: ['@writers'] });
  // src/README.md is ours in the Docs section, so it stays editable though Backend owns src/.
  assert.deepEqual(denied.files.sort(), ['api/b.ts', 'src/a.ts']);
});

test('owners match without regard to case', () => {
  const codeowners = parseCodeowners('/src/ @Org/Core\n');
  assert.deepEqual(deniedPaths({ files: ['src/a.ts'], codeowners, owners: ['@org/core'] }).denied.files, []);
});

test('a whole folder is one rule only when nothing under it could ever be ours', () => {
  const codeowners = parseCodeowners('/infra/ @ops\n/legacy/old.js @ops\n/vendor/ @ops\n/vendor/*.md @us\n');
  const files = ['infra/main.tf', 'infra/net/vpc.tf', 'legacy/old.js', 'legacy/new.js', 'vendor/lib.js', 'vendor/README.md', 'src/a.ts'];
  const { rules, notes } = deniedPaths({ files, codeowners, owners: ['@us'] });
  assert.deepEqual(rules, [
    { path: 'infra', dir: true },
    { path: 'legacy/old.js', dir: false },
    { path: 'vendor/lib.js', dir: false },
  ]);
  // vendor/ cannot be one rule: /vendor/*.md is ours, so vendor/README.md and any new .md
  // file there must stay editable. The note says new files there are not covered.
  assert.ok(notes.some((note) => /vendor\//.test(note)), notes.join('\n'));
});

test('an ours-pattern that could match anywhere keeps every folder from being one rule', () => {
  const codeowners = parseCodeowners('/infra/ @ops\n*.md @us\n');
  const { rules } = deniedPaths({ files: ['infra/main.tf'], codeowners, owners: ['@us'] });
  assert.deepEqual(rules, [{ path: 'infra/main.tf', dir: false }], 'a future infra/README.md would be ours');
});

test('a path an untranslatable pattern might match is never denied, and the line is reported', () => {
  const codeowners = parseCodeowners('* @ops\n/src/[ab].ts @us\n');
  const files = ['src/a.ts', 'src/c.ts', 'README.md'];
  const { denied, skipped } = deniedPaths({ files, codeowners, owners: ['@us'] });
  assert.ok(!denied.files.includes('src/a.ts'), 'it might be ours');
  assert.ok(denied.files.includes('README.md'));
  assert.equal(skipped[0].line, 2);
});

test('NASO_SCOPE denies everything outside its prefixes, a folder at a time where it can', () => {
  const files = ['apps/web/a.ts', 'apps/api/b.ts', 'docs/c.md', 'package.json', 'apps/web/deep/d.ts'];
  const { rules, source } = deniedPaths({ files, scope: ['apps/web'] });
  assert.equal(source, 'scope');
  assert.deepEqual(rules, [
    { path: 'apps/api', dir: true },
    { path: 'docs', dir: true },
    { path: 'package.json', dir: false },
  ]);
});

test('NASO\'s own files are never denied: the agent keeps the briefing and the handoff current', () => {
  const codeowners = parseCodeowners('* @ops\n');
  const files = ['AGENTS.md', 'CLAUDE.md', '.naso/HANDOFF.md', '.naso/lessons/a.md', 'src/a.ts'];
  const { denied } = deniedPaths({ files, codeowners, owners: ['@us'] });
  assert.deepEqual(denied.files, ['src/a.ts']);
  const scoped = deniedPaths({ files, scope: ['src'] });
  assert.ok(!scoped.denied.files.some((file) => /AGENTS|CLAUDE|\.naso/.test(file)));
});

test('no CODEOWNERS and no scope, or owners not given, mean no rules', () => {
  assert.equal(deniedPaths({ files: ['a.ts'] }).rules.length, 0);
  assert.equal(deniedPaths({ files: ['a.ts'] }).source, null);
  const codeowners = parseCodeowners('* @ops\n');
  assert.equal(deniedPaths({ files: ['a.ts'], codeowners, owners: [] }).rules.length, 0, 'nobody said who we are');
});
