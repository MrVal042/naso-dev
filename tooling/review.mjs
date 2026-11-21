#!/usr/bin/env node
// NASO review — the prompt that hands the briefing to the repository's own coding agent.
//
// NASO derives the block from file lists, manifests and history. The rules people wrote
// down (CONTRIBUTING, CODEOWNERS, review templates, CI, docs) are where it is most often
// incomplete, and an agent with the whole repository open is the cheapest way to close that
// gap. So setup ends with this prompt, and `naso-dev review` prints it again at any time.
//
// The prompt is built from the repository as it is now, not from a fixed text: which of its
// own rule files exist, whether the block was reviewed before, what the checker reports,
// which decisions wait for a person, and whether the versions agree. A second review then
// starts where the first one ended instead of redoing it.
//
// Four limits keep the result trustworthy: every change cites a file and line it read,
// edits stay between the markers, the checker runs before anything is reported, and the
// index is left as it was found. An agent "improving" a briefing without evidence produces
// exactly the confident fiction NASO exists to replace.
//
// Zero external dependencies — Node.js core modules only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, pathExists, nasoCommand, isMainModule, toolVersion, run, documentedBranchPattern, SUPPORT_EMAIL } from './lib.mjs';
import { AGENTS_FILE, NASO_START, NASO_END, blockEdited, listRepoFiles, scanRepo } from './scan.mjs';
import { renderReadFirst } from './render.mjs';
import { renderTraps, TRAPS_HEADING } from './traps.mjs';
import { locateHandoff } from './handoff.mjs';
import { checkBriefing, localOnlyGuides } from './check.mjs';
import { NASO_DIR } from './vendor.mjs';
import { readDecidedNotes } from './toolchain.mjs';
import { readDecisions, auditDecisions, indexFileOf, citedLines, sameDecisionText } from './decisions.mjs';
import { GUIDES_DIR, ROOT_LINE_BUDGET, TOUCH_HEADING } from './guides.mjs';

/**
 * The files where a repository writes its own rules, by kind, in reading order.
 *
 * Matched against tracked paths, so the prompt names the files this repository has rather
 * than a generic list the agent has to search for. `.env` files are never listed: the prompt
 * tells the agent to name credentials by path only, and listing them would invite opening one.
 */
const RULE_SOURCES = [
  {
    kind: 'Written rules and agent instructions',
    match: (f) =>
      /^(?:README|CONTRIBUTING|SECURITY|GOVERNANCE)(?:\.[\w]+)?$/i.test(f) ||
      /^(?:\.github|docs)\/CONTRIBUTING(?:\.[\w]+)?$/i.test(f) ||
      /^(?:CLAUDE|GEMINI)\.md$/.test(f) ||
      /^\.cursorrules$|^\.cursor\/rules\/|^\.windsurfrules$|^\.github\/copilot-instructions\.md$|^\.github\/instructions\//.test(f),
  },
  { kind: 'Owners', match: (f) => /(?:^|\/)CODEOWNERS$/.test(f) && /^(?:CODEOWNERS|\.github\/|\.gitlab\/|docs\/)/.test(f) },
  {
    kind: 'Pull or merge request templates',
    match: (f) => /pull_request_template|PULL_REQUEST_TEMPLATE|^\.gitlab\/merge_request_templates\//i.test(f),
  },
  {
    kind: 'CI',
    match: (f) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^\.gitlab\/ci\/|^\.circleci\/config\.ya?ml$|^Jenkinsfile$|^azure-pipelines\.ya?ml$|^bitbucket-pipelines\.ya?ml$|^\.travis\.yml$|^\.buildkite\//.test(f),
  },
  {
    kind: 'Commit hooks and commit rules',
    match: (f) =>
      /^\.husky\/[^_][^/]*$|^lefthook\.ya?ml$|^\.pre-commit-config\.ya?ml$|^(?:commitlint\.config\.\w+|\.commitlintrc(?:\.\w+)?)$|^\.lintstagedrc(?:\.\w+)?$|^lint-staged\.config\.\w+$/.test(f),
  },
  {
    kind: 'Lint, format and type checking',
    match: (f) =>
      /^(?:eslint\.config\.\w+|\.eslintrc(?:\.\w+)?|\.prettierrc(?:\.\w+)?|prettier\.config\.\w+|\.prettierignore|biome\.jsonc?|\.editorconfig|tsconfig(?:\.[\w-]+)?\.json|ruff\.toml|\.golangci\.ya?ml|rustfmt\.toml|clippy\.toml|\.rubocop\.yml|\.stylelintrc(?:\.\w+)?|phpcs\.xml(?:\.dist)?|\.swiftlint\.yml|analysis_options\.yaml)$/.test(f),
  },
  {
    kind: 'Build, packaging and ignore files',
    match: (f) =>
      /^(?:package\.json|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|pubspec\.yaml|Makefile|Dockerfile[\w.-]*|\.dockerignore|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.gitignore|\.gitattributes|nest-cli\.json|app\.config\.\w+|app\.json|turbo\.json|nx\.json|pnpm-workspace\.yaml)$/.test(f),
  },
  {
    kind: 'Build, test and dependency tool config',
    match: (f) =>
      /^(?:renovate\.json5?|\.renovaterc(?:\.json)?|\.github\/renovate\.json5?|\.github\/dependabot\.ya?ml|\.npmrc|\.nvmrc|\.node-version|\.tool-versions|(?:metro|babel|jest|vitest|vite|next|webpack|rollup|tsup|playwright|cypress)\.config\.\w+|eas\.json)$/.test(f),
  },
  // Not the decisions folder: its records are proposals until a person accepts them, and
  // naming them as the repository's rules made the agent's own proposals the authority it
  // checked itself against. Accepted records are listed under their own heading instead.
  { kind: 'Docs on architecture, structure and decisions', match: (f) => /^(?:docs?|adr|architecture)\/.+\.(?:md|mdx|adoc|rst)$/i.test(f) && !DECISION_FOLDER.test(f) },
];

