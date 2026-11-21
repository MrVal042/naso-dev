#!/usr/bin/env node
// NASO handoff — what one session leaves for the next.
//
// The biggest gain between sessions, and the easiest file to ruin: with nothing bounding
// it, a handoff in the field passed 1,500 lines, and every session paid to read all of it.
// So the file has one part that is read at session start, NOW, capped at NOW_CAP lines,
// and entries leave it on their own: by age, and past the cap oldest first, into a
// monthly archive that is read only when somebody asks for it.
//
// One file per repository, not per worktree. When .naso/ is committed it lives there and
// travels with the branch like any tracked file. When it is kept local it lives under
// the git common directory, the one place every linked worktree of a clone shares.

import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { parseArgs, isMainModule, nasoCommand, toPosixPath, SUPPORT_EMAIL, pathExists, run } from './lib.mjs';
import { readDecisions } from './decisions.mjs';

export const NOW_START = '<!-- naso:now:start -->';
export const NOW_END = '<!-- naso:now:end -->';
export const WEEK_START = '<!-- naso:week:start -->';
export const WEEK_END = '<!-- naso:week:end -->';

/** Lines NOW may hold. About a screen: enough for the state of a week, cheap to read. */
export const NOW_CAP = 60;
/** Entries older than this many days leave NOW at the next add or trim. */
export const NOW_DAYS = 14;

const REPO_FILE = path.join('.naso', 'HANDOFF.md');
const ARCHIVE_DIR = 'handoff-archive';
const WEEK_DAYS = 7;

const today = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function gitPath(cwd, flag) {
  const res = await run('git', ['rev-parse', flag], { cwd });
  const out = res.ok ? res.stdout.trim() : '';
  return out ? path.resolve(cwd, out) : null;
}

/**
 * Where this repository's handoff is, and why there.
 *
 *   configured — `.naso/config.json` names a path ("handoff": { "path": "…" })
 *   repo       — `.naso/HANDOFF.md`: it exists already, .naso/ is committed (--track or
 *                `track: true`), or this folder is not a git repository
 *   git        — `<git common dir>/naso/HANDOFF.md`: kept local, shared by every worktree
 *
 * `track` overrides the config, for setup, which decides before the config is written.
 * Returns { root, file, archiveDir, where, shown }; `shown` is the path to print, relative
 * to the working tree root, with forward slashes.
 */
export async function locateHandoff(cwd, { track } = {}) {
  const start = path.resolve(cwd);
  const root = (await gitPath(start, '--show-toplevel')) ?? start;
  const config = await readJSON(path.join(root, '.naso', 'config.json'));
  const describe = (file, where) => ({
    root,
    file,
    archiveDir: path.join(path.dirname(file), ARCHIVE_DIR),
    where,
    shown: toPosixPath(path.relative(root, file)),
  });

  const configured = config?.handoff?.path;
  if (typeof configured === 'string' && configured.trim()) return describe(path.resolve(root, configured.trim()), 'configured');

  const inRepo = path.join(root, REPO_FILE);
  if (await pathExists(inRepo)) return describe(inRepo, 'repo');
  if ((track ?? config?.track) === true) return describe(inRepo, 'repo');

  const common = await gitPath(root, '--git-common-dir');
  if (common) return describe(path.join(common, 'naso', 'HANDOFF.md'), 'git');
  return describe(inRepo, 'repo');
}

/** A new handoff. Says what goes in it and when, so a person or an agent with no NASO can use it. */
export function renderHandoff({ archiveShown }) {
  return [
    '# Handoff',
    '',
    'What the last session left for the next one. Read NOW at the start of a session. Update it',
    'when a PR opens or merges, when a decision is made, and before you stop: the current state,',
    'open PRs and branches, the next steps, and who the work is waiting on.',
    '',
    `\`${nasoCommand()} handoff add "…"\` adds a dated entry at the top. Entries older than ${NOW_DAYS} days,`,
    `and the oldest past ${NOW_CAP} lines, move to the archive on their own.`,
    '',
    '## NOW',
    '',
    NOW_START,
    NOW_END,
    '',
    '## Decisions this week',
    '',
    'Links to the records, never copies. Refreshed every time this file is written.',
    '',
    WEEK_START,
    WEEK_END,
    '',
    '## Archive',
    '',
    `Older entries are in \`${archiveShown}\`, one file per month (YYYY-MM.md). Read them only when`,
    'somebody asks about older work.',
    '',
  ].join('\n');
}

function between(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + 1);
  if (a === -1 || b === -1) return null;
  return { before: text.slice(0, a + start.length), body: text.slice(a + start.length, b), after: text.slice(b) };
}

