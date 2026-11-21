// "Rules that are easy to get wrong": at most ten lines, each with its reason and its source.
//
// In the field this was the part of a briefing agents used most. A rule with a reason is
// followed; a rule without one is argued with. Every line here comes from a file the
// repository already has, and the checker can test each citation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withRepo, put, read, naso, seedProject, driveFlow, readBriefing } from './helpers.mjs';
import { FIXTURES, withFixture } from './fixtures/matrix.mjs';

const HEADING = '## Rules That Are Easy To Get Wrong';

function trapsOf(agents) {
  const start = agents.indexOf(HEADING);
  if (start === -1) return null;
  const rest = agents.slice(start + HEADING.length);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end)).split('\n').filter((line) => line.startsWith('- '));
}

async function setUp(dir) {
  const res = await driveFlow(dir, { args: ['--yes', '--no-hook'] });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const check = await naso(['briefing', dir, 'check'], dir);
  assert.equal(check.code, 0, `the briefing must pass its own check:\n${check.stdout}${check.stderr}`);
  return readBriefing(dir);
}

const decision = (n, title, status, why) =>
  `# ${n}. ${title}\n\n- Status: ${status}\n- Date: 2026-11-01\n- Source: team meeting 2026-11-01\n\n## Decision\n\n${title}.\n\n## Why\n\n${why}\n`;

test('an accepted decision is a rule, with its reason and its record; a proposed one is not', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/decisions/0001-use-rest.md', decision('0001', 'Serve the public API only over REST', 'accepted', 'Partners already consume REST.'));
    await put(dir, 'docs/decisions/0002-try-graphql.md', decision('0002', 'Try GraphQL', 'proposed', 'Maybe faster.'));
    await git('add', '-A');
    await git('commit', '-qm', 'decisions');

    const traps = trapsOf(await setUp(dir));
    assert.ok(traps, 'the section is written');
    const line = traps.find((entry) => /Serve the public API only over REST/.test(entry));
    assert.ok(line, traps.join('\n'));
    assert.match(line, /Partners already consume REST/);
    assert.match(line, /`docs\/decisions\/0001-use-rest\.md`/);
    assert.ok(!traps.some((entry) => /GraphQL/.test(entry)), 'a proposal is not binding');
  });
});

test('decisions that say which paths they apply to come first, and each line keeps one sentence of each part', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const applies = (n, title, paths) =>
      `# ${n}. ${title}\n\n- Status: accepted\n- Date: 2026-11-01\n- Source: review\n- Applies to: ${paths}\n\n## Decision\n\n${title}. Second sentence of detail.\n\n## Why\n\nFirst reason. Second reason.\n`;
    await put(dir, 'docs/decisions/0001-migrations-only.md', applies('0001', 'Change the schema only through migrations', 'db/migrations/'));
    for (let i = 2; i <= 6; i++) {
      const n = String(i).padStart(4, '0');
      await put(dir, `docs/decisions/${n}-price-${i}.md`, decision(n, `Price plan ${i} costs ${i} dollars`, 'accepted', 'Market.'));
    }
    await git('add', '-A');
    await git('commit', '-qm', 'decisions');
    const traps = trapsOf(await setUp(dir));
    assert.match(traps[0], /^- Change the schema only through migrations\. Why: First reason\. \(`docs\/decisions\/0001-migrations-only\.md`\)$/);
    assert.doesNotMatch(traps.join('\n'), /Second sentence|Second reason/);
  });
});

test('a long decision is cut at a word with an ellipsis, and still cites the record that holds the rest', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const long = `Always use the shared client for ${'every single data call in the whole application '.repeat(8)}today`;
    await put(dir, 'docs/decisions/0001-shared-client.md', decision('0001', long, 'accepted', `Because ${'reasons pile up across many teams '.repeat(8)}here`));
    await git('add', '-A');
    await git('commit', '-qm', 'decision');
    const [line] = trapsOf(await setUp(dir));
    assert.ok(line.length < 420, `${line.length} characters`);
    assert.match(line, /^- Always use the shared client for every[^.]*… Why: Because reasons[^.]*… \(`docs\/decisions\/0001-shared-client\.md`\)$/);
  });
});

test('a decision that states no constraint is left out, however new or path-scoped', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/decisions/0001-generated.md', decision('0001', 'Never edit generated files by hand', 'accepted', 'The next build overwrites them.'));
    await put(
      dir,
      'docs/decisions/0002-plans.md',
      '# 0002. Plans\n\n- Status: accepted\n- Date: 2026-11-02\n- Source: pricing review\n- Applies to: src/billing/\n\n## Decision\n\nThree plans cost 10, 20 and 30 dollars a month.\n\n## Why\n\nMarket.\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'decisions');
    const traps = trapsOf(await setUp(dir));
    assert.ok(traps.some((entry) => /Never edit generated files by hand/.test(entry)), traps.join('\n'));
    assert.ok(!traps.some((entry) => /Three plans/.test(entry)), 'a product fact is not a trap');
  });
});

test('a committed env template is a rule: placeholders only, because every clone gets it', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, '.env.example', 'API_URL=\n');
    await git('add', '-A');
    await git('commit', '-qm', 'env');
    const traps = trapsOf(await setUp(dir));
    const line = traps.find((entry) => /`\.env\.example`/.test(entry));
    assert.ok(line, traps?.join('\n'));
    assert.match(line, /placeholder/);
    assert.match(line, /every clone/);
  });
});