/** A path inside a decision-record folder, wherever it is. */
const DECISION_FOLDER = /(?:^|\/)decisions?\/|(?:^|\/)adrs?\//i;

/** At most this many paths per kind; the rest is a count, so the prompt stays pasteable. */
const PER_KIND = 25;

/** The repository's own rule files, grouped by kind. Empty kinds are left out. */
export function ruleSources(files) {
  const groups = [];
  for (const { kind, match } of RULE_SOURCES) {
    const found = files.filter((file) => !/(?:^|\/)\.env(?:\.|$)/.test(file) && match(file)).sort();
    if (found.length > 0) groups.push({ kind, files: found });
  }
  return groups;
}

/**
 * A flat ESLint config that does not ignore .naso/, or null. ESLint 9 reads neither
 * .gitignore nor .git/info/exclude, so it lints the vendored copy and reports each file's
 * `eslint-disable` header as unused. NASO does not edit a JavaScript config; it says so.
 */
async function eslintWithoutNaso(cwd, files) {
  const config = files.find((file) => /^eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)$/.test(file));
  if (!config) return null;
  const text = await readFile(path.join(cwd, config), 'utf8').catch(() => '');
  return /\.naso\b/.test(text) ? null : config;
}

/**
 * Rows the repository's own docs mark decided, in a table with a Status column: candidates
 * for `decide` that a reviewer otherwise finds by reading every doc.
 *
 * A row is left out when a record already cites it: the record's source names the file and
 * the row's line, a line range or a section holding it ("docs/architecture.md section 2"),
 * or the record says the same thing. Matching the line number alone listed 9 of 10 rows a
 * second time, and `decide` checks only titles, so they were proposed again.
 *
 * A Status that names an owner, "Decided (customer-api)", is another repository's decision
 * unless the owner is this one. Those rows come back with `owner` set, to be listed apart.
 */
