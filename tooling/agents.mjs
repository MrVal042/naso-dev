#!/usr/bin/env node
// NASO agents — one-line pointers from other coding agents' instruction files to AGENTS.md.
//
// AGENTS.md is the source. Every other agent gets a reference to it, never a copy: a copy
// is a second briefing that goes stale the day the first one is corrected.
//
//   cursor    .cursor/rules/naso.mdc, a rule Cursor always applies
//   copilot   .github/copilot-instructions.md
//   gemini    GEMINI.md, with Gemini CLI's own `@AGENTS.md` import, as CLAUDE.md has
//   windsurf  .windsurf/rules/naso.md, a rule Windsurf always applies
//   codex     nothing: Codex reads AGENTS.md itself
//
// Each is opt-in. A file that is there already is appended to inside naso markers, never
// rewritten; one that already names AGENTS.md is left as it is; one git tracks is left as it
// is in a local run, with the line to add, because editing it would put NASO in the next
// commit. A file this creates in a local run is kept out of git in .git/info/exclude.

import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { parseArgs, isMainModule, nasoCommand, SUPPORT_EMAIL, pathExists, listOption, run } from './lib.mjs';
import { repoContext } from './handoff.mjs';
import { excludeLocally, isIgnored } from './install.mjs';

const START = '<!-- naso:start -->';
const END = '<!-- naso:end -->';
const POINTER = 'This repository\'s briefing is AGENTS.md at its root. Read it before you change anything; it says what to read next.';

/**
 * Each agent: its name, the file NASO writes, how the file starts when NASO creates it, and
 * where this repository already shows the agent is used. `own` files are NASO's alone (a
 * file of rules in a folder of rules), so NASO creates them whole; the others are one file
 * per repository that a person may already keep, so NASO appends to it.
 */
export const AGENTS = {
  cursor: {
    label: 'Cursor',
    file: '.cursor/rules/naso.mdc',
    own: true,
    head: '---\ndescription: The repository briefing, AGENTS.md\nalwaysApply: true\n---\n\n',
    body: POINTER,
    signs: ['.cursor', '.cursorrules'],
    others: { dir: '.cursor/rules', files: ['.cursorrules'] },
  },
  copilot: {
    label: 'Copilot',
    file: '.github/copilot-instructions.md',
    body: POINTER,
    signs: ['.github/copilot-instructions.md', '.github/instructions'],
    others: { dir: '.github/instructions', files: [] },
  },
  gemini: {
    label: 'Gemini',
    file: 'GEMINI.md',
    body: 'Gemini CLI reads this file, not AGENTS.md. The line below loads the NASO briefing.\n\n@AGENTS.md',
    signs: ['GEMINI.md', '.gemini'],
    others: { dir: null, files: [] },
  },
  windsurf: {
    label: 'Windsurf',
    file: '.windsurf/rules/naso.md',
    own: true,
    head: '---\ntrigger: always_on\n---\n\n',
    body: POINTER,
    signs: ['.windsurf', '.windsurfrules'],
    others: { dir: '.windsurf/rules', files: ['.windsurfrules'] },
  },
};

/** Codex reads AGENTS.md as its own file, so it is detected and named but never written for. */
export const NATIVE = { codex: { label: 'Codex', signs: ['.codex'] } };

export const AGENT_NAMES = Object.keys(AGENTS);

// Blank lines around the body and after front matter: Prettier puts them there, and a
// pointer that fails the repository's own `prettier --check` is NASO's noise in its CI.
const block = (agent) => `${START}\n\n${agent.body}\n\n${END}\n`;

/** The bytes a new pointer file holds. */
export function pointerContent(agent) {
  return `${agent.head ?? ''}${block(agent)}`;
}

