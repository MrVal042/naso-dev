// The layered block: a root every session reads, and guides read when a task needs them.
//
// Every token in AGENTS.md is read at the start of every session. Since 2.0.0 the block
// keeps what every session needs and a When You Touch table names the guide in .naso/guides/
// for each kind of task. These tests hold the split to its promises: nothing is said twice,
// every guide the block links exists and is checked, a guide people edited is never lost,
// and an older block moves into guides word for word.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createBriefing } from '../tooling/briefing.mjs';
import { ROOT_LINE_BUDGET, TOUCH_HEADING, splitSections } from '../tooling/guides.mjs';
import { NASO_END, NASO_START } from '../tooling/scan.mjs';
import { AGENTS, withRepo, put, read, exists, naso, seedProject, sectionOf, driveFlow } from './helpers.mjs';

const GUIDE = (name) => `.naso/guides/${name}.md`;
const textLines = (block) => block.split('\n').filter((line) => line.trim() !== '' && !/^<!--.*-->$/.test(line.trim())).length;

/** A project with a decision, a committed env template, a CONTRIBUTING rule and a documented source tree. */
async function seedRich(dir, git) {
  await seedProject(dir, git);
  await put(dir, '.env.example', 'API_URL=\n');
  await put(dir, 'CONTRIBUTING.md', '# Contributing\n\nOne ticket per pull request.\n');
  await put(dir, 'src/api/client.ts', 'export {};\n');
  await put(dir, 'src/auth/session.ts', 'export {};\n');
  await put(dir, 'docs/folder-structure.md', '# Folders\n\n- `src/api/` — the HTTP client\n- `src/auth/` — sessions\n');
  await git('add', '-A');
  await git('commit', '-qm', 'rich');
}

test('the block keeps what every session needs, and routes the rest to guides it names', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedRich(dir, git);
    assert.equal((await naso(['decide', dir, '--title', 'Use REST', '--decision', 'Never call the database from a screen.', '--source', 'kickoff'], dir)).code, 0);
    assert.equal((await naso(['decisions', 'accept', dir, '0001'], dir)).code, 0);
    assert.equal((await bare(['--yes'])).code, 0);

    const agents = await read(dir, AGENTS);
    const block = agents.slice(agents.indexOf(NASO_START), agents.indexOf(NASO_END));
    assert.ok(textLines(block) <= ROOT_LINE_BUDGET, `the block is ${textLines(block)} lines of text:\n${block}`);

    const touch = sectionOf(block, TOUCH_HEADING);
    for (const name of ['conventions', 'workflow', 'decisions']) {
      assert.match(touch, new RegExp(`\`\\.naso/guides/${name}\\.md\``), `${name} is routed`);
      assert.ok(await exists(dir, GUIDE(name)), `${name} is on disk`);
    }
    // Sections that only one kind of task needs are in a guide, never also in the block.
    for (const heading of ['Decisions', 'Scope', 'Commit Standard']) {
      assert.doesNotMatch(block, new RegExp(`^## ${heading}$`, 'm'), `${heading} left the block`);
    }
    assert.match(await read(dir, GUIDE('workflow')), /^## Scope$/m);
    assert.match(await read(dir, GUIDE('workflow')), /^## Commit Standard$/m);
    assert.match(await read(dir, GUIDE('decisions')), /^## Decisions$/m);
    // What every session needs stays: the handoff, the rules, the commands, when it is done.
    for (const heading of ['Read First', 'Rules That Are Easy To Get Wrong', 'Project Structure', 'Secrets', 'When Done']) {
      assert.match(block, new RegExp(`^## ${heading}$`, 'm'), `${heading} stays in the block`);
    }
    assert.equal((await script('briefing')).code, 0);
  });
});

test('no section is in two places', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedRich(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const seen = new Map();
    for (const rel of [AGENTS, GUIDE('conventions'), GUIDE('workflow'), GUIDE('decisions')]) {
      if (!(await exists(dir, rel))) continue;
      for (const { heading } of splitSections(await read(dir, rel)).sections) {
        assert.ok(!seen.has(heading), `${heading} is in ${seen.get(heading)} and ${rel}`);
        seen.set(heading, rel);
      }
    }
  });
});

test('a source map under one area goes to that area guide, and the table routes changes there', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedRich(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const agents = await read(dir, AGENTS);
    assert.match(sectionOf(agents, TOUCH_HEADING), /\| change files under `src\/` \| `\.naso\/guides\/src\.md` \|/);
    assert.match(await read(dir, GUIDE('src')), /^## Source Map$/m);
    const guide = await script('guide', ['src']);
    assert.match(guide.stdout, /Before changing it, read `\.naso\/guides\/src\.md`/);
  });
});