export async function decidedRows(cwd, files, records, { names = [] } = {}) {
  const docs = files.filter((file) => /\.mdx?$/i.test(file) && !DECISION_FOLDER.test(file));
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.replace(/\*\*|`/g, '').trim());
  const ours = new Set(names.filter(Boolean).map((name) => name.toLowerCase()));
  const rows = [];
  for (const file of docs) {
    const text = (await readFile(path.join(cwd, file), 'utf8').catch(() => '')) ?? '';
    const lines = text.split('\n');
    const cited = records.filter((record) => record.source?.includes(file)).map((record) => ({ record, lines: citedLines(record.source, file, text) }));
    let status = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim().startsWith('|')) {
        status = -1;
        continue;
      }
      const row = cells(line);
      if (status === -1) {
        status = row.findIndex((cell) => /^status$/i.test(cell));
        continue;
      }
      if (/^[\s:|-]+$/.test(line)) continue;
      const state = (row[status] ?? '').replace(/^[^A-Za-z]+/, '');
      if (!/^decided\b/i.test(state)) continue;
      const rowText = row.find((cell, index) => index !== status && cell) ?? '';
      if (cited.some((entry) => entry.lines.has(i + 1) || sameDecisionText(entry.record, rowText))) continue;
      const owner = state.match(/^decided\s*\(([^)]+)\)/i)?.[1]?.trim() ?? null;
      // A date or a note in the brackets is not an owner: "Decided (2026-10-01)".
      const elsewhere = owner && /^[A-Za-z][\w.@/-]*$/.test(owner) && !ours.has(owner.toLowerCase().replace(/^@[^/]+\//, '')) ? owner : null;
      rows.push({ file, line: i + 1, text: rowText, owner: elsewhere });
    }
  }
  // Decisions written down outside a table: a dated comment in app.config.ts, a line in
  // CONTRIBUTING or CODEOWNERS. In the field these outnumbered the table rows six to one.
  const texts = new Map();
  for (const note of await readDecidedNotes(cwd, files)) {
    if (rows.some((row) => row.file === note.file && row.line === note.line)) continue;
    if (!texts.has(note.file)) texts.set(note.file, (await readFile(path.join(cwd, note.file), 'utf8').catch(() => '')) ?? '');
    const text = texts.get(note.file);
    const cited = records.some((record) => record.source?.includes(note.file) && (citedLines(record.source, note.file, text).has(note.line) || sameDecisionText(record, note.text)));
    if (!cited) rows.push({ file: note.file, line: note.line, text: note.text, owner: null });
  }
  return rows;
}

/** The names this repository goes by: package name, folder, and the origin remote's repository. */
async function repositoryNames(cwd) {
  const names = [path.basename(cwd)];
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
    if (typeof pkg?.name === 'string') names.push(pkg.name, pkg.name.replace(/^@[^/]+\//, ''));
  } catch {
    // No manifest: the folder and the remote are the names.
  }
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd });
  const repo = remote.ok ? remote.stdout.trim().match(/([^/:]+?)(?:\.git)?\/?$/)?.[1] : null;
  if (repo) names.push(repo);
  return names;
}

/** Everything the prompt adapts to, read once. */
/** How to write each SECTIONS_SINCE section from this repository as it is now. */
const SECTION_RENDERERS = { 'Read First': renderReadFirst, [TRAPS_HEADING]: (facts) => renderTraps(facts.traps) };

/**
 * The sections the block predates, each with the text NASO would write for it today, so the
 * agent pastes what the generator would have produced instead of guessing at its shape.
 * `createFirst` names a file the section cites that does not exist yet.
 */
async function missingSectionText(cwd, notices) {
  if (notices.length === 0) return [];
  const facts = await scanRepo(cwd);
  const handoff = await locateHandoff(cwd);
  const handoffMissing = handoff.where !== 'git' && !(await pathExists(handoff.file));
  return notices
    .filter((notice) => SECTION_RENDERERS[notice.heading])
    .map((notice) => ({
      ...notice,
      text: SECTION_RENDERERS[notice.heading]({ ...facts, handoff }),
      createFirst: notice.heading === 'Read First' && handoffMissing ? { file: handoff.shown, command: `${nasoCommand()} handoff` } : null,
    }));
}

export async function reviewState(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  const text = (await readFile(agentsPath, 'utf8').catch(() => null)) ?? null;
  const hasBlock = text !== null && text.includes(NASO_START) && text.includes(NASO_END);
  const files = await listRepoFiles(cwd).catch(() => []);
  const decisions = await readDecisions(cwd);
  const audit = await auditDecisions(cwd).catch(() => ({ findings: [] }));
  const rows = await decidedRows(cwd, files ?? [], decisions.records, { names: await repositoryNames(cwd) });
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const check = hasBlock ? await checkBriefing(cwd) : null;
  return {
    branch: branch.ok ? branch.stdout.trim() : null,
    branchPattern: await documentedBranchPattern(cwd),
    hasAgents: text !== null,
    hasBlock,
    reviewed: hasBlock && blockEdited(text),
    tracked: (await run('git', ['ls-files', '--error-unmatch', '--', AGENTS_FILE], { cwd })).ok,
    // HEAD's copy, not the index: a block added and staged but not committed has no commit
    // to diff from, and `git log -- AGENTS.md` then names a commit from before NASO.
    committedBlock: (await run('git', ['show', `HEAD:${AGENTS_FILE}`], { cwd })).stdout.includes(NASO_START),
    generatedAt: text?.match(/^<!--\s*generated-at:\s*(\S+)\s*-->$/m)?.[1] ?? null,
    check,
    missingSections: check ? await missingSectionText(cwd, check.notices ?? []) : [],
    layout: (check?.notices ?? []).filter((notice) => notice.text),
    guides: (check?.guides ?? []).filter((guide) => guide.text !== null).length,
    sources: ruleSources(files ?? []),
    decisions,
    findings: audit.findings ?? [],
    claudeLinks: /^@AGENTS\.md\s*$/m.test((await readFile(path.join(cwd, 'CLAUDE.md'), 'utf8').catch(() => '')) ?? ''),
    vendored: await pathExists(path.join(cwd, '.naso', 'tooling', 'validate.mjs')),
    hook: /naso/i.test((await readFile(path.join(cwd, '.git', 'hooks', 'pre-commit'), 'utf8').catch(() => '')) ?? ''),
    version: await toolVersion(),
    eslintUnignored: await eslintWithoutNaso(cwd, files ?? []),
    // AGENTS.md reaches every clone and .naso/ does not: the handoff and the guides are this
    // machine's, so the block must not be the only way to what they hold.
    nasoLocal: hasBlock && (await localOnlyGuides(cwd, [`${NASO_DIR}/HANDOFF.md`])).length > 0,
    decided: rows.filter((row) => !row.owner),
    decidedElsewhere: rows.filter((row) => row.owner),
  };
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What NASO consists of in this repository, from what is on disk. */
function installedLines(state, index) {
  const lines = [
    `- ${AGENTS_FILE}, the part between ${NASO_START} and ${NASO_END}: derived from file lists, manifests and git history. Its aim: every path is real, every count was counted, and every rule is this repository's own.`,
    `- ${state.decisions.dir}/: one file per decision the team made, with who decided and where, listed in ${index}${state.decisions.indexExists ? '' : ' once the first one is recorded'}. Agents propose; only a person accepts.`,
  ];
  if (state.guides > 0) lines.push(`- ${GUIDES_DIR}/: ${count(state.guides, 'guide')} the block links in its ${TOUCH_HEADING} table, each read only when that kind of task comes up.`);
  if (state.claudeLinks) lines.push('- CLAUDE.md: its `@AGENTS.md` line makes Claude Code load the briefing.');
  if (state.vendored) lines.push('- .naso/tooling/ and .naso/config.json: the toolset the hook runs, vendored, and the choices setup made. Never edit the toolset by hand; `refresh` overwrites it.');
  if (state.hook) lines.push('- .git/hooks/pre-commit, on this machine only: on every commit it checks staged files for secrets, scope, format and lint, adds a briefing line for a new top-level area, and refreshes the decisions list.');
  return lines;
}

