// NASO guides — the detail behind the root block, read when it applies.
//
// Everything in AGENTS.md is read at the start of every session, before the agent does any
// work. Most of it is needed only for one kind of task: how commits are written matters when
// committing, the source map when changing that folder, the decisions procedure when a
// decision comes up. So the block keeps what every session needs, about sixty lines, and a
// "When You Touch" table names the guide to read for each kind of task. The guides are
// files in .naso/guides/, written with the block, checked with the block, and edited like
// the block: a guide people changed is never replaced without --discard-edits.
//
// Zero external dependencies — Node.js core modules only.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DECISIONS_LEAD } from './lib.mjs';

/** Where guides live, written the same way on every platform because the block names it. */
export const GUIDES_DIR = '.naso/guides';

/** The heading of the table that routes a task to its guide. */
export const TOUCH_HEADING = 'When You Touch';

/** The root block's size the review keeps it under; past it, detail belongs in a guide. */
export const ROOT_LINE_BUDGET = 60;

/**
 * The topic guides, in the order the table lists them, and which of the block's sections
 * each one takes. Shared by generation and by `briefing migrate`, so a migrated block and a
 * generated one put the same section in the same guide.
 */
export const TOPICS = [
  {
    name: 'conventions',
    title: 'Conventions',
    when: 'write or change code',
    sections: ['Code Conventions', 'Stack Rules', 'Boundaries', 'Source Map', 'Feature To Folder Map', 'Generated and Vendored Files', 'Ignored Paths That Bite'],
  },
  {
    name: 'workflow',
    title: 'Workflow',
    when: 'start editing, commit, or open a pull request',
    sections: ['Scope', 'Commit Standard', 'Merge Request Checklist', 'Deploy and CI'],
  },
  {
    name: 'decisions',
    title: 'Decisions',
    when: 'propose an approach, or before asking the person a question',
    sections: ['Decisions'],
  },
];

/** Sections that stay in the root block when `briefing migrate` splits an older one. */
export const ROOT_SECTIONS = [
  'Read First',
  'Which Document Wins',
  'When This Block Is Wrong',
  'Rules That Are Easy To Get Wrong',
  TOUCH_HEADING,
  'Project Structure',
  'Secrets',
  'Validation',
  'When Done',
];

export const guideRel = (name) => `${GUIDES_DIR}/${name}.md`;

/** A file name for an area's guide that no topic guide has. */
export function areaGuideName(area) {
  const base = String(area).replace(/\/+$/, '').replace(/^\.+/, '').replace(/[^\w.-]+/g, '-') || 'root';
  return TOPICS.some((topic) => topic.name === base) ? `${base}-area` : base;
}

const GUIDE_MARK = '<!-- naso:guide -->';
const DIGEST_LINE = /^<!--\s*digest:\s*([0-9a-f]+|__DIGEST__)\s*-->$/m;

/**
 * A fingerprint of a guide as NASO wrote it. Its own digest line, line-end spaces, and the
 * line saying where the decisions list is (which `decisions sync` rewrites) are left out:
 * none of them is a person's edit.
 */
export function guideDigest(text) {
  const normal = String(text)
    .split('\n')
    .filter((line) => !DIGEST_LINE.test(line.trim()))
    .filter((line) => !line.startsWith(DECISIONS_LEAD))
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  return createHash('sha256').update(normal).digest('hex').slice(0, 16);
}

/** Whether a guide was changed after NASO wrote it. One without a digest cannot prove it was not. */
export function guideEdited(text) {
  const stamped = String(text).match(DIGEST_LINE)?.[1];
  return !stamped || stamped !== guideDigest(text);
}

/**
 * One guide's text: a marker, a digest, a title, one line on when to read it, and the
 * sections it took from the block, each under its own `##` heading as it was there.
 */
export function renderGuide({ project, title, when, sections, edited = false }) {
  // A guide made from text people edited carries no digest, so nothing regenerates over it.
  const body = [
    GUIDE_MARK,
    ...(edited ? [] : ['<!-- digest: __DIGEST__ -->']),
    `# ${project} — ${title}`,
    '',
    `Read this when you ${when}. The NASO block in \`AGENTS.md\` links it, and \`npx naso-dev briefing\` checks it with the block. Edit it like the block: say which file proves a correction.`,
    '',
    sections.map((text) => text.trim()).join('\n\n'),
    '',
  ].join('\n');
  return body.replace('__DIGEST__', guideDigest(body));
}

/**
 * The guide paths a block links, in the order it links them. Only a plain file name directly
 * in the guides folder counts, so a block cannot send the checker outside it.
 */