test('a linked guide that is missing fails the check, even where .naso/ is kept out of git', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    assert.equal((await git('check-ignore', '-q', GUIDE('workflow'))).code, 0, 'the default setup keeps .naso/ local');
    await (await import('node:fs/promises')).rm(path.join(dir, GUIDE('workflow')));
    const res = await script('briefing');
    assert.equal(res.code, 1);
    assert.match(res.stdout, /MISSING[\s\S]*\.naso\/guides\/workflow\.md/);
  });
});

test('a path written in a guide is checked like a path in the block', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const file = path.join(dir, GUIDE('workflow'));
    await writeFile(file, `${await read(dir, GUIDE('workflow'))}\n- Releases are cut from \`scripts/release.mjs\`.\n`);
    const res = await script('briefing');
    assert.equal(res.code, 1);
    assert.match(res.stdout, /MISSING[\s\S]*scripts\/release\.mjs/);
  });
});

test('a guide people edited is kept by --force, and replaced only with --discard-edits after a backup', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    assert.ok((await createBriefing(dir)).ok);
    const file = path.join(dir, GUIDE('workflow'));
    await writeFile(file, (await read(dir, GUIDE('workflow'))).replace('## Scope', '## Scope\n\nReleases need two approvals (`README.md` line 1).'));

    const kept = await createBriefing(dir, { force: true });
    assert.ok(kept.ok, 'the block itself was untouched, so --force replaces it');
    assert.equal(kept.guides.find((guide) => guide.rel === GUIDE('workflow')).change, 'kept');
    assert.match(await read(dir, GUIDE('workflow')), /two approvals/);

    const replaced = await createBriefing(dir, { force: true, discardEdits: true });
    assert.equal(replaced.guides.find((guide) => guide.rel === GUIDE('workflow')).change, 'replace');
    assert.doesNotMatch(await read(dir, GUIDE('workflow')), /two approvals/);
    const { readdir } = await import('node:fs/promises');
    const backups = await readdir(path.join(dir, '.naso', 'backups'));
    assert.ok(backups.some((name) => name.startsWith('workflow-')), backups.join(', '));
  });
});

test('setup lists every guide it will write, before anything is written', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await driveFlow(dir, { args: ['--dry-run'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    for (const name of ['conventions', 'workflow', 'decisions']) assert.match(res.stdout, new RegExp(`\\.naso/guides/${name}\\.md`));
    assert.ok(!(await exists(dir, GUIDE('workflow'))), 'a dry run writes nothing');
  });
});

test('stats counts the block at session start and lists the guides apart, as read on demand', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const res = await script('stats', ['--json']);
    const load = JSON.parse(res.stdout);
    assert.ok(!load.files.some((file) => file.path.includes('.naso/guides/')), 'no guide loads at session start');
    const listed = load.onDemand.map((guide) => guide.path);
    for (const name of ['workflow', 'decisions']) assert.ok(listed.includes(GUIDE(name)), listed.join(', '));
    assert.ok(load.onDemand.every((guide) => guide.tokens > 0));
  });
});

/** A block as 1.6.0 wrote it: one file, every section in it, digest intact. */
async function singleFileBlock(dir, git, bare) {
  await seedRich(dir, git);
  assert.equal((await bare(['--yes'])).code, 0);
  const agents = await read(dir, AGENTS);
  const parts = [];
  for (const rel of [GUIDE('conventions'), GUIDE('workflow'), GUIDE('decisions'), GUIDE('src')]) {
    if (!(await exists(dir, rel))) continue;
    parts.push(splitSections(await read(dir, rel)).sections.map((entry) => entry.text).join('\n\n'));
    await (await import('node:fs/promises')).rm(path.join(dir, rel));
  }
  const touch = sectionOf(agents, TOUCH_HEADING);
  const old = agents
    .replace(`${touch}`, '')
    .replace(NASO_END, `${parts.join('\n\n')}\n\n${NASO_END}`)
    .replace(/2\. This block, then the guide When You Touch names for the work you are about to do\./, '2. This briefing.')
    .replace(/: `\.naso\/guides\/decisions\.md` says where they are kept\./, ' (Decisions, below).');
  await put(dir, AGENTS, old);
  return old;
}