/** Where things stand, so the agent starts from the current state rather than from zero. */
function stateLines(state, cmd, here) {
  const lines = [];
  // Before anything else: a single-file block is migrated first, so the review edits each
  // section where it will live.
  for (const notice of state.layout ?? []) {
    lines.push(
      notice.kind === 'single-file'
        ? `- ${notice.text} Run \`${cmd} briefing${here} migrate --write\` before anything else, then review the block and the guides it writes.`
        : `- ${notice.text}`,
    );
  }
  for (const section of state.missingSections ?? []) {
    lines.push(
      `- The block has no ${section.heading} section (added in ${section.since}): ${section.why}. ` +
        (section.createFirst ? `Run \`${section.createFirst.command}${here}\` first, so \`${section.createFirst.file}\`, which it cites, exists. ` : '') +
        `Add it inside the markers, ${section.place}, as NASO would write it here today:\n\n` +
        `\`\`\`markdown\n${section.text}\n\`\`\``,
    );
  }
  if (state.reviewed && state.tracked && !state.committedBlock) {
    lines.push(
      `- The block was edited after NASO wrote it, but the block is not committed yet: HEAD's ${AGENTS_FILE} has no ${NASO_START} marker, ` +
        'so there is no commit to diff from, and a diff from the last commit that touched it would cover the whole history. ' +
        'Review the whole block, line by line.',
    );
  } else if (state.reviewed) {
    // An untracked AGENTS.md (the default, local mode) has no commit to diff from, so the
    // generated-at stamp is the nearest thing to "when the block was last settled".
    const since = state.tracked
      ? 'run `git log -1 --format=%h -- AGENTS.md`, then `git diff <that commit>..HEAD --stat`'
      : `AGENTS.md is not tracked, so run \`git log --since=${state.generatedAt ?? '<the generated-at date in the block>'} --stat\``;
    lines.push(
      `- The block was edited after NASO wrote it, so it has been reviewed before. Do not start over: ${since}, and re-check every claim those changes touch, plus everything listed here.`,
    );
  } else {
    lines.push('- This is the first review: the block is exactly as NASO generated it.');
  }
  const check = state.check;
  if (check?.ok) {
    lines.push(`- \`${cmd} briefing${here}\` passes today: ${count(check.tokens.length, 'path claim')} verified. Passing proves the paths exist, not that the sentences about them are true.`);
  } else if (check) {
    lines.push(`- \`${cmd} briefing${here}\` reports ${count(check.problems.length, 'problem')} today:`);
    for (const problem of check.problems) lines.push(`  - ${problem.kind}: ${problem.item}`);
  }
  for (const note of check?.notes ?? []) lines.push(`- Versions: ${note}`);
  if (state.eslintUnignored) {
    lines.push(
      `- ${state.eslintUnignored} does not ignore .naso/, so lint reports the vendored files' eslint-disable headers as unused. Report the fix (add '.naso/' to its ignores); do not edit .naso/tooling/.`,
    );
  }

  if (state.nasoLocal) {
    lines.push(
      `- ${AGENTS_FILE} is not ignored here and ${NASO_DIR}/ is, so the block reaches every clone and ${NASO_DIR}/HANDOFF.md and ${GUIDES_DIR}/ reach none. ` +
        'Keep every rule a teammate needs in the block or in a committed file it links. If the repository already keeps a handoff or a decisions list elsewhere, point to that one, not a second, empty one. Report the choice (commit the guides with `git add -f`, or keep them local) for a person to settle.',
    );
  }

  if (state.branch) {
    const rule = state.branchPattern;
    lines.push(
      `- You are on branch ${state.branch}.` +
        (rule
          ? ` \`${rule.source}\` says branches follow \`${rule.text}\`${rule.exceptions?.length ? ` (or ${rule.exceptions.map((text) => `\`${text}\``).join(', ')})` : ''}${rule.regex.test(state.branch) ? ', and this one does' : ', and this one does not'}.`
          : ' No branch rule is written down that NASO could read; look for one before planning the commit.'),
    );
  }

  const { records } = state.decisions;
  const by = (status) => records.filter((record) => record.status === status).length;
  if (records.length === 0) {
    lines.push('- No decision is recorded yet.');
  } else {
    lines.push(
      `- Decisions: ${by('accepted')} accepted, ${by('proposed')} proposed and waiting for a person, ` +
        `${records.length - by('accepted') - by('proposed')} rejected or superseded.`,
    );
  }
  if (state.decided.length > 0) {
    lines.push(`- Rows this repository's docs mark Decided that no record cites yet (${state.decided.length}), from Status columns and from lines that say "decided" in config, CONTRIBUTING, CODEOWNERS and docs. Propose each that is a decision, citing the file and line, unless ${state.decisions.dir}/, its index or the decisions guide says a rule already written in the docs is not proposed again; then propose none, and say which rule stopped you:`);
    for (const row of state.decided.slice(0, 40)) lines.push(`  - ${row.file} line ${row.line}: ${row.text}`);
    if (state.decided.length > 40) lines.push(`  - and ${state.decided.length - 40} more`);
  }
  const elsewhere = state.decidedElsewhere ?? [];
  if (elsewhere.length > 0) {
    lines.push(`- Rows decided by another repository (${elsewhere.length}): their Status names another owner. Do not propose them here; name them in the block only as work that belongs there:`);
    for (const row of elsewhere.slice(0, 20)) lines.push(`  - ${row.file} line ${row.line}: ${row.text} (${row.owner})`);
    if (elsewhere.length > 20) lines.push(`  - and ${elsewhere.length - 20} more`);
  }
  if (state.findings.length > 0) {
    lines.push(`- \`${cmd} decisions audit\` reports ${count(state.findings.length, 'finding')}:`);
    for (const finding of state.findings) lines.push(`  - ${finding.id} (${finding.level}): ${finding.text}`);
  }
  return lines;
}