/** The text between the NOW markers, or the whole file when a person removed them. */
export function nowSection(text) {
  return between(text, NOW_START, NOW_END)?.body ?? text;
}

/**
 * NOW as { head, entries }. An entry is a list item at the start of a line plus every line
 * under it up to the next one. Anything above the first entry is a person's own note and
 * is never moved.
 */
function parseNow(body) {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''));
  const head = [];
  const entries = [];
  for (const line of lines) {
    if (/^[-*]\s/.test(line)) entries.push([line]);
    else if (entries.length > 0) entries.at(-1).push(line);
    else head.push(line);
  }
  for (const entry of entries) {
    while (entry.length > 1 && entry.at(-1).trim() === '') entry.pop();
  }
  return { head: head.filter((line) => line.trim() !== ''), entries };
}

function joinNow({ head, entries }) {
  const lines = [...head, ...entries.flat()];
  return lines.length > 0 ? `\n${lines.join('\n')}\n` : '\n';
}

const dateOf = (entry) => /^[-*]\s+(\d{4}-\d{2}-\d{2})\b/.exec(entry[0])?.[1] ?? null;

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function withNow(text, now) {
  const parts = between(text, NOW_START, NOW_END);
  if (!parts) return `${text.trimEnd()}\n\n## NOW\n\n${NOW_START}${joinNow(now)}${NOW_END}\n`;
  return `${parts.before}${joinNow(now)}${parts.after}`;
}

/** A dated entry at the top of NOW. Continuation lines are indented under it. */
export function addEntry(text, entryText, { today: on = today() } = {}) {
  const [first, ...rest] = String(entryText).trim().split(/\r?\n/);
  const entry = [`- ${on}: ${first}`, ...rest.map((line) => (line.trim() ? `  ${line.trim()}` : ''))];
  const now = parseNow(nowSection(text));
  return withNow(text, { head: now.head, entries: [entry, ...now.entries] });
}

/**
 * Move entries out of NOW: those older than `days`, then the oldest until NOW fits in `cap`
 * lines. Returns the new text and the moved entries grouped by month, each month newest
 * first. An undated entry never ages out; past the cap it goes to this month.
 */
export function trimHandoff(text, { today: on = today(), days = NOW_DAYS, cap = NOW_CAP } = {}) {
  const now = parseNow(nowSection(text));
  const keep = [];
  const out = [];
  for (const entry of now.entries) {
    const date = dateOf(entry);
    (date && daysBetween(date, on) > days ? out : keep).push(entry);
  }
  let lines = now.head.length + keep.flat().length;
  // Always keep the newest entry, however long it is: a NOW with nothing in it says
  // nothing about the state the last session left.
  while (lines > cap && keep.length > 1) {
    const oldest = keep.pop();
    lines -= oldest.length;
    out.push(oldest);
  }
  const moved = {};
  for (const entry of out) {
    const month = (dateOf(entry) ?? on).slice(0, 7);
    (moved[month] ??= []).push(entry.join('\n'));
  }
  for (const month of Object.keys(moved)) {
    moved[month].sort((a, b) => (dateOf([b]) ?? '').localeCompare(dateOf([a]) ?? ''));
  }
  return { text: withNow(text, { head: now.head, entries: keep }), moved, lines };
}

/** Lines in NOW that are not blank. */
export function nowLineCount(text) {
  return nowSection(text).split('\n').filter((line) => line.trim() !== '').length;
}