/** `before` with the pointer block appended, separated by one blank line. */
export function appendPointer(before, agent) {
  const separator = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${separator}${block(agent)}`;
}

/** The agents this repository shows signs of using, from files and folders at its root. */
export async function detectAgents(root) {
  const found = [];
  for (const [name, agent] of [...Object.entries(AGENTS), ...Object.entries(NATIVE)]) {
    const sign = [];
    for (const rel of agent.signs) if (await pathExists(path.join(root, rel))) sign.push(rel);
    if (sign.length > 0) found.push({ name, label: agent.label, signs: sign, native: name in NATIVE });
  }
  return found;
}

const mentionsAgents = (text) => /AGENTS\.md/.test(String(text ?? ''));

/** A file of the agent's, other than NASO's, that already sends it to AGENTS.md, or null. */
async function alreadyLinked(root, name, agent) {
  const candidates = [...agent.others.files];
  if (agent.others.dir) {
    const entries = await readdir(path.join(root, agent.others.dir)).catch(() => []);
    for (const entry of entries.sort()) candidates.push(`${agent.others.dir}/${entry}`);
  }
  for (const rel of candidates) {
    if (rel === agent.file) continue;
    if (mentionsAgents(await readFile(path.join(root, rel), 'utf8').catch(() => null))) return rel;
  }
  if (name === 'gemini') {
    // Gemini CLI can be told to read AGENTS.md itself: context.fileName, or the older contextFileName.
    const settings = await readFile(path.join(root, '.gemini', 'settings.json'), 'utf8').then(JSON.parse).catch(() => null);
    const names = [settings?.context?.fileName, settings?.contextFileName].flat().filter((value) => typeof value === 'string');
    if (names.includes('AGENTS.md')) return '.gemini/settings.json';
  }
  return null;
}

async function isTracked(root, rel) {
  const res = await run('git', ['ls-files', '-z', '--', rel], { cwd: root });
  return res.ok && res.stdout.length > 0;
}

/**
 * What to do for one agent:
 *   create  — no file; write the pointer
 *   append  — the file is there, untracked or --track; add the pointer below what is there
 *   linked  — it, or another file of the agent's, names AGENTS.md already
 *   advise  — git tracks it and this run is local; say what to add
 */
export async function planPointer(root, name, { tracked = false } = {}) {
  const agent = AGENTS[name];
  const full = path.join(root, ...agent.file.split('/'));
  const before = await readFile(full, 'utf8').catch(() => null);
  if (before !== null && (before.includes(START) || mentionsAgents(before))) return { name, agent, action: 'linked', via: agent.file, full, before };
  const via = await alreadyLinked(root, name, agent);
  if (via) return { name, agent, action: 'linked', via, full, before };
  if (before === null) return { name, agent, action: 'create', full, before: '', after: pointerContent(agent) };
  if (!tracked && (await isTracked(root, agent.file))) return { name, agent, action: 'advise', full, before };
  return { name, agent, action: 'append', full, before, after: appendPointer(before, agent) };
}

const lines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/**
 * The plan for the pointers asked for, in the shape setup and `claude` use:
 * { writes, plans, report, errors, apply, unknown, native }. `names` may hold 'all'.
 */
export async function planAgents(cwd, { track, names = [] } = {}) {
  const { config } = await repoContext(cwd);
  const root = path.resolve(cwd);
  const tracked = track ?? config?.track === true;
  const wanted = names.includes('all') ? AGENT_NAMES : names;
  const unknown = wanted.filter((name) => !(name in AGENTS) && !(name in NATIVE));
  const native = wanted.filter((name) => name in NATIVE);
  const writes = [];
  const plans = [];
  const report = [];
  const errors = unknown.map((name) => `--agents ${name}: not an agent NASO knows. It knows ${[...AGENT_NAMES, ...Object.keys(NATIVE)].join(', ')}.`);
  const chosen = [];

  for (const name of native) report.push(`${NATIVE[name].label}: reads AGENTS.md itself; nothing to write.`);

  for (const name of AGENT_NAMES.filter((entry) => wanted.includes(entry))) {
    const plan = await planPointer(root, name, { tracked });
    const { agent } = plan;
    if (plan.action === 'linked') {
      report.push(`${agent.label}: ${plan.via} already points at AGENTS.md; left as it is.`);
      continue;
    }
    if (plan.action === 'advise') {
      const advice = `${agent.label}: ${agent.file} is tracked in git, so a local run leaves it as it is. Add this line to it, or re-run with --track: ${agent.body.split('\n').pop()}`;
      report.push(advice);
      plans.push({ target: agent.file, verb: 'Leave', detail: advice });
      continue;
    }
    chosen.push(plan);
    writes.push(
      plan.action === 'create'
        ? { path: agent.file, change: 'new', lines: lines(plan.after), note: `points ${agent.label} at AGENTS.md` }
        : { path: agent.file, change: 'append', lines: lines(plan.after) - lines(plan.before), note: `points ${agent.label} at AGENTS.md, below what is there` },
    );
    plans.push({
      target: agent.file,
      verb: plan.action === 'create' ? 'Write' : 'Append',
      detail: `One line, inside naso markers, that sends ${agent.label} to AGENTS.md. A pointer, not a copy, so there is one briefing to keep true.`,
    });
    report.push(`${agent.label}: ${plan.action === 'create' ? 'wrote' : 'appended to'} ${agent.file}.`);
  }

  const apply = async () => {
    for (const plan of chosen) {
      await mkdir(path.dirname(plan.full), { recursive: true });
      await writeFile(plan.full, plan.after, 'utf8');
    }
    // A file this run created is NASO's alone, so in a local run it stays out of git like
    // AGENTS.md. A file it appended to was the person's; whether git sees it is theirs to say.
    if (!tracked) {
      const created = [];
      for (const plan of chosen.filter((entry) => entry.action === 'create')) {
        if (!(await isIgnored(root, plan.agent.file))) created.push(plan.agent.file);
      }
      if (created.length > 0) await excludeLocally(root, created);
    }
  };

  return { root, writes, plans, report, errors, apply, unknown, native };
}

/**
 * What the plan says about agents nobody asked for but the repository shows signs of: one
 * line each, naming the flag that points it at AGENTS.md. Nothing when none are detected.
 */
export async function detectedHints(cwd, asked = []) {
  const all = asked.includes('all');
  return (await detectAgents(path.resolve(cwd)))
    .filter((entry) => !entry.native && !all && !asked.includes(entry.name))
    .map((entry) => ({ ...entry, hint: `${entry.label} is set up here (${entry.signs.join(', ')}). \`--agents ${entry.name}\` points it at AGENTS.md.` }));
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, lists, positional } = parseArgs(argv);
  const cmd = nasoCommand();
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO agents