/**
 * The prompt for the repository's own coding agent.
 *
 * `here` is the target as typed after a command (` path/to/repo`), or '' when the agent
 * will run from inside the repository.
 */
export function renderReviewPrompt(cwd, state, { here = '' } = {}) {
  const cmd = nasoCommand();
  const index = indexFileOf(state.decisions.dir);
  const where = here ? ` (${cwd})` : '';
  const accepted = state.decisions.records.filter((record) => record.status === 'accepted').map((record) => record.file);
  const groups = [...state.sources, ...(accepted.length > 0 ? [{ kind: 'Decisions a person accepted', files: accepted }] : [])];
  const sources = groups.length
    ? groups.flatMap(({ kind, files }) => [
        `- ${kind}: ${files.slice(0, PER_KIND).join(', ')}${files.length > PER_KIND ? `, and ${files.length - PER_KIND} more` : ''}`,
      ])
    : ['- None of the usual rule files are tracked here. Read the README and the code, and say so in your report.'];

  return `Copy everything between the lines below and paste it into your coding agent.
Run \`${cmd} review${here}\` again whenever the repository's rules change: it prints
this prompt with the state at that time.

--------------------------------------------------------------
Review NASO in this repository${where} and make it fit this repository. NASO is the
briefing every session starts from, and the record of what the team decided. Here it is:
${installedLines(state, index).join('\n')}

Where it stands now:
${stateLines(state, cmd, here).join('\n')}

This repository's own rules are in these files:
${sources.join('\n')}

1. Run \`git status --short\`, \`git rev-parse HEAD\` and \`git write-tree\`; keep all
   three outputs. Never run git add, commit, stash, reset or checkout.
2. Read the files above and what they point to. Never open or print .env files,
   keys or other credentials; name them by path only.
3. Audit every line of the NASO block, and of the guides it links in ${GUIDES_DIR}/,
   against those files and the code. Keep, correct or remove each one:
   - Correct what the repository contradicts. Remove what is wrong and cannot be
     corrected, repeats a linked file or CLAUDE.md (every Claude Code session
     loads it too), or would not change what an agent does.
   - Add what an agent would otherwise get wrong: framework rules; generated and
     vendored files and how each is regenerated; import boundaries; protected
     paths and their owners; which commands only check, rewrite files, never
     exit or need a build first; branch, commit and merge rules with their
     exceptions; what CI runs; which document wins; work that belongs elsewhere.
   - Every session reads the whole block, so keep it under ${ROOT_LINE_BUDGET} lines of text.
     Detail that one kind of task needs goes in the guide ${TOUCH_HEADING} names for
     it. Prefer a link to the file that states a rule over copying the rule.
4. Cite every line you add or change: file and line numbers (\`CONTRIBUTING.md\`
   lines 6-9). Quote whole sentences in “…”; the checker looks for the quote in
   the lines cited. If you cannot cite it, leave it out. Write a path in another
   repository as \`repo:path\`, and code that is not a path without backticks.
5. Edit only between ${NASO_START} and ${NASO_END}, and in ${GUIDES_DIR}/.
   Everything else is the team's own text.
6. Decisions. Read ${index} first, if it exists.
   - Propose once each decision the team made but never recorded:
     \`${cmd} decide${here} --title "…" --decision "…" --source "<file> line <n>" --why "…"\`
     with \`--applies <paths>\` and one \`--considered "<option> — <why not>"\` per
     alternative turned down. Quote every value. \`decide\` refuses a title it has.
   - Never write how many decisions there are, or their ids, into the block or a
     guide; point to ${index}. Never accept, reject or supersede one.
7. Audit the rest of what NASO installed here. Run every check-only tool this repository and its CI use
   (lint, format check, typecheck, tests, and the secret scanner if one is installed, such as \`gitleaks dir . --redact\`)
   on ${NASO_DIR}/ and ${state.decisions.dir}/, and on ${AGENTS_FILE} and CLAUDE.md; never the commands
   that rewrite files. Check the hook does not fight a hook the team runs. For
   each complaint, report the config change that fixes it; never edit ${NASO_DIR}/tooling/.
8. Run \`${cmd} briefing${here}\` and fix everything it reports until it passes.
9. Run \`git rev-parse HEAD\` and \`git write-tree\` again; they should match step 1.
   If either changed and you did not change it, stop: another session or person
   is writing here. Show \`git diff --stat <tree from step 1> <tree now>\` and
   report nothing else until the person says to continue.
10. Run \`git status --short\` again and name anything that differs beyond the
    files you meant to change. Do not undo it yourself. Do not commit.

Report, in this order:
1. The diff of ${AGENTS_FILE} and ${GUIDES_DIR}/.
2. One row per change: what was wrong, missing or removed, and the file and lines
   that prove it.
3. What you confirmed correct, in one paragraph.
4. Decisions you proposed, with their ids. Then what only a person can settle:
   proposals to accept (\`${cmd} decisions accept <id>\`) or reject, audit
   findings, and any two files in this repository that disagree.
5. For NASO upstream: bugs you hit, and each fact NASO should derive on its own,
   with the file it would read it from.
6. Under the heading "What NASO gives this repository", only what you verified in
   this run: the claims the check verifies, the rules an agent now gets right the
   first time, how a new session finds the decisions, what the hook checks.
7. Last, a "Commit plan": the branch this repository's rules require for
   this change (and whether the current branch is it), the exact files to
   stage as one \`git add -- …\` line, staged files that are not NASO's and
   must stay out of this commit, and the commit message in the repository's
   format. End with one line, "Ready to commit: yes" or "Ready to commit: no",
   followed by the blockers.
--------------------------------------------------------------`;
}

