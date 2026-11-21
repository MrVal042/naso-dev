#!/usr/bin/env node
// NASO lessons — what a session learned, kept for the next one.
//
// A correction a person makes in one session is made again in the next unless it is
// written down where the next session looks. One file per lesson, with the reason and how
// to apply it, because a rule without its reason is argued with; one line per lesson in an
// index, because the index is what a briefing links and an agent scans. The lessons
// themselves are read only when their line applies.
//
// Kept like the handoff: in .naso/lessons/ when .naso/ is committed, under the git common
// directory when it is local, so every worktree of a clone shares them.

import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { parseArgs, isMainModule, nasoCommand, toPosixPath, SUPPORT_EMAIL, pathExists } from './lib.mjs';
import { locateLessons } from './handoff.mjs';

export { locateLessons };
import { slugify } from './decisions.mjs';
import { extractPathTokens } from './check.mjs';

export const LESSON_TYPES = ['feedback', 'project', 'reference'];
export const LESSONS_START = '<!-- naso:lessons:start -->';
export const LESSONS_END = '<!-- naso:lessons:end -->';
const INDEX = 'README.md';

/** Front matter values are one line; quote one that YAML would read as something else. */
const yamlValue = (value) => {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return /^[\w(][^:#]*$/.test(text) && !/^(true|false|null|yes|no)$/i.test(text) ? text : JSON.stringify(text);
};

export function renderLesson({ slug, title, description, type, why, apply }) {
  return [
    '---',
    `name: ${slug}`,
    `description: ${yamlValue(description ?? title)}`,
    `type: ${type}`,
    '---',
    '',
    `# ${title}`,
    '',
    `**Why:** ${why.trim()}`,
    '',
    `**How to apply:** ${apply.trim()}`,
    '',
  ].join('\n');
}

/** One lesson file, read back: { slug, file, title, description, type, why, apply, text }. */
export function parseLesson(file, text) {
  const front = {};
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const match = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
      if (match) front[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }
  const field = (label) => new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() ?? '';
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? front.name ?? path.basename(file, '.md');
  return {
    slug: path.basename(file, '.md'),
    file,
    title,
    description: front.description ?? title,
    type: front.type ?? 'feedback',
    why: field('Why'),
    apply: field('How to apply'),
    text,
  };
}

export async function readLessons(located) {
  const names = (await readdir(located.dir).catch(() => [])).filter((name) => name.endsWith('.md') && name !== INDEX).sort();
  const lessons = [];
  for (const name of names) {
    const text = await readFile(path.join(located.dir, name), 'utf8').catch(() => null);
    if (text !== null) lessons.push(parseLesson(path.join(located.dir, name), text));
  }
  return lessons;
}

export function renderIndex(lessons) {
  const cmd = nasoCommand();
  const lines = [...lessons]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((lesson) => `- [${lesson.title}](${lesson.slug}.md) — ${lesson.type}${lesson.description && lesson.description !== lesson.title ? `: ${lesson.description}` : ''}`);
  return [
    '# Lessons',
    '',
    'One line per lesson a session learned: a correction, or an approach somebody confirmed.',
    'Read a lesson when its line applies to the work. Record one with',
    `\`${cmd} lesson --title "…" --why "…" --apply "…"\`; \`${cmd} lessons audit\` finds stale ones.`,
    '',
    LESSONS_START,
    ...lines,
    LESSONS_END,
    '',
  ].join('\n');
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

const normal = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (text) => new Set(normal(text).split(' ').filter((word) => word.length > 2));

function similar(a, b) {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / new Set([...x, ...y]).size >= 0.8;
}

/**
 * What a lesson tells an agent to do or not do: [{ polarity, key }]. "Never squash merge
 * feature branches" and "Always squash merge feature branches" share a key and differ in
 * polarity. The key is the first four words after the verb of command, so wording that
 * only differs later in the sentence still matches.
 */
function directives(lesson) {
  const out = [];
  for (const sentence of `${lesson.apply}. ${lesson.title}`.split(/[.;!?]\s*/)) {
    const negative = /\b(?:never|do not|don't|dont|avoid|must not|should not)\s+(.+)/i.exec(sentence);
    const positive = negative ? null : /\b(?:always|must|should)\s+(.+)/i.exec(sentence);
    const match = negative ?? positive;
    if (!match) continue;
    const key = normal(match[1]).split(' ').slice(0, 4).join(' ');
    if (key.split(' ').length >= 2) out.push({ polarity: negative ? 'no' : 'yes', key });
  }
  return out;
}

/** Findings, each { level: 'error' | 'warn', slug, text }. Changes nothing. */
export async function auditLessons(located) {
  const lessons = await readLessons(located);
  const findings = [];
  for (const lesson of lessons) {
    for (const token of extractPathTokens(`${lesson.why}\n${lesson.apply}`)) {
      if (!(await pathExists(path.join(located.root, token)))) {
        findings.push({ level: 'error', slug: lesson.slug, text: `cites ${token}, which does not exist` });
      }
    }
  }
  for (let i = 0; i < lessons.length; i++) {
    for (let j = 0; j < i; j++) {
      const [a, b] = [lessons[j], lessons[i]];
      if (normal(a.title) === normal(b.title) || similar(a.title, b.title)) {
        findings.push({ level: 'warn', slug: b.slug, text: `duplicates ${a.slug}: merge them, or say how they differ` });
        continue;
      }
      const clash = directives(a).find((one) => directives(b).some((two) => two.key === one.key && two.polarity !== one.polarity));
      if (clash) findings.push({ level: 'warn', slug: b.slug, text: `contradicts ${a.slug} about "${clash.key}": ask the person which holds` });
    }
  }
  return { lessons, findings };
}

/** `naso-dev lesson`: write one lesson and its index line. */
export async function lessonMain(argv = process.argv.slice(2)) {
  const { flags, values, positional } = parseArgs(argv, { valued: ['why'] });
  const cmd = nasoCommand();
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO lesson

Usage:
  ${cmd} lesson --title "…" --why "…" --apply "…" [--type feedback|project|reference] [--description "…"] [target-dir]

Records what a session learned, one file per lesson, and adds one line to the index the
briefing links. feedback: a correction or a confirmed approach (the default). project: a
fact about this repository's work. reference: where something lives outside it.`);
    return;
  }
  const title = values.get('title')?.trim();
  const why = values.get('why')?.trim();
  const apply = values.get('apply')?.trim();
  const type = (values.get('type') ?? 'feedback').trim();
  const refuse = (message) => {
    console.error(`naso-dev lesson: ${message}`);
    process.exitCode = 1;
  };
  if (!title || !why || !apply) return refuse(`--title, --why and --apply are all needed: ${cmd} lesson --title "…" --why "…" --apply "…"`);
  if (!LESSON_TYPES.includes(type)) return refuse(`--type is one of ${LESSON_TYPES.join(', ')}, not ${type}.`);

  const located = await locateLessons(positional[0] ?? process.cwd());
  const existing = await readLessons(located);
  const same = existing.find((lesson) => lesson.title.trim().toLowerCase() === title.toLowerCase());
  if (same) return refuse(`a lesson with this title is already recorded: ${toPosixPath(path.relative(located.root, same.file))}. Edit that file instead.`);

  const base = slugify(title);
  let slug = base;
  for (let n = 2; existing.some((lesson) => lesson.slug === slug); n++) slug = `${base}-${n}`;
  const lesson = { slug, title, description: values.get('description')?.trim() || title, type, why, apply };
  await writeAtomic(path.join(located.dir, `${slug}.md`), renderLesson(lesson));
  await writeAtomic(located.index, renderIndex([...existing, lesson]));
  console.log(`Recorded ${located.shown}/${slug}.md and its line in ${located.shown}/${INDEX}.`);
}

/** `naso-dev lessons [audit]`. */
export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const cmd = nasoCommand();
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO lessons

Usage:
  ${cmd} lessons [target-dir]          print the index
  ${cmd} lessons audit [target-dir]    lessons citing a path that is gone (error), and lessons
                                       that duplicate or contradict each other (warning)

The audit changes nothing. It exits 1 when there is an error.`);
    return;
  }
  const sub = positional[0] === 'audit' ? 'audit' : null;
  const located = await locateLessons((sub ? positional[1] : positional[0]) ?? process.cwd());

  if (sub === 'audit') {
    const { lessons, findings } = await auditLessons(located);
    for (const finding of findings) console.log(`${finding.level === 'error' ? 'ERROR' : 'WARN '}  ${finding.slug}  ${finding.text}`);
    const errors = findings.filter((finding) => finding.level === 'error').length;
    const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    console.log(findings.length === 0 ? `${n(lessons.length, 'lesson')}, no findings.` : `${n(lessons.length, 'lesson')}, ${n(findings.length, 'finding')} (${n(errors, 'error')}). Nothing was changed.`);
    if (errors > 0) process.exitCode = 1;
    return;
  }

  const lessons = await readLessons(located);
  if (lessons.length === 0) {
    console.log(`No lessons yet in ${located.shown}/. Record one: ${cmd} lesson --title "…" --why "…" --apply "…"`);
    return;
  }
  console.log(`Lessons, from ${located.shown}/${INDEX}:\n`);
  for (const line of renderIndex(lessons).split('\n').filter((entry) => entry.startsWith('- '))) console.log(line);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev lessons: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