Usage:
  ${cmd} agents [target-dir]                         say which agents this repository uses
  ${cmd} agents <name…|all> [target-dir] [--track] [--dry-run]

Points other coding agents at AGENTS.md with one line each, never a copy:
  cursor    .cursor/rules/naso.mdc, applied to every request
  copilot   .github/copilot-instructions.md
  gemini    GEMINI.md, importing AGENTS.md with @AGENTS.md
  windsurf  .windsurf/rules/naso.md, applied to every request
  codex     nothing to write: Codex reads AGENTS.md itself
Claude Code is pointed at it by setup, through CLAUDE.md.

A file that is there already gets the line appended inside naso markers. One that already
names AGENTS.md is left alone. One git tracks is left alone unless --track, with the line
to add. A file created here is kept out of git, unless --track or .naso/ is committed.`);
    return;
  }

  const known = new Set([...AGENT_NAMES, ...Object.keys(NATIVE), 'all']);
  const names = [...positional.filter((word) => known.has(word)), ...listOption(lists, 'agents')];
  const rest = positional.filter((word) => !known.has(word));
  // The target is the last word that is a directory; any other word is a misspelt agent.
  const dirs = [];
  for (const word of rest) if ((await stat(word).catch(() => null))?.isDirectory()) dirs.push(word);
  const stray = rest.filter((word) => !dirs.includes(word));
  if (stray.length > 0) {
    console.error(`naso-dev agents: ${stray.map((word) => `'${word}'`).join(', ')} is not an agent NASO knows, or a directory. It knows ${[...known].join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const target = path.resolve(dirs.at(-1) ?? process.cwd());

  if (names.length === 0) {
    const found = await detectAgents(target);
    if (found.length === 0) {
      console.log(`No other agent's config is in ${target}. Name one to point it at AGENTS.md: ${cmd} agents cursor`);
      return;
    }
    for (const entry of found) {
      const linked = entry.native ? null : (await planPointer(target, entry.name, { tracked: true })).action === 'linked';
      const state = entry.native ? 'reads AGENTS.md itself' : linked ? 'points at AGENTS.md' : `does not load AGENTS.md: ${cmd} agents ${entry.name}`;
      console.log(`${entry.label.padEnd(9)} ${entry.signs.join(', ')} — ${state}`);
    }
    return;
  }

  const plan = await planAgents(target, { track: flags.has('track') ? true : undefined, names });
  for (const line of plan.report) console.log(line);
  for (const error of plan.errors) console.error(`naso-dev agents: ${error}`);
  if (flags.has('dry-run')) {
    console.log('\n--dry-run: nothing was written.');
    return;
  }
  await plan.apply();
  if (plan.errors.length > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev agents: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}