/** The prompt for `cwd`, built from its current state. */
export async function reviewPrompt(cwd, { here = '' } = {}) {
  return renderReviewPrompt(cwd, await reviewState(cwd), { here });
}

function usage() {
  console.log(`NASO review

Usage:
  ${nasoCommand()} review [dir]

Prints the prompt to paste into your coding agent. It is built from the repository as it
is now: its own rule files, the briefing check, the decisions waiting for a person, and
whether the block was reviewed before. The agent corrects the NASO block with a cited file
for every change, proposes the decisions the team already made, and reports a diff without
committing. Run it after setup, and again whenever the repository's rules change.

Support: ${SUPPORT_EMAIL}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  if (flags.has('help')) {
    usage();
    return;
  }
  const cwd = path.resolve(positional[0] ?? process.cwd());
  if (!(await pathExists(cwd))) {
    console.error(`naso-dev review: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }
  const agents = await readFile(path.join(cwd, AGENTS_FILE), 'utf8').catch(() => null);
  if (agents === null || !agents.includes(NASO_START)) {
    console.error(`naso-dev review: no NASO block in ${path.join(cwd, AGENTS_FILE)}. Set NASO up first: ${nasoCommand()}${positional[0] ? ` ${positional[0]}` : ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(await reviewPrompt(cwd, { here: positional[0] ? ` ${positional[0]}` : '' }));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev review: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
