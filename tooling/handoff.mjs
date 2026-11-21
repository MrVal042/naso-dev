#!/usr/bin/env node
// NASO handoff — what one session leaves for the next.
//
// The biggest gain between sessions, and the easiest file to ruin. Two ways it went wrong
// in the field: with nothing bounding it, a handoff passed 1,500 lines; and when every
// update was a new entry on top, each one restated the last, so the part meant to say
// where things stand became a log.
//
// So the file has two parts that are kept differently:
//
//   NOW  one current state, replaced whole by `handoff set`: where things stand, the next
//        steps, the open items. Read at every session start, so it is the part with a cap.
//        Open items ("- [ ] …", "- Waiting on …") get an id and never age out; they leave
//        only when somebody closes them.
//   Log  dated history, newest first, added to by `handoff log`. Only the log ages out:
//        past LOG_DAYS or LOG_CAP lines, oldest first, into a monthly archive nothing
//        reads at session start.
//
// One file per repository, not per worktree. When .naso/ is committed it lives there and
// travels with the branch like any tracked file. When it is kept local it lives under
// the git common directory, the one place every linked worktree of a clone shares.

import path from 'node:path';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { parseArgs, listOption, isMainModule, nasoCommand, toPosixPath, SUPPORT_EMAIL, pathExists, run } from './lib.mjs';
import { readDecisions } from './decisions.mjs';

export const NOW_START = '<!-- naso:now:start -->';
export const NOW_END = '<!-- naso:now:end -->';
export const WEEK_START = '<!-- naso:week:start -->';
export const WEEK_END = '<!-- naso:week:end -->';
export const LOG_START = '<!-- naso:log:start -->';
export const LOG_END = '<!-- naso:log:end -->';

/** Lines NOW may hold before the gate warns. About a screen: cheap to read every session. */
export const NOW_CAP = 60;
/** Log lines kept below NOW; the oldest past this move to the archive. */
export const LOG_CAP = 60;
/** Log lines older than this many days move to the archive. */
export const LOG_DAYS = 14;

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
/**
 * The working tree root, `.naso/config.json`, and the git common directory (null outside
 * git): what the handoff and the lessons both decide their location from.
 */
export async function repoContext(cwd) {
  const start = path.resolve(cwd);
  // A workspace folder is not a repository, and may sit inside one (a home folder kept in
  // git): it is its own root, decided before git is asked anything.
  const own = await readJSON(path.join(start, '.naso', 'config.json'));
  if (own?.workspace) return { root: start, config: own, common: null };
  const root = (await gitPath(start, '--show-toplevel')) ?? start;
  const config = await readJSON(path.join(root, '.naso', 'config.json'));
  const common = await gitPath(root, '--git-common-dir');
  return { root, config, common };
}

export async function locateHandoff(cwd, { track } = {}) {
  const { root, config, common } = await repoContext(cwd);
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

  if (common) return describe(path.join(common, 'naso', 'HANDOFF.md'), 'git');
  return describe(inRepo, 'repo');
}

/**
 * Where this repository's lessons are: { root, dir, index, where, shown }. Decided like the
 * handoff, so the two always sit together:
 *   repo — `.naso/lessons/`: it exists, .naso/ is committed, or this is not a git repository
 *   git  — `<git common dir>/naso/lessons/`: kept local, shared by every worktree
 * `index` is the README.md the briefing links; `shown` is `dir` relative to the root.
 */
export async function locateLessons(cwd, { track } = {}) {
  const { root, config, common } = await repoContext(cwd);
  const describe = (dir, where) => ({
    root,
    dir,
    index: path.join(dir, 'README.md'),
    where,
    shown: toPosixPath(path.relative(root, dir)),
  });
  const inRepo = path.join(root, '.naso', 'lessons');
  if (await pathExists(inRepo)) return describe(inRepo, 'repo');
  if ((track ?? config?.track) === true || !common) return describe(inRepo, 'repo');
  return describe(path.join(common, 'naso', 'lessons'), 'git');
}