test('CODEOWNERS limits are one cited line, owners named, globs not claimed as paths', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'infra/main.tf', 'terraform {}\n');
    await put(dir, '.github/CODEOWNERS', '# owners\n* @everyone\n/infra/ @ops-team\n*.sql @db-team\n');
    await git('add', '-A');
    await git('commit', '-qm', 'owners');
    const traps = trapsOf(await setUp(dir));
    const line = traps.find((entry) => /CODEOWNERS/.test(entry));
    assert.ok(line, traps?.join('\n'));
    assert.match(line, /\/infra\/ \(@ops-team, line 3\)/);
    assert.match(line, /\*\.sql \(@db-team, line 4\)/);
    assert.match(line, /waits for their review/);
  });
});

test('patterns with the same owners are named once, with their lines as a range', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'HISTORY.md', '# h\n');
    await put(dir, '.github/CODEOWNERS', '# owners\n\n\n.github/ @a @b\nHISTORY.md @a @b\nsrc/ @a @b\n/docs/ @c\n');
    await git('add', '-A');
    await git('commit', '-qm', 'owners');
    const line = trapsOf(await setUp(dir)).find((entry) => /CODEOWNERS/.test(entry));
    assert.match(line, /Changes under \.github\/, HISTORY\.md, src\/ \(@a, @b, lines 4-6\), \/docs\/ \(@c, line 7\) need their owners/);
  });
});

test('commitlint with a commit-msg hook is a rule, and says the hook rejects other subjects', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'commitlint.config.js', "export default { extends: ['@commitlint/config-conventional'] };\n");
    await put(dir, '.husky/commit-msg', 'npx --no -- commitlint --edit "$1"\n');
    await git('add', '-A');
    await git('commit', '-qm', 'commitlint');
    const traps = trapsOf(await setUp(dir));
    const line = traps.find((entry) => /commitlint/.test(entry));
    assert.ok(line, traps?.join('\n'));
    assert.match(line, /`commitlint\.config\.js`/);
    assert.match(line, /`\.husky\/commit-msg`/);
    assert.match(line, /rejects/);
  });
});

test('CONTRIBUTING rules are quoted with their line, so the checker can test them', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(
      dir,
      'CONTRIBUTING.md',
      '# Contributing\n\nBranches are named `<type>/<ticket>-<slug>`.\n\nKeep one ticket per pull request.\n\nWe squash merge every pull request.\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'contributing');
    const traps = trapsOf(await setUp(dir));
    assert.ok(traps.some((entry) => /`CONTRIBUTING\.md` line 5: “Keep one ticket per pull request\.”/.test(entry)), traps.join('\n'));
    assert.ok(traps.some((entry) => /`CONTRIBUTING\.md` line 7: “We squash merge every pull request\.”/.test(entry)), traps.join('\n'));
    // A guide line rarely says why. NASO does not invent a reason for it.
    assert.ok(traps.filter((entry) => /CONTRIBUTING\.md` line \d+:/.test(entry)).every((entry) => /”$/.test(entry)), traps.join('\n'));
    const branch = traps.find((entry) => /Name branches/.test(entry));
    assert.ok(branch, traps.join('\n'));
    assert.match(branch, /`CONTRIBUTING\.md` line 3/);
  });
});

test('never more than ten rules, and never more than four of them decisions', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(4, '0');
      await put(dir, `docs/decisions/${n}-rule-${i}.md`, decision(n, `Only rule number ${i} applies`, 'accepted', `Reason ${i}.`));
    }
    await put(dir, '.env.example', 'A=\n');
    await put(dir, 'CODEOWNERS', '/src/ @core\n');
    await put(dir, 'commitlint.config.js', 'export default {};\n');
    await put(dir, 'CONTRIBUTING.md', '# C\n\nBranches are named `<type>/<slug>`.\n\nOne ticket per pull request.\n\nWe squash merge.\n\nNobody may approve their own merge request.\n');
    await git('add', '-A');
    await git('commit', '-qm', 'everything');
    const traps = trapsOf(await setUp(dir));
    assert.ok(traps.length <= 10, `${traps.length} rules`);
    assert.equal(traps.filter((entry) => /rule number/.test(entry)).length, 4);
  });
});

test('a repository with none of these sources gets no section, not an empty heading', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const agents = await setUp(dir);
    assert.equal(trapsOf(agents), null);
  });
});

for (const fixture of FIXTURES.filter((entry) => entry.git === 'repo' || entry.git === 'worktree')) {
  test(`the rules section passes the check in the ${fixture.name} fixture`, async () => {
    await withFixture(fixture, async ({ dir }) => {
      const agents = await setUp(dir);
      if (fixture.name === 'gitlab-sectioned-codeowners') {
        const line = trapsOf(agents)?.find((entry) => /CODEOWNERS/.test(entry));
        assert.ok(line, agents);
        assert.match(line, /\/src\/ \(@backend-team/);
        assert.doesNotMatch(line, /\[Backend\]/, 'a section header is not a pattern');
      }
    });
  });
}
