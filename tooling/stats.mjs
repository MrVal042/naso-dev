#!/usr/bin/env node
// NASO stats — what an agent reads before it does anything, in estimated tokens.
//
// Every token here is paid at the start of every session, so it is the number the
// briefing should be judged by. The estimate is characters divided by four: no tokenizer,
// no dependency, and the same answer on every machine. It is wrong by the same factor
// for every file, which is what a before/after comparison needs.
//
// Read-only. It does not walk the repository, so it is as quick in a repository of a
// hundred thousand files as in one of ten, and it needs neither git nor a manifest.

import path from 'node:path';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { parseArgs, isMainModule, nasoCommand, toPosixPath, SUPPORT_EMAIL, toolVersion } from './lib.mjs';
import { locateHandoff, NOW_START, NOW_END } from './handoff.mjs';

export { NOW_START, NOW_END };

export const CHARS_PER_TOKEN = 4;

const NASO_START = '<!-- naso:start -->';
const NASO_END = '<!-- naso:end -->';

/**
 * Claude Code's memory files, in the order it reads them. CLAUDE.local.md is usually
 * ignored by git, but when it is on disk it is loaded like the others, so it counts.
 */
const CLAUDE_ENTRIES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

/** Claude Code stops following imports after five hops; so does the count. */
const MAX_IMPORT_DEPTH = 5;

const SECTIONS_SHOWN = 10;
const SECTIONS_IN_JSON = 25;

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

function countLines(text) {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * The text with code blocks and code spans blanked out, line count kept. An `@name` in
 * a code span is an example of the syntax, and a `# comment` in a fenced shell block is
 * not a heading; Claude Code skips imports in both, and so must the count.
 */
function withoutCode(text) {
  let inFence = false;
  let fence = '';
  return text
    .split('\n')
    .map((line) => {
      const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (opener) {
        if (!inFence) {
          inFence = true;
          fence = opener[1][0];
          return '';
        }
        if (opener[1][0] === fence) {
          inFence = false;
          return '';
        }
      }
      if (inFence) return '';
      return line.replace(/`[^`]*`/g, '');
    })
    .join('\n');
}

/**
 * `@path` at the start of a line or after whitespace, the way Claude Code reads it.
 * An e-mail address has a character before its `@` and so is not one. Trailing sentence
 * punctuation is not part of the path: "see @docs/one.md." imports docs/one.md.
 */
export function importsIn(text) {
  const found = [];
  for (const match of withoutCode(text).matchAll(/(^|\s)@([^\s<>"'`]+)/g)) {
    const target = match[2].replace(/[.,;:!?)\]]+$/, '');
    if (target) found.push(target);
  }
  return found;
}

/**
 * Sections, flat: each heading's own text up to the next heading at any level. Nested
 * sections are ranked on their own, so a long subsection is named rather than hidden
 * inside its parent. Text before the first heading is a section of its own when it has
 * any words in it.
 */
export function sectionsOf(text) {
  const lines = text.split('\n');
  const code = withoutCode(text).split('\n');
  const sections = [];
  let current = { heading: '(before the first heading)', lines: [] };
  for (let i = 0; i < lines.length; i++) {
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(code[i].replace(/\r$/, ''));
    if (heading && heading[1]) {
      sections.push(current);
      current = { heading: heading[1], lines: [] };
    }
    current.lines.push(lines[i]);
  }
  sections.push(current);
  return sections
    .map((section) => ({ heading: section.heading, text: section.lines.join('\n') }))
    .filter((section) => section.text.trim() !== '')
    .map((section) => ({ heading: section.heading, tokens: estimateTokens(section.text) }));
}