/** A new handoff. Says how each part is kept, so a person or an agent with no NASO can use it. */
export function renderHandoff({ archiveShown }) {
  const cmd = nasoCommand();
  return [
    '# Handoff',
    '',
    'What the last session left for the next one. Read NOW at the start of a session; read the',
    'log only when you need the history.',
    '',
    `- NOW is one current state, replaced whole with \`${cmd} handoff set\`: where things stand, the`,
    '  next steps, and the open items. Write an open item as `- [ ] …` or `- Waiting on <who>: …`;',
    `  it gets an id, never ages out, and leaves only with \`${cmd} handoff done <id>\` or`,
    '  `set --close <id>`. A set that leaves one out carries it over.',
    `- The log is dated history, newest first: \`${cmd} handoff log "…"\`. Lines older than ${LOG_DAYS}`,
    `  days, and the oldest past ${LOG_CAP}, move to the archive on their own.`,
    '',
    'Update both when a PR opens or merges, when a decision is made, and before you stop.',
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
    '## Log',
    '',
    LOG_START,
    LOG_END,
    '',
    '## Archive',
    '',
    `Older log lines are in \`${archiveShown}\`, one file per month (YYYY-MM.md). Read them only`,
    'when somebody asks about older work.',
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

/** The text between the log markers, or '' when there are none. */
export function logSection(text) {
  return between(text, LOG_START, LOG_END)?.body ?? '';
}

/** Lines in NOW that are not blank. */
export function nowLineCount(text) {
  return nowSection(text).split('\n').filter((line) => line.trim() !== '').length;
}

const OPEN_ITEM = /^[-*]\s+\[ \]\s+(?:\((\d+)\)\s+)?(.*)$/;
const WAITING = /^[-*]\s+(?:\((\d+)\)\s+)?(waiting on\b.*)$/i;
const CLOSED_IN_LOG = /\b(?:done|closed) \((\d+)\)/g;

/** The open items in NOW: `{ id, text, from, to }`, lines `from`..`to` of NOW's body. */
export function openItems(text) {
  const lines = nowSection(text).split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const match = OPEN_ITEM.exec(lines[i].replace(/\r$/, ''));
    if (!match || !match[1]) continue;
    let to = i;
    while (to + 1 < lines.length && /^\s+\S/.test(lines[to + 1])) to++;
    items.push({ id: Number(match[1]), text: match[2].trim(), from: i, to });
  }
  return items;
}

function highestId(text) {
  const ids = [
    ...openItems(text).map((item) => item.id),
    ...[...logSection(text).matchAll(CLOSED_IN_LOG)].map((match) => Number(match[1])),
  ];
  return Math.max(0, ...ids);
}

function withSection(text, start, end, body, heading) {
  const parts = between(text, start, end);
  if (!parts) return `${text.trimEnd()}\n\n## ${heading}\n\n${start}${body}${end}\n`;
  return `${parts.before}${body}${parts.after}`;
}

const asBody = (lines) => (lines.length > 0 ? `\n${lines.join('\n')}\n` : '\n');

function logLines(text) {
  return logSection(text).split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
}

/** A dated line at the top of the log. Continuation lines are indented under it. Never trims. */
export function logEntry(text, entryText, { today: on = today() } = {}) {
  const [first, ...rest] = String(entryText).trim().split(/\r?\n/);
  const entry = [`- ${on}: ${first}`, ...rest.filter((line) => line.trim()).map((line) => `  ${line.trim()}`)];
  return withSection(text, LOG_START, LOG_END, asBody([...entry, ...logLines(text)]), 'Log');
}

/**
 * Replace NOW. Every open item and waiting line gets an id, keeping the one it had; a
 * waiting line becomes an open item so there is one way to close things. A line with an
 * id that is already open replaces that item: an update, never a second copy.
 *
 * An open item the new state leaves out is carried over, not closed. An agent rewriting NOW
 * drops a "Waiting on …" line by mistake far more often than it means to close one, and a
 * silent close loses the only record that somebody is still owed something. Only `close`
 * (ids, from `--close`) or `closeItem` closes, and the log records each.
 *
 * Returns { text, items, carried, closed, unknown }. With an id in `close` that is not
 * open, nothing changes and `unknown` lists it.
 */
export function setNow(text, state, { today: on = today(), close = [] } = {}) {
  const before = openItems(text);
  const open = new Set(before.map((item) => item.id));
  const closing = [...new Set(close.map(Number))];
  const unknown = closing.filter((id) => !open.has(id));
  if (unknown.length > 0) return { text, items: before, carried: [], closed: [], unknown };

  let next = highestId(text);
  const written = [];
  let skipping = false;
  for (const raw of String(state).replace(/\r\n?/g, '\n').trim().split('\n')) {
    if (skipping && /^\s+\S/.test(raw)) continue;
    skipping = false;
    const open = OPEN_ITEM.exec(raw);
    const waiting = open ? null : WAITING.exec(raw);
    const match = open ?? waiting;
    if (!match) {
      written.push(raw.trimEnd());
      continue;
    }
    const id = match[1] ? Number(match[1]) : ++next;
    if (closing.includes(id)) {
      skipping = true;
      continue;
    }
    written.push(`- [ ] (${id}) ${match[2].trim()}`);
  }
  const present = new Set(written.map((line) => Number(OPEN_ITEM.exec(line)?.[1])).filter(Boolean));

  const nowLines = nowSection(text).split('\n').map((line) => line.replace(/\r$/, ''));
  const carried = before.filter((item) => !present.has(item.id) && !closing.includes(item.id));
  const carriedLines = carried.flatMap((item) => nowLines.slice(item.from, item.to + 1));
  const stateText = written.join('\n').trim();
  const body = [...(stateText ? stateText.split('\n') : []), ...(carriedLines.length > 0 && stateText ? [''] : []), ...carriedLines];

  let result = withSection(text, NOW_START, NOW_END, asBody(body), 'NOW');
  const closed = before.filter((item) => closing.includes(item.id));
  for (const item of [...closed].reverse()) result = logEntry(result, `closed (${item.id}) ${item.text}`, { today: on });
  return { text: result, items: openItems(result), carried, closed, unknown: [] };
}

/** Close one open item by id: out of NOW, into the log. `closed` is null when there is no such item. */
export function closeItem(text, id, { today: on = today() } = {}) {
  const item = openItems(text).find((candidate) => candidate.id === Number(id));
  if (!item) return { text, closed: null };
  const lines = nowSection(text).split('\n');
  lines.splice(item.from, item.to - item.from + 1);
  // Only the item goes. Blank lines a person put between paragraphs stay; blank lines left
  // at either end, and a double blank where the item was, do not.
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const result = withSection(text, NOW_START, NOW_END, asBody(body ? body.split('\n') : []), 'NOW');
  return { text: logEntry(result, `done (${item.id}) ${item.text}`, { today: on }), closed: item };
}

const dateOf = (entry) => /^[-*]\s+(\d{4}-\d{2}-\d{2})\b/.exec(entry[0])?.[1] ?? null;

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Move log lines out: those older than `days`, then the oldest until the log fits in `cap`
 * lines. NOW is never touched. Returns the new text and the moved entries grouped by month,
 * each month newest first. The newest entry always stays, however long it is.
 */
export function trimLog(text, { today: on = today(), days = LOG_DAYS, cap = LOG_CAP } = {}) {
  const entries = [];
  for (const line of logLines(text)) {
    if (/^[-*]\s/.test(line) || entries.length === 0) entries.push([line]);
    else entries.at(-1).push(line);
  }
  const keep = [];
  const out = [];
  for (const entry of entries) {
    const date = dateOf(entry);
    (date && daysBetween(date, on) > days ? out : keep).push(entry);
  }
  let lines = keep.flat().length;
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
  if (out.length === 0) return { text, moved };
  return { text: withSection(text, LOG_START, LOG_END, asBody(keep.flat()), 'Log'), moved };
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
  const title = (record) => String(record.title).replace(new RegExp(`^${record.id}\\.?\\s*[-—:]?\\s*`), '');
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

const archiveHeader = (month) => `# Handoff archive, ${month}\n\nLog lines that left the handoff, newest first. Read only on request.\n\n`;

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

/** Read, change, trim the log, refresh the week, write. `change` returns the text or { text, … }. */
async function update(cwd, change, limits) {
  const { located } = await ensureHandoff(cwd);
  const on = today();
  const changed = change(await readFile(located.file, 'utf8'), on);
  const result = typeof changed === 'string' ? { text: changed } : changed;
  const { text, moved } = trimLog(result.text, { today: on, ...limits });
  const archived = await appendToArchive(located.archiveDir, moved);
  await writeAtomic(located.file, withWeek(text, await weekSection(located.root, on)));
  return { ...result, text, located, archived };
}

const numberOption = (values, key, fallback) => {
  const raw = values.get(key);
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
};

function printArchived(archived, located) {
  for (const { month, count } of archived) {
    console.log(`Moved ${count} log ${count === 1 ? 'line' : 'lines'} to ${toPosixPath(path.relative(located.root, path.join(located.archiveDir, `${month}.md`)))}`);
  }
}

const isDirectory = async (candidate) => (await stat(candidate).catch(() => null))?.isDirectory() ?? false;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** `[text, target]` from the words after a subcommand, where the text may be left out. */
async function textAndTarget(rest) {
  if (rest.length >= 2) return [rest[0], rest[1]];
  if (rest.length === 1 && (await isDirectory(rest[0]))) return [null, rest[0]];
  return [rest[0] ?? null, undefined];
}

function refuse(message) {
  console.error(message);
  process.exitCode = 1;
}

function printNow(text, located) {
  const now = nowSection(text).trim();
  console.log(`NOW, from ${located.shown}:\n`);
  console.log(now || `(empty) Say where things stand: ${nasoCommand()} handoff set "…"`);
  const count = nowLineCount(text);
  if (count > NOW_CAP) console.log(`\nNOW is ${count} lines, over its cap of ${NOW_CAP}. Replace it with a shorter state: ${nasoCommand()} handoff set`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, values, lists, positional } = parseArgs(argv);
  const cmd = nasoCommand();
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO handoff

Usage:
  ${cmd} handoff [target-dir]                    create it if missing, then print NOW
  ${cmd} handoff set "<state>" [target-dir]      replace NOW (also --file <path>, or - for stdin);
                                                 open items it leaves out are carried over
      --close <id,…>                             close these open items as part of the set
  ${cmd} handoff log "<text>" [target-dir]       a dated line at the top of the log
  ${cmd} handoff done <id> [target-dir]          close an open item: out of NOW, into the log
  ${cmd} handoff trim [target-dir]               move old log lines to the archive
  ${cmd} handoff path [target-dir]               print where the handoff is

  --days <n>        log lines older than this leave the log (default ${LOG_DAYS})
  --max-lines <n>   the log's cap; the oldest lines leave past it (default ${LOG_CAP})

NOW is one state, replaced whole. In it, "- [ ] …" and "- Waiting on …" lines are open items:
they get an id, never age out, and leave only with done or set --close; a set that leaves
one out carries it over. A line with an open item's id updates that item. Only
the log ages out, into a monthly archive that nothing reads at session start.

Committed .naso/ keeps the handoff in .naso/HANDOFF.md. Otherwise it is under the git
directory, shared by every worktree of the clone.`);
    return;
  }

  const known = ['set', 'log', 'add', 'done', 'trim', 'path'];
  const sub = known.includes(positional[0]) ? positional[0] : null;
  const rest = sub ? positional.slice(1) : positional;
  const limits = { days: numberOption(values, 'days', LOG_DAYS), cap: numberOption(values, 'max-lines', LOG_CAP) };

  if (sub === 'set') {
    const close = listOption(lists, 'close');
    if (close.some((id) => !/^\d+$/.test(id))) return refuse(`naso-dev handoff set: --close takes item numbers: --close 2,3`);
    let state;
    let target;
    if (values.has('file')) {
      state = await readFile(path.resolve(values.get('file')), 'utf8').catch(() => null);
      target = rest[0];
      if (state === null) return refuse(`naso-dev handoff set: cannot read ${values.get('file')}.`);
    } else if (rest[0] === '-' || flags.has('file')) {
      state = await readStdin();
      target = rest[1];
    } else {
      [state, target] = await textAndTarget(rest);
      if (state === null) state = await readStdin();
    }
    if (!state || !state.trim()) {
      return refuse(`naso-dev handoff set: give the new state: ${cmd} handoff set "Where things stand. Next: … - [ ] open item", --file <path>, or - to read stdin.`);
    }
    const located = await locateHandoff(target ?? process.cwd());
    const current = await readFile(located.file, 'utf8').catch(() => null);
    const unknown = current === null ? close.map(Number) : setNow(current, state, { close: close.map(Number) }).unknown;
    if (unknown.length > 0) {
      return refuse(`naso-dev handoff set: no open item ${unknown.map((id) => `(${id})`).join(', ')} in ${located.shown}; nothing was changed. ${cmd} handoff lists them.`);
    }
    const result = await update(target ?? process.cwd(), (text, on) => setNow(text, state, { today: on, close: close.map(Number) }), limits);
    console.log(`Replaced NOW in ${result.located.shown}.`);
    for (const item of result.carried) console.log(`  carried over: (${item.id}) ${item.text}  (left out of the new state; close it with --close ${item.id} or ${cmd} handoff done ${item.id})`);
    for (const item of result.closed) console.log(`  closed: (${item.id}) ${item.text}  (the log records it)`);
    for (const item of result.items.filter((entry) => !result.carried.some((carried) => carried.id === entry.id))) console.log(`  open: (${item.id}) ${item.text}`);
    if (nowLineCount(result.text) > NOW_CAP) console.log(`NOW is ${nowLineCount(result.text)} lines, over its cap of ${NOW_CAP}. Say less: it is read at every session start.`);
    printArchived(result.archived, result.located);
    return;
  }

  if (sub === 'log' || sub === 'add') {
    if (sub === 'add') console.error(`naso-dev: handoff add is now handoff log; replace the current state with handoff set.`);
    const [entryText, target] = await textAndTarget(rest);
    if (!entryText || !entryText.trim()) {
      return refuse(`naso-dev handoff log: say what happened, in quotes: ${cmd} handoff log "Opened the parser PR."`);
    }
    const result = await update(target ?? process.cwd(), (text, on) => logEntry(text, entryText, { today: on }), limits);
    console.log(`Logged in ${result.located.shown}.`);
    printArchived(result.archived, result.located);
    return;
  }

  if (sub === 'done') {
    const [id, target] = rest;
    if (!/^\d+$/.test(String(id ?? ''))) return refuse(`naso-dev handoff done: give the item's number: ${cmd} handoff done 3`);
    const located = await locateHandoff(target ?? process.cwd());
    const text = await readFile(located.file, 'utf8').catch(() => null);
    if (text === null || !closeItem(text, id).closed) {
      return refuse(`naso-dev handoff done: there is no open item (${id}) in ${located.shown}. ${cmd} handoff lists them.`);
    }
    const result = await update(target ?? process.cwd(), (current, on) => closeItem(current, id, { today: on }), limits);
    console.log(`Closed (${result.closed.id}) ${result.closed.text}; the log records it.`);
    printArchived(result.archived, result.located);
    return;
  }

  if (sub === 'trim') {
    const result = await update(rest[0] ?? process.cwd(), (text) => text, limits);
    if (result.archived.length === 0) console.log(`Nothing to move: the log in ${result.located.shown} is within ${limits.cap} lines and ${limits.days} days.`);
    printArchived(result.archived, result.located);
    return;
  }

  if (sub === 'path') {
    console.log((await locateHandoff(rest[0] ?? process.cwd())).file);
    return;
  }

  const { located, created } = await ensureHandoff(rest[0] ?? process.cwd());
  if (created) console.log(`Created ${located.shown}${located.where === 'git' ? ' (in the git directory, shared by every worktree, never committed)' : ''}.\n`);
  printNow(await readFile(located.file, 'utf8'), located);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev handoff: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