test('a single-file block passes the check, with a notice that names the command that splits it', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await singleFileBlock(dir, git, bare);
    const res = await script('briefing');
    assert.equal(res.code, 0, res.stdout);
    assert.match(res.stdout, /Single-file block from before 2\.0\.0: [^\n]*Decisions[^\n]*`npx naso-dev briefing migrate`/);
    const review = await script('review');
    assert.match(review.stdout, /migrate --write` before anything else/);
  });
});

test('migrate shows the split and writes nothing without --write', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    const old = await singleFileBlock(dir, git, bare);
    const res = await script('briefing', ['migrate']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Would move these sections out of the block, word for word/);
    assert.match(res.stdout, /\.naso\/guides\/workflow\.md: Scope, Commit Standard/);
    assert.equal(await read(dir, AGENTS), old);
    assert.ok(!(await exists(dir, GUIDE('workflow'))));
  });
});

test('migrate --write moves every line word for word, and the check then has no layout notice', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    const old = await singleFileBlock(dir, git, bare);
    // A reviewed line in a section that moves, and a section NASO does not know.
    const reviewed = old
      .replace('## Commit Standard\n', '## Commit Standard\n\n- Squash on merge (`CONTRIBUTING.md` line 3).\n')
      .replace(NASO_END, '## Deploy Windows\n\nFridays only.\n\n' + NASO_END);
    await put(dir, AGENTS, reviewed);

    const res = await script('briefing', ['migrate', '--write']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Left in the block, because NASO does not know where they belong: Deploy Windows/);

    const agents = await read(dir, AGENTS);
    const everything = [agents, ...(await Promise.all(['conventions', 'workflow', 'decisions', 'src'].map((name) => read(dir, GUIDE(name)).catch(() => ''))))].join('\n');
    const before = reviewed.slice(reviewed.indexOf(NASO_START), reviewed.indexOf(NASO_END));
    const changedByNaso = new Set(['2. This briefing.', '3. The decisions that apply to the paths you will change (Decisions, below).']);
    for (const line of before.split('\n')) {
      if (line.trim() === '' || changedByNaso.has(line)) continue;
      assert.ok(everything.includes(line), `lost in the move: ${line}`);
    }
    assert.match(await read(dir, GUIDE('workflow')), /Squash on merge/);
    assert.match(agents, /^## Deploy Windows$/m, 'an unknown section stays where people put it');
    assert.match(agents, /2\. This block, then the guide When You Touch names/);

    const check = await script('briefing');
    assert.equal(check.code, 0, check.stdout);
    assert.doesNotMatch(check.stdout, /Single-file block/);
  });
});

test('migrate never replaces a guide that is already on disk', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    const old = await singleFileBlock(dir, git, bare);
    await put(dir, GUIDE('workflow'), '# Ours\n');
    const res = await script('briefing', ['migrate', '--write']);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /already on disk[^\n]*\.naso\/guides\/workflow\.md[\s\S]*Nothing was written/);
    assert.equal(await read(dir, GUIDE('workflow')), '# Ours\n');
    assert.equal(await read(dir, AGENTS), old);
  });
});

test('a migrated block that was never edited still reads as unedited, so --force can regenerate it', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    assert.ok((await createBriefing(dir)).ok);
    const { blockEdited, blockDigest } = await import('../tooling/scan.mjs');
    const { renderLayers } = await import('../tooling/render.mjs');
    const { scanRepo } = await import('../tooling/scan.mjs');
    // Rebuild the 1.6.0 shape with a correct digest: the guides' sections back in the block.
    const { block, guides } = await renderLayers(await scanRepo(dir), { version: '1.6.0', now: '2026-11-21' });
    const moved = guides.map((guide) => splitSections(guide.text).sections.map((entry) => entry.text).join('\n\n')).join('\n\n');
    let old = block.replace(sectionOf(block, TOUCH_HEADING), '').replace(NASO_END, `${moved}\n\n${NASO_END}`);
    old = old.replace(/^(<!--\s*digest:\s*)[0-9a-f]+(\s*-->)$/m, `$1${blockDigest(old)}$2`);
    await put(dir, AGENTS, old);
    assert.equal(blockEdited(old), false);
    const res = await naso(['briefing', dir, 'migrate', '--write'], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(blockEdited(await read(dir, AGENTS)), false, 'NASO moving its own sections is not an edit');
  });
});

test('a block grown past its budget gets a notice that says where the detail goes', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const agents = await read(dir, AGENTS);
    const filler = Array.from({ length: ROOT_LINE_BUDGET }, (_, i) => `- Reviewed note ${i + 1}.`).join('\n');
    await put(dir, AGENTS, agents.replace('## Secrets', `## Notes\n\n${filler}\n\n## Secrets`));
    const res = await script('briefing');
    assert.equal(res.code, 0);
    assert.match(res.stdout, new RegExp(`past the ${ROOT_LINE_BUDGET} every session can afford[^\\n]*guide that When You Touch names`));
  });
});

test('with AGENTS.md already tracked and .naso/ local, the plan says the guides stay on this machine', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, AGENTS, '# Our agents\n');
    await git('add', AGENTS);
    await git('commit', '-qm', 'our briefing');
    const res = await driveFlow(dir, { args: ['--dry-run'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout.replace(/\s+/g, ' '), /The guides it links in \.naso\/guides\/ stay on this machine, so a teammate's `briefing` reports them MISSING: re-run with --track/);
  });
});

test('only a plain file name in the guides folder counts as a guide, so the block cannot send the checker elsewhere', async () => {
  const { linkedGuides } = await import('../tooling/guides.mjs');
  assert.deepEqual(
    linkedGuides('`.naso/guides/workflow.md` `.naso/guides/../../secret.md` `.naso/guides/sub/x.md` `.naso/guides/src-area.md`'),
    ['.naso/guides/workflow.md', '.naso/guides/src-area.md'],
  );
});
