#!/usr/bin/env node
// NASO workspace — a briefing for a folder that holds several repositories.
//
// The folder is not a git repository, so nothing here runs git in it: the repositories are
// found by their `.git` (a folder, or a file in a linked worktree), and everything said about
// them is read from their files. Each repository keeps its own NASO block and its own
// handoff; nothing inside a repository is written. What this adds is the folder's view:
//
//   AGENTS.md      a NASO block: which repositories are here, who owns each by default and
//                  what this machine may write in it (only where a file says so), and where
//                  the shared handoff is
//   CLAUDE.md      one `@AGENTS.md` line, as setup writes in a repository
//   .naso/HANDOFF.md   the shared handoff, for state that spans repositories
//   .naso/config.json  `workspace`, so the handoff resolves here even when the folder sits
//                      inside another git repository (a home folder kept in git)
//
// Nothing is written before the person accepts the plan, or passes --yes.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, copyFile } from 'node:fs/promises';
import { parseArgs, isMainModule, nasoCommand, SUPPORT_EMAIL, pathExists, listOption, isInteractive, toPosixPath } from './lib.mjs';
import { CODEOWNERS_FILES } from './repo-rules.mjs';
import { parseCodeowners } from './codeowners.mjs';
import { CLAUDE_LINK_BLOCK, claudeLoadsBriefing, claudeLinkContent } from './install.mjs';
import { ensureHandoff } from './handoff.mjs';

const START = '<!-- naso:start -->';
const END = '<!-- naso:end -->';
const DIGEST = /<!-- naso:workspace digest=([0-9a-f]{12}) -->\n/;
const SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build']);
const MAX_DEPTH = 2;
const MAX_REPOS = 200;
// GitHub reads .github/ first, then the root, then docs/; GitLab adds .gitlab/.
const OWNERS_ORDER = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'].filter((rel) => CODEOWNERS_FILES.includes(rel));
const CATCH_ALL = new Set(['*', '**', '/*', '/**']);

const digestOf = (body) => createHash('sha256').update(body).digest('hex').slice(0, 12);
const isDir = async (p) => (await stat(p).catch(() => null))?.isDirectory() ?? false;

/**
 * The repositories under `root`, two levels down at most: a folder with a `.git` is one, and
 * is not looked inside (its submodules are its own business); a folder without one may group
 * repositories, and is. Hidden folders and dependency folders are skipped.
 */
export async function findRepositories(root) {
  const found = [];
  let truncated = false;
  const walk = async (dir, depth) => {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_REPOS) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (await pathExists(path.join(full, '.git'))) found.push(toPosixPath(path.relative(root, full)));
      else if (depth < MAX_DEPTH) await walk(full, depth + 1);
    }
  };
  await walk(root, 1);
  return { repos: found, truncated };
}

/** The owners of the last catch-all line in the repository's CODEOWNERS, or what is there instead. */
async function ownersOf(repoDir) {
  for (const rel of OWNERS_ORDER) {
    const text = await readFile(path.join(repoDir, ...rel.split('/')), 'utf8').catch(() => null);
    if (text === null) continue;
    const catchAll = parseCodeowners(text).entries.filter((entry) => CATCH_ALL.has(entry.pattern) && entry.owners.length > 0).at(-1);
    return catchAll ? { file: rel, owners: catchAll.owners } : { file: rel, owners: [] };
  }
  return null;
}

/** What this machine may write in the repository, from a file that says so, or null. */
function mayWrite(rel, config, readOnly) {
  if (readOnly.includes(rel)) return 'nothing: read only';
  const deny = config?.claude?.deny;
  if (deny?.source === 'scope' && deny.scope?.length) return `only ${deny.scope.map((part) => `\`${part}\``).join(', ')}`;
  if (deny?.source === 'codeowners' && deny.owners?.length) return `what CODEOWNERS gives ${deny.owners.join(', ')}`;
  return null;
}

/** One row per repository, read from its files. */
export async function describeRepositories(root, repos, { readOnly = [] } = {}) {
  const rows = [];
  for (const rel of repos) {
    const dir = path.join(root, ...rel.split('/'));
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf8').catch(() => null);
    const config = await readFile(path.join(dir, '.naso', 'config.json'), 'utf8').then(JSON.parse).catch(() => null);
    rows.push({
      rel,
      briefing: agents === null ? null : agents.includes(START) ? 'naso' : 'own',
      owners: await ownersOf(dir),
      write: mayWrite(rel, config, readOnly),
    });
  }
  return rows;
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|');

/** The NASO block for the folder. A column with nothing to say in any row is left out. */
export function renderWorkspace({ name, rows, handoff }) {
  const cmd = nasoCommand();
  const hasOwners = rows.some((row) => row.owners);
  const hasWrite = rows.some((row) => row.write);
  const head = ['Repository', 'Briefing', ...(hasOwners ? ['Default owners'] : []), ...(hasWrite ? ['We may write'] : [])];
  const table = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    const repo = row.briefing ? `[${row.rel}/](${row.rel}/AGENTS.md)` : `${row.rel}/`;
    const briefing = row.briefing === 'naso' ? 'AGENTS.md, kept by NASO' : row.briefing === 'own' ? 'AGENTS.md' : `none yet: \`${cmd} ${row.rel}\``;
    const owners = row.owners ? (row.owners.owners.length > 0 ? `${row.owners.owners.join(' ')} (${row.owners.file})` : `per path, in ${row.owners.file}`) : '';
    table.push(`| ${[repo, briefing, ...(hasOwners ? [owners] : []), ...(hasWrite ? [row.write ?? ''] : [])].map(cell).join(' | ')} |`);
  }
  const count = `${rows.length} ${rows.length === 1 ? 'repository' : 'repositories'}`;
  const body = [
    `# Workspace: ${name}`,
    '',
    `This folder is not a git repository. It holds ${count}, each with its own history and its own briefing. Run git inside a repository, never here.`,
    '',
    '## Read First',
    '',
    `1. The shared handoff's NOW section, in \`${handoff}\`: what spans repositories. Each repository keeps its own handoff for the rest. Replace NOW from this folder with \`${cmd} handoff set "…"\`, and update it before you stop.`,
    '2. The table below, then the AGENTS.md of the repository you are about to change. Its rules apply inside it; this file adds none.',
    '',
    '## Repositories',
    '',
    ...table,
    '',
  ].join('\n');
  return `${START}\n<!-- naso:workspace digest=${digestOf(body)} -->\n${body}${END}\n`;
}