async function readText(full) {
  try {
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

async function realOrNull(full) {
  try {
    return await realpath(full);
  } catch {
    return null;
  }
}

/**
 * Whether an @-token that did not resolve is worth naming. "@someone" in a sentence is a
 * mention, and "@/src/lib/utils" is an import alias written in prose; neither is a file
 * anybody meant to load. A name with an extension is.
 */
function looksLikeFile(target) {
  return /\.[A-Za-z0-9]+$/.test(String(target ?? '').split(/[\\/]/).pop());
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Everything an agent loads at session start, measured.
 *
 *   files     — one entry per file, each counted once however many routes reach it
 *   total     — chars, lines and tokens across them
 *   sections  — the largest sections across every file, largest first
 *   nasoBlock — the NASO block in AGENTS.md on its own, or null
 *   skipped   — imports that were not counted, and why
 */
export async function measureSessionLoad(targetDir) {
  const root = path.resolve(targetDir);
  const realRoot = (await realOrNull(root)) ?? root;
  const seen = new Set();
  const files = [];
  const skipped = [];
  let nasoBlock = null;

  const record = (rel, text, { via = null, reason, part = 'whole' }) => {
    const entry = {
      path: toPosixPath(rel),
      part,
      via,
      reason,
      chars: text.length,
      lines: countLines(text),
      tokens: estimateTokens(text),
      sections: sectionsOf(text),
    };
    files.push(entry);
    return entry;
  };

  // Breadth-first from the Claude Code memory files, so a file reached two ways is
  // credited to the shorter route, which is the one a reader would look for.
  const queue = CLAUDE_ENTRIES.map((rel) => ({ rel, via: null, depth: 0 }));
  while (queue.length > 0) {
    const { rel, via, depth, asWritten } = queue.shift();
    const full = path.resolve(root, rel);
    const real = await realOrNull(full);
    if (!real) {
      if (via && looksLikeFile(asWritten)) skipped.push({ import: asWritten, from: via, reason: 'not found' });
      continue;
    }
    if (!isInside(realRoot, real)) {
      // A symlink inside the repository that points out of it.
      skipped.push({ import: asWritten ?? rel, from: via, reason: 'outside the repository' });
      continue;
    }
    if (seen.has(real)) continue;
    const text = await readText(full);
    if (text === null) continue;
    seen.add(real);
    const relPath = path.relative(root, full);
    record(relPath, text, { via, reason: via ? `imported by ${via}` : 'Claude Code reads it' });
    if (depth >= MAX_IMPORT_DEPTH) continue;
    for (const target of importsIn(text)) {
      const resolved = path.isAbsolute(target) ? target : path.join(path.dirname(relPath), target);
      const asRel = path.relative(root, path.resolve(root, resolved));
      if (target.startsWith('~') || asRel.startsWith('..') || path.isAbsolute(asRel)) {
        if (looksLikeFile(target)) skipped.push({ import: target, from: toPosixPath(relPath), reason: 'outside the repository' });
        continue;
      }
      queue.push({ rel: asRel, via: toPosixPath(relPath), depth: depth + 1, asWritten: target });
    }
  }
  // Imports are reported as written, not as resolved: that is the text the reader will
  // search for.
  for (const entry of skipped) entry.import = toPosixPath(entry.import);

  // AGENTS.md is read whole by the agents that follow the convention, with or without
  // CLAUDE.md. They do not follow @imports, so neither does the count from here.
  const agentsFull = path.join(root, 'AGENTS.md');
  const agentsReal = await realOrNull(agentsFull);
  if (agentsReal && !seen.has(agentsReal)) {
    const text = await readText(agentsFull);
    if (text !== null) {
      seen.add(agentsReal);
      record('AGENTS.md', text, { reason: 'agents that follow AGENTS.md read it' });
    }
  }
  const agentsText = agentsReal ? await readText(agentsFull) : null;
  if (agentsText) {
    const start = agentsText.indexOf(NASO_START);
    const end = agentsText.indexOf(NASO_END, start + 1);
    if (start !== -1 && end !== -1) {
      nasoBlock = { tokens: estimateTokens(agentsText.slice(start, end + NASO_END.length)) };
    }
  }

  // The handoff may live in the git directory, outside the working tree, when .naso/ is
  // kept local. That is still this repository's, so it counts; any other outside path does not.
  const handoff = await locateHandoff(root);
  const handoffReal = await realOrNull(handoff.file);
  if (handoffReal && (handoff.where === 'git' || isInside(realRoot, handoffReal)) && !seen.has(handoffReal)) {
    const text = await readText(handoff.file);
    if (text !== null) {
      seen.add(handoffReal);
      const start = text.indexOf(NOW_START);
      const end = text.indexOf(NOW_END, start + 1);
      const shown = handoff.shown;
      if (start !== -1 && end !== -1) {
        record(shown, text.slice(start + NOW_START.length, end), { reason: 'the handoff NOW section', part: 'NOW' });
      } else {
        record(shown, text, { reason: 'the handoff, with no NOW markers, so all of it', part: 'whole' });
      }
    }
  }

  // Project skills: Claude Code puts each one's description in context at session start and
  // reads the body only when the skill is used, so the front matter is what counts.
  const skillsDir = path.join(root, '.claude', 'skills');
  for (const entry of (await readdir(skillsDir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const rel = path.join('.claude', 'skills', entry.name, 'SKILL.md');
    const text = await readText(path.join(root, rel));
    const front = text === null ? null : /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)?.[0];
    if (front) record(rel, front, { reason: 'Claude Code lists the skill by its description', part: 'description' });
  }

  const sections = files
    .flatMap((file) => file.sections.map((section) => ({ file: file.path, ...section })))
    .sort((a, b) => b.tokens - a.tokens || a.file.localeCompare(b.file));

  return {
    root,
    charsPerToken: CHARS_PER_TOKEN,
    files: files.map(({ sections: _sections, ...file }) => file),
    total: {
      chars: files.reduce((sum, file) => sum + file.chars, 0),
      lines: files.reduce((sum, file) => sum + file.lines, 0),
      tokens: files.reduce((sum, file) => sum + file.tokens, 0),
    },
    nasoBlock,
    sections,
    skipped,
  };
}

const n = (value) => value.toLocaleString('en-US');

function printLoad(load, version) {
  console.log(`NASO stats ${version}  ${load.root}\n`);
  if (load.files.length === 0) {
    console.log('Nothing loads at session start: there is no AGENTS.md, CLAUDE.md or handoff here.');
    for (const entry of load.skipped) console.log(`  not counted  @${entry.import}  ${entry.reason}`);
    return;
  }
  console.log(`What an agent loads at session start, estimated at ${CHARS_PER_TOKEN} characters a token.\n`);
  const width = Math.max(4, ...load.files.map((file) => file.path.length + (file.part === 'whole' ? 0 : file.part.length + 3)));
  console.log(`  ${'File'.padEnd(width)}  ${'Lines'.padStart(6)}  ${'Tokens'.padStart(7)}  Why it loads`);
  for (const file of load.files) {
    const label = file.part === 'whole' ? file.path : `${file.path} (${file.part})`;
    console.log(`  ${label.padEnd(width)}  ${n(file.lines).padStart(6)}  ${n(file.tokens).padStart(7)}  ${file.reason}`);
  }
  console.log(`  ${'Total'.padEnd(width)}  ${n(load.total.lines).padStart(6)}  ${n(load.total.tokens).padStart(7)}`);
  const agents = load.files.find((file) => file.path === 'AGENTS.md');
  if (load.nasoBlock && agents) {
    console.log(`\n  The NASO block is ${n(load.nasoBlock.tokens)} of AGENTS.md's ${n(agents.tokens)} tokens.`);
  }

  console.log('\nLargest sections');
  for (const section of load.sections.slice(0, SECTIONS_SHOWN)) {
    console.log(`  ${n(section.tokens).padStart(7)}  ${section.file} › ${section.heading}`);
  }

  if (load.skipped.length > 0) {
    console.log('\nNot counted');
    for (const entry of load.skipped) {
      console.log(`  @${entry.import}  ${entry.reason}${entry.from ? ` (in ${entry.from})` : ''}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO stats

Usage:
  ${nasoCommand()} stats [target-dir] [--json]

What an agent loads at session start, in estimated tokens (${CHARS_PER_TOKEN} characters each):
CLAUDE.md and every file it imports, AGENTS.md, and the NOW section of the handoff.
Each file is counted once. Lists the largest sections, so you know what to cut.

  --json   the same numbers as JSON, for benchmarks and scripts

Reads only. Needs no git repository and no manifest.`);
    return;
  }
  const load = await measureSessionLoad(positional[0] ?? process.cwd());
  if (flags.has('json')) {
    console.log(JSON.stringify({ ...load, sections: load.sections.slice(0, SECTIONS_IN_JSON) }, null, 2));
    return;
  }
  printLoad(load, await toolVersion());
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev stats: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