/** Decisions dated in the last week, as links to their records. */
async function weekSection(root, on) {
  const { records } = await readDecisions(root).catch(() => ({ records: [] }));
  const recent = records
    .filter((record) => record.date && /^\d{4}-\d{2}-\d{2}/.test(record.date))
    .filter((record) => {
      const age = daysBetween(record.date.slice(0, 10), on);
      return age >= 0 && age <= WEEK_DAYS;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  if (recent.length === 0) return '\n';
  const title = (record) => String(record.title).replace(new RegExp(`^${record.id}\\s*[-—:]?\\s*`), '');
  return `\n${recent.map((record) => `- ${record.id} ${title(record)} (${record.status ?? 'no status'}): \`${record.file}\``).join('\n')}\n`;
}

function withWeek(text, week) {
  const parts = between(text, WEEK_START, WEEK_END);
  return parts ? `${parts.before}${week}${parts.after}` : text;
}

/** Write through a temporary file, so a reader never sees half a handoff. */
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

const archiveHeader = (month) => `# Handoff archive, ${month}\n\nEntries that left NOW, newest first. Read only on request.\n\n`;

async function appendToArchive(archiveDir, moved) {
  const written = [];
  for (const [month, entries] of Object.entries(moved)) {
    const file = path.join(archiveDir, `${month}.md`);
    const header = archiveHeader(month);
    const existing = await readFile(file, 'utf8').catch(() => '');
    // Newest first in the archive too: what moves now is newer than what moved before.
    const older = existing.startsWith(header) ? existing.slice(header.length) : existing;
    await writeAtomic(file, `${header}${entries.join('\n')}\n${older.trim() ? `${older.trimEnd()}\n` : ''}`);
    written.push({ month, count: entries.length, file });
  }
  return written;
}

/** Create the handoff if it is missing. Returns { located, created }. Never touches an existing one. */
export async function ensureHandoff(cwd, { track } = {}) {
  const located = await locateHandoff(cwd, { track });
  if (await pathExists(located.file)) return { located, created: false };
  const archiveShown = `${toPosixPath(path.relative(located.root, located.archiveDir))}/`;
  const text = withWeek(renderHandoff({ archiveShown }), await weekSection(located.root, today()));
  await writeAtomic(located.file, text);
  return { located, created: true };
}

/** Read, change, trim, refresh the week, write. Returns what moved. */
async function update(cwd, change, { days, cap }) {
  const { located } = await ensureHandoff(cwd);
  const on = today();
  const before = await readFile(located.file, 'utf8');
  const { text, moved } = trimHandoff(change(before), { today: on, days, cap });
  const archived = await appendToArchive(located.archiveDir, moved);
  await writeAtomic(located.file, withWeek(text, await weekSection(located.root, on)));
  return { located, archived, lines: nowLineCount(text) };
}

const numberOption = (values, key, fallback) => {
  const raw = values.get(key);
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
};

function printArchived(archived, located) {
  for (const { month, count } of archived) {
    console.log(`Moved ${count} ${count === 1 ? 'entry' : 'entries'} to ${toPosixPath(path.relative(located.root, path.join(located.archiveDir, `${month}.md`)))}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, values, positional } = parseArgs(argv);
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO handoff

Usage:
  ${nasoCommand()} handoff [target-dir]                 create it if missing, then print NOW
  ${nasoCommand()} handoff add "<text>" [target-dir]    a dated entry at the top of NOW
  ${nasoCommand()} handoff trim [target-dir]            move old entries to the archive
  ${nasoCommand()} handoff path [target-dir]            print where the handoff is

  --days <n>        entries older than this leave NOW (default ${NOW_DAYS})
  --max-lines <n>   NOW's cap; the oldest entries leave past it (default ${NOW_CAP})

Committed .naso/ keeps it in .naso/HANDOFF.md. Otherwise it is under the git directory,
shared by every worktree of the clone. Add and trim move entries to a monthly archive
beside it, which nothing reads at session start.`);
    return;
  }

  const sub = ['add', 'trim', 'path'].includes(positional[0]) ? positional[0] : null;
  const rest = sub ? positional.slice(1) : positional;
  const limits = { days: numberOption(values, 'days', NOW_DAYS), cap: numberOption(values, 'max-lines', NOW_CAP) };

  if (sub === 'add') {
    const [entryText, target] = rest;
    if (!entryText || !entryText.trim() || (rest.length === 1 && (await pathExists(entryText)) && !/\s/.test(entryText))) {
      console.error(`naso-dev handoff add: say what to add, in quotes: ${nasoCommand()} handoff add "Opened the parser PR; waiting on review."`);
      process.exitCode = 1;
      return;
    }
    const { located, archived, lines } = await update(target ?? process.cwd(), (text) => addEntry(text, entryText), limits);
    console.log(`Added to NOW in ${located.shown} (${lines} of ${limits.cap} lines).`);
    printArchived(archived, located);
    return;
  }

  if (sub === 'trim') {
    const { located, archived, lines } = await update(rest[0] ?? process.cwd(), (text) => text, limits);
    if (archived.length === 0) console.log(`Nothing to move: NOW in ${located.shown} is ${lines} of ${limits.cap} lines, none older than ${limits.days} days.`);
    printArchived(archived, located);
    return;
  }

  if (sub === 'path') {
    console.log((await locateHandoff(rest[0] ?? process.cwd())).file);
    return;
  }

  const { located, created } = await ensureHandoff(rest[0] ?? process.cwd());
  if (created) console.log(`Created ${located.shown}${located.where === 'git' ? ' (in the git directory, shared by every worktree, never committed)' : ''}.\n`);
  const text = await readFile(located.file, 'utf8');
  const now = nowSection(text).trim();
  console.log(`NOW, from ${located.shown}:\n`);
  console.log(now || `(empty) Add the state of the work: ${nasoCommand()} handoff add "…"`);
  const count = nowLineCount(text);
  if (count > limits.cap) console.log(`\nNOW is ${count} lines, over its cap of ${limits.cap}. Run: ${nasoCommand()} handoff trim`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev handoff: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