export function linkedGuides(block) {
  const out = [];
  const pattern = new RegExp(`\`(${GUIDES_DIR.replace(/\./g, '\\.')}/[\\w-][\\w.-]*\\.md)\``, 'g');
  for (const match of String(block).matchAll(pattern)) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

/** The text of every guide a block links; null for one that is not on disk. */
export async function readLinkedGuides(cwd, block) {
  const out = [];
  for (const rel of linkedGuides(block)) {
    out.push({ rel, text: await readFile(path.join(cwd, rel), 'utf8').catch(() => null) });
  }
  return out;
}

/**
 * What writing these guides would do to each file: new, replace, unchanged, or kept because
 * people edited it. The setup plan and the write both use it, so the preview is the write.
 */
export async function planGuides(cwd, guides, { discardEdits = false } = {}) {
  const out = [];
  for (const guide of guides) {
    const before = await readFile(path.join(cwd, guide.rel), 'utf8').catch(() => null);
    let change = 'new';
    if (before !== null) {
      if (before === guide.text) change = 'unchanged';
      else if (guideEdited(before) && !discardEdits) change = 'kept';
      else change = 'replace';
    }
    out.push({ ...guide, before, change });
  }
  return out;
}

/** Write the guides the plan says to write. A guide people edited is saved under .naso/backups/ before --discard-edits replaces it. */
export async function writeGuides(cwd, guides, { discardEdits = false } = {}) {
  const planned = await planGuides(cwd, guides, { discardEdits });
  for (const guide of planned) {
    if (guide.change !== 'new' && guide.change !== 'replace') continue;
    if (guide.change === 'replace' && guideEdited(guide.before)) {
      const backup = path.join(cwd, '.naso', 'backups', `${path.basename(guide.rel, '.md')}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
      await mkdir(path.dirname(backup), { recursive: true });
      await writeFile(backup, guide.before, 'utf8');
    }
    await mkdir(path.dirname(path.join(cwd, guide.rel)), { recursive: true });
    await writeFile(path.join(cwd, guide.rel), guide.text, 'utf8');
  }
  return planned;
}

/** The `## ` sections of a block, in order, each with its heading and its full text. */
export function splitSections(block) {
  const lines = String(block).split('\n');
  const head = [];
  const sections = [];
  let current = null;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { heading: heading[1], lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      head.push(line);
    }
  }
  return {
    head: head.join('\n'),
    sections: sections.map((entry) => ({ heading: entry.heading, text: entry.lines.join('\n').replace(/\s+$/, '') })),
  };
}

/** The table that routes each kind of task to its guide. */
export function renderTouchTable(rows) {
  if (rows.length === 0) return null;
  return [
    `## ${TOUCH_HEADING}`,
    '',
    '| When you | Read first |',
    '| --- | --- |',
    ...rows.map((row) => `| ${row.when} | \`${row.rel}\` |`),
  ].join('\n');
}

/** The area a section is about, when it says "under `dir/`" and that folder is an area. */
export function sectionArea(text, areas) {
  const dir = String(text).match(/\bunder `([^`]+?)\/?`/)?.[1];
  if (!dir) return null;
  const top = dir.split('/')[0];
  return areas.includes(top) ? top : null;
}

/** NASO's own Read First lines from 1.6.0 that name sections a layered block no longer has. */
export const READ_FIRST_1_6 = [
  ['2. This briefing.', `2. This block, then the guide ${TOUCH_HEADING} names for the work you are about to do.`],
  ['3. The decisions that apply to the paths you will change (Decisions, below).', `3. The decisions that apply to the paths you will change: \`${guideRel('decisions')}\` says where they are kept.`],
];

/**
 * Split an older block into a root block and guides. Sections move word for word: the
 * heading, every line under it and its sub-sections. A section whose heading NASO does not
 * know stays in the root, and is listed so a person can move it.
 *
 * `inner` is the text between the markers. Returns null when the block already has guides.
 */
export function migrateBlock(inner, { project, areas, edited }) {
  if (new RegExp(`^##\\s+${TOUCH_HEADING}\\s*$`, 'm').test(inner) || linkedGuides(inner).length > 0) return null;
  const { head, sections } = splitSections(inner);
  const topics = new Map(TOPICS.map((topic) => [topic.name, []]));
  const areaGuides = new Map();
  const root = [];
  const kept = [];
  for (const entry of sections) {
    const topic = TOPICS.find((candidate) => candidate.sections.includes(entry.heading));
    if (!topic) {
      root.push(entry);
      if (!ROOT_SECTIONS.includes(entry.heading)) kept.push(entry.heading);
      continue;
    }
    const area = ['Source Map', 'Feature To Folder Map'].includes(entry.heading) ? sectionArea(entry.text, areas) : null;
    if (area) {
      if (!areaGuides.has(area)) areaGuides.set(area, []);
      areaGuides.get(area).push(entry.text);
    } else {
      topics.get(topic.name).push(entry.text);
    }
  }

  const guides = [];
  const rows = [];
  for (const topic of TOPICS) {
    const moved = topics.get(topic.name);
    if (moved.length === 0) continue;
    guides.push({ name: topic.name, rel: guideRel(topic.name), headings: moved.map((text) => text.split('\n')[0].replace(/^##\s+/, '')), text: renderGuide({ project, title: topic.title, when: topic.when, sections: moved, edited }) });
    rows.push({ when: topic.when, rel: guideRel(topic.name) });
  }
  for (const [area, moved] of areaGuides) {
    const name = areaGuideName(area);
    guides.push({ name, rel: guideRel(name), headings: moved.map((text) => text.split('\n')[0].replace(/^##\s+/, '')), text: renderGuide({ project, title: `${area}/`, when: `change files under ${area}/`, sections: moved, edited }) });
    rows.push({ when: `change files under \`${area}/\``, rel: guideRel(name) });
  }
  if (guides.length === 0) return null;

  // The table goes before Project Structure when there is one, else after the last section
  // that opens a block (Read First, the correction sections, the rules).
  const texts = root.map((entry) => entry.text);
  const table = renderTouchTable(rows);
  const before = root.findIndex((entry) => entry.heading === 'Project Structure');
  if (before === -1) texts.push(table);
  else texts.splice(before, 0, table);

  let text = `${head.replace(/\s+$/, '')}\n\n${texts.join('\n\n')}\n\n`;
  for (const [old, next] of READ_FIRST_1_6) text = text.split(`\n${old}\n`).join(`\n${next}\n`);
  return { root: text, guides, kept };
}