/** The block's body as it is on disk, and whether people changed it since NASO wrote it. */
export function blockState(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start === -1 || end === -1) return { present: false };
  const inner = text.slice(start + START.length + 1, end);
  const digest = DIGEST.exec(inner);
  if (!digest) return { present: true, start, end, edited: true };
  return { present: true, start, end, edited: digestOf(inner.replace(DIGEST, '')) !== digest[1] };
}

function nextAgents(before, block) {
  if (before === null) return block;
  const state = blockState(before);
  if (state.present) return `${before.slice(0, state.start)}${block}${before.slice(state.end + END.length).replace(/^\n/, '')}`;
  const separator = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${separator}${block}`;
}

const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** Everything the run would do, decided before anything is written. */
export async function planWorkspace(root, { readOnly = [], force = false } = {}) {
  if (await pathExists(path.join(root, '.git'))) return { refused: `${root} is a git repository. Set NASO up in it with \`${nasoCommand()}\`; workspace is for the folder around repositories.` };
  const { repos, truncated } = await findRepositories(root);
  if (repos.length === 0) return { refused: `No git repository in the folders of ${root}, or in theirs, so there is nothing to brief.` };
  const unknown = readOnly.filter((rel) => !repos.includes(rel));
  const rows = await describeRepositories(root, repos, { readOnly });
  const handoff = '.naso/HANDOFF.md';
  const block = renderWorkspace({ name: path.basename(root), rows, handoff });

  const writes = [];
  const notes = [];
  const agentsFile = path.join(root, 'AGENTS.md');
  const agentsBefore = await readFile(agentsFile, 'utf8').catch(() => null);
  const state = agentsBefore === null ? { present: false } : blockState(agentsBefore);
  let agentsAfter = nextAgents(agentsBefore, block);
  let backup = null;
  if (state.present && state.edited && !force) {
    agentsAfter = agentsBefore;
    notes.push('AGENTS.md: the NASO block was changed by hand since NASO wrote it, so it is kept. --force replaces it, after saving it under .naso/backups/.');
  } else if (state.present && state.edited) {
    backup = path.join(root, '.naso', 'backups', `AGENTS.${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  }
  if (agentsAfter !== agentsBefore) {
    writes.push({ path: 'AGENTS.md', change: agentsBefore === null ? 'new' : state.present ? 'replace block' : 'append', lines: lineCount(block), note: 'the folder\'s briefing' });
  }

  const claudeFile = path.join(root, 'CLAUDE.md');
  const claudeBefore = await readFile(claudeFile, 'utf8').catch(() => null);
  const claudePlan = claudeBefore === null ? { action: 'create', before: '' } : claudeLoadsBriefing(claudeBefore) ? { action: 'linked', before: claudeBefore } : { action: 'append', before: claudeBefore };
  if (claudePlan.action !== 'linked') writes.push({ path: 'CLAUDE.md', change: claudePlan.action === 'create' ? 'new' : 'append', lines: lineCount(CLAUDE_LINK_BLOCK), note: 'makes Claude Code load the briefing' });

  const configFile = path.join(root, '.naso', 'config.json');
  const configBefore = await readFile(configFile, 'utf8').then(JSON.parse).catch(() => null);
  const config = { ...(configBefore ?? {}), workspace: { repositories: repos, readOnly } };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configChanged = !configBefore || JSON.stringify(configBefore) !== JSON.stringify(config);
  if (configChanged) writes.push({ path: '.naso/config.json', change: configBefore ? 'replace' : 'new', lines: lineCount(configText), note: 'the repositories found, and what you marked read only' });
  const handoffExists = await pathExists(path.join(root, '.naso', 'HANDOFF.md'));
  if (!handoffExists) writes.push({ path: handoff, change: 'new', lines: 0, note: 'the shared handoff' });

  if (truncated) notes.push(`Only the first ${MAX_REPOS} repositories are listed.`);
  for (const rel of unknown) notes.push(`--read-only ${rel}: no repository by that path here; it is ignored.`);

  const apply = async () => {
    if (backup) {
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(agentsFile, backup);
    }
    if (agentsAfter !== agentsBefore) await writeFile(agentsFile, agentsAfter, 'utf8');
    if (claudePlan.action !== 'linked') await writeFile(claudeFile, claudeLinkContent(claudePlan), 'utf8');
    await mkdir(path.dirname(configFile), { recursive: true });
    if (configChanged) await writeFile(configFile, configText, 'utf8');
    await ensureHandoff(root, { track: true });
  };

  return { root, repos, rows, writes, notes, apply, block };
}

function printPlan(plan) {
  console.log(`The plan for ${plan.root}  (nothing is written until you accept)\n`);
  console.log(`Found ${plan.repos.length} ${plan.repos.length === 1 ? 'repository' : 'repositories'}: ${plan.repos.map((rel) => `${rel}/`).join(', ')}`);
  console.log('Nothing inside them is changed: each keeps its own briefing and handoff.\n');
  console.log('Files this writes, in this folder only:');
  const width = Math.max(...plan.writes.map((write) => write.path.length), 10) + 2;
  for (const write of plan.writes) {
    const size = write.change === 'new' && write.lines === 0 ? 'new' : `${write.change}, ${write.lines} ${write.lines === 1 ? 'line' : 'lines'}`;
    console.log(`  ${write.path.padEnd(width)}${size}  (${write.note})`);
  }
  for (const note of plan.notes) console.log(`  ! ${note}`);
  console.log('\nThe block:\n');
  console.log(plan.block.replace(/^/gm, '  '));
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { flags, lists, positional } = parseArgs(argv);
  const cmd = nasoCommand();
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO workspace

Usage:
  ${cmd} workspace [folder] [--read-only <repo,…>] [--yes] [--dry-run] [--force]

For a folder that holds several repositories and is not one itself. Finds the repositories
in it, two levels down at most, and writes, in the folder only:
  AGENTS.md          a table of the repositories: each one's briefing, its default owners
                     from CODEOWNERS, and what this machine may write in it, where a file
                     or --read-only says so; and where the shared handoff is
  CLAUDE.md          one line, @AGENTS.md, so Claude Code loads it
  .naso/HANDOFF.md   the shared handoff: ${cmd} handoff set "…" from the folder
  .naso/config.json  the repositories found and the ones marked read only

Runs no git command in the folder and changes nothing inside a repository. Run it again
when a repository is added; a block people edited is kept unless --force.`);
    return;
  }

  const root = path.resolve(positional[0] ?? process.cwd());
  if (!(await isDir(root))) {
    console.error(`naso-dev workspace: folder does not exist: ${root}`);
    process.exitCode = 1;
    return;
  }
  const configured = await readFile(path.join(root, '.naso', 'config.json'), 'utf8').then(JSON.parse).catch(() => null);
  const readOnly = flags.has('read-only') ? [] : lists.has('read-only') ? listOption(lists, 'read-only').map((rel) => toPosixPath(rel).replace(/\/+$/, '')) : configured?.workspace?.readOnly ?? [];
  const plan = await planWorkspace(root, { readOnly, force: flags.has('force') });
  if (plan.refused) {
    console.error(`naso-dev workspace: ${plan.refused}`);
    process.exitCode = 1;
    return;
  }

  if (plan.writes.length === 0) {
    console.log(`${root}: the workspace briefing is current; nothing to write.`);
    for (const note of plan.notes) console.log(`  ! ${note}`);
    return;
  }
  printPlan(plan);
  if (flags.has('dry-run')) {
    console.log('--dry-run: nothing was written.');
    return;
  }
  const interactive = typeof deps.interactive === 'boolean' ? deps.interactive : isInteractive();
  if (!flags.has('yes')) {
    if (!interactive) {
      console.log('This terminal cannot answer a question, so nothing was written (exit code 2).');
      console.log(`To accept the plan above: ${cmd} workspace ${positional[0] ?? '.'} --yes`);
      process.exitCode = 2;
      return;
    }
    const { confirm, isCancel } = await import('./prompt.mjs');
    const accepted = await confirm({ message: 'Write these files?', initialValue: true });
    if (isCancel(accepted) || !accepted) {
      console.log('Nothing was written.');
      return;
    }
  }
  await plan.apply();
  for (const write of plan.writes) console.log(`✓ ${write.path}`);
  console.log(`\nAn agent started in ${root} now reads which repositories are here and where the shared handoff is.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev workspace: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
