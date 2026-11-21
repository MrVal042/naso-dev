// NASO traps — the rules an agent gets wrong, each with its reason and its source.
//
// In the field the most-used part of a briefing was a short list of traps, one line each,
// each saying why. Agents follow a rule they understand and argue with one they do not.
// Every line here comes from a file the repository already has: an accepted decision, a
// committed env template, CODEOWNERS, the commit linter and what enforces it, and the
// contributing guide's own words, quoted with the line they are on so the checker can test
// them. A repository with none of these gets no section.
//
// Reads a handful of files and runs nothing, so the gate can call it on every commit.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { documentedBranchPattern } from './lib.mjs';
import { readDecisions } from './decisions.mjs';
import { readMergeRules, quotable } from './toolchain.mjs';
import { CODEOWNERS_FILES } from './repo-rules.mjs';

export const TRAPS_HEADING = 'Rules That Are Easy To Get Wrong';

const MAX_TRAPS = 10;
const MAX_DECISIONS = 4;
const MAX_OWNER_PATTERNS = 5;

/** Env files committed on purpose as templates. The gate lets these through; people put real values in them. */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);

const COMMITLINT_CONFIGS = [
  'commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts', 'commitlint.config.cts', 'commitlint.config.mts',
  '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yaml', '.commitlintrc.yml', '.commitlintrc.js', '.commitlintrc.cjs', '.commitlintrc.mjs', '.commitlintrc.ts',
];

/** "One ticket per pull request" and its spellings: a rule CONTRIBUTING states in one line. */
const ONE_PER = /\bone\s+(?:ticket|issue|story|task|change|feature|jira(?:\s+ticket)?)\b.{0,30}\bper\b.{0,12}\b(?:pr|pull request|merge request|mr|branch)\b/i;

const CONTRIBUTING = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];

async function read(cwd, rel) {
  return readFile(path.join(cwd, rel), 'utf8').catch(() => null);
}

const sentence = (text) => {
  const trimmed = String(text).trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * The first sentence. The record holds the rest, and it is cited: a trap is one line, and a
 * decision's second sentence is usually the detail an agent reads only when it applies.
 */
function firstSentence(text, max = 180) {
  const one = String(text).trim().split(/(?<=[.!?])\s+(?=[A-Z`(])/)[0];
  if (one.length <= max) return sentence(one);
  // Cut at a word, never inside a code span, so a path is never half a path.
  let cut = one.slice(0, max).replace(/\s+\S*$/, '');
  if ((cut.match(/`/g) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('`')).trimEnd();
  return `${cut.replace(/[\s,;:]+$/, '')}…`;
}

/**
 * Accepted decisions as rules, with the reason the record gives. Those that say which paths
 * they apply to come first: they constrain the code an agent is about to change, where a
 * decision about pricing or process may never touch its work. Then newest first.
 */
async function decisionTraps(cwd) {
  const { records } = await readDecisions(cwd).catch(() => ({ records: [] }));
  return records
    .filter((record) => record.status === 'accepted' && record.decision)
    .sort((a, b) => Number(b.applies.length > 0) - Number(a.applies.length > 0) || b.id.localeCompare(a.id))
    .slice(0, MAX_DECISIONS)
    .map((record) => {
      const why = record.why ? `Why: ${firstSentence(record.why, 150)}` : record.source ? `Decided in ${sentence(record.source)}` : '';
      return `${firstSentence(record.decision)} ${why} (\`${record.file}\`)`.replace(/\s+\(/, ' (');
    });
}

function envTrap(files) {
  const templates = files.filter((file) => ENV_TEMPLATES.has(path.posix.basename(file).toLowerCase())).slice(0, 3);
  if (templates.length === 0) return [];
  const names = templates.map((file) => `\`${file}\``).join(', ');
  return [
    `${names} ${templates.length === 1 ? 'is' : 'are'} committed: put placeholder values in ${templates.length === 1 ? 'it' : 'them'}, never real ones, because every clone and fork gets what ${templates.length === 1 ? 'it holds' : 'they hold'}.`,
  ];
}

/**
 * CODEOWNERS patterns other than the catch-all, with owners and line numbers. GitLab's
 * `[Section]` and `^[Optional]` headers are not patterns; a section's default owners apply
 * to its lines that name none. Patterns are written bare: they are globs, not paths.
 */
async function ownersTrap(cwd, files) {
  const file = CODEOWNERS_FILES.find((name) => files.includes(name));
  if (!file) return [];
  const text = (await read(cwd, file)) ?? '';
  const entries = [];
  let fallback = null;
  let sectionOwners = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const section = /^\^?\[[^\]]+\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (section) {
      sectionOwners = section[1].split(/\s+/).filter(Boolean);
      return;
    }
    const [pattern, ...named] = line.split(/\s+/);
    const owners = named.length > 0 ? named : sectionOwners;
    if (owners.length === 0) return;
    if (['*', '/*', '**', '/**'].includes(pattern)) fallback = owners;
    else entries.push({ pattern, owners, line: index + 1 });
  });
  if (entries.length === 0) return [];
  // Patterns that share owners are named once, under one owner list: "src/, docs/ (@a, @b,
  // lines 4-5)" says what "src/ (@a, @b, line 4), docs/ (@a, @b, line 5)" said, in less.
  const groups = [];
  for (const entry of entries.slice(0, MAX_OWNER_PATTERNS)) {
    const key = entry.owners.join(' ');
    const group = groups.find((candidate) => candidate.key === key);
    if (group) group.items.push(entry);
    else groups.push({ key, owners: entry.owners, items: [entry] });
  }
  const linesText = (lines) => {
    if (lines.length === 1) return `line ${lines[0]}`;
    const contiguous = lines.every((line, i) => i === 0 || line === lines[i - 1] + 1);
    return contiguous ? `lines ${lines[0]}-${lines.at(-1)}` : `lines ${lines.join(', ')}`;
  };
  const shown = groups.map((group) => `${group.items.map((item) => item.pattern).join(', ')} (${group.owners.join(', ')}, ${linesText(group.items.map((item) => item.line))})`);
  const more = entries.length > MAX_OWNER_PATTERNS ? ` and ${entries.length - MAX_OWNER_PATTERNS} more` : '';
  // A plain path that matches nothing tracked is a rule about a folder that is not there
  // yet, or a typo; either way an agent should not read it as protecting anything.
  const unmatched = entries
    .map((entry) => entry.pattern)
    .filter((pattern) => !/[*?[]/.test(pattern))
    .filter((pattern) => {
      const prefix = pattern.replace(/^\//, '').replace(/\/$/, '');
      return !files.some((tracked) => tracked === prefix || tracked.startsWith(`${prefix}/`) || (!pattern.startsWith('/') && tracked.endsWith(`/${prefix}`)));
    })
    .slice(0, 3);
  return [
    `Changes under ${shown.join(', ')}${more} need their owners (\`${file}\`): a pull request touching them waits for their review, so keep such changes in their own pull request.` +
      (fallback ? ` Everything else: ${fallback.join(', ')}.` : '') +
      (unmatched.length > 0 ? ` ${unmatched.join(', ')} ${unmatched.length === 1 ? 'matches' : 'match'} no tracked file yet.` : ''),
  ];
}

/** commitlint, and what makes it bite: a commit-msg hook, or CI. */
async function commitlintTrap(cwd, files, pkg) {
  const config = COMMITLINT_CONFIGS.find((name) => files.includes(name)) ?? (pkg?.commitlint ? 'package.json' : null);
  if (!config) return [];
  const hook = ['.husky/commit-msg', '.lefthook.yml', 'lefthook.yml', '.pre-commit-config.yaml'].find((name) => files.includes(name));
  const hookText = hook ? (await read(cwd, hook)) ?? '' : '';
  if (hook && /commitlint/.test(hookText)) {
    return [`Commit subjects must pass commitlint (\`${config}\`): the commit-msg hook (\`${hook}\`) rejects any other.`];
  }
  const workflows = files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || file === '.gitlab-ci.yml');
  for (const workflow of workflows) {
    if (/commitlint/.test((await read(cwd, workflow)) ?? '')) {
      return [`Commit subjects must pass commitlint (\`${config}\`): CI runs it (\`${workflow}\`) and fails on any other.`];
    }
  }
  return [`Commit subjects follow commitlint (\`${config}\`); nothing here runs it, so check a subject against it yourself.`];
}

async function branchTrap(cwd) {
  const pattern = await documentedBranchPattern(cwd);
  if (!pattern) return [];
  const lines = ((await read(cwd, pattern.source)) ?? '').split('\n');
  const at = lines.findIndex((line) => line.includes(pattern.text));
  const where = at === -1 ? `\`${pattern.source}\`` : `\`${pattern.source}\` line ${at + 1}`;
  return [`Name branches \`${pattern.text}\` (${where}); NASO's pre-commit hook warns on any other.`];
}

/** CONTRIBUTING's own words: one ticket per pull request, the merge mode, who may approve, exceptions. */
async function contributingTraps(cwd, files) {
  const out = [];
  const file = CONTRIBUTING.find((name) => files.includes(name));
  if (file) {
    let fenced = false;
    ((await read(cwd, file)) ?? '').split('\n').forEach((raw, index) => {
      if (/^\s*```/.test(raw)) fenced = !fenced;
      if (fenced || /^\s*#/.test(raw) || !ONE_PER.test(raw)) return;
      const text = quotable(raw);
      if (text.length >= 12 && text.length <= 300) out.push({ file, line: index + 1, text });
    });
  }
  for (const rule of await readMergeRules(cwd, files)) {
    if (!out.some((entry) => entry.file === rule.file && entry.line === rule.line)) out.push(rule);
  }
  return out
    .sort((a, b) => a.line - b.line)
    .map((rule) => `\`${rule.file}\` line ${rule.line}: “${rule.text}” Why: it is the team's own rule, and review holds pull requests to it.`);
}

/**
 * The rules, in priority order, at most ten: accepted decisions (at most four), committed
 * env templates, CODEOWNERS, commitlint, the branch pattern, then the contributing guide's
 * own lines in whatever room is left. Each is one line, without its list marker.
 */
export async function deriveTraps(cwd, files, { pkg = null } = {}) {
  const fixed = [
    ...(await decisionTraps(cwd)),
    ...envTrap(files),
    ...(await ownersTrap(cwd, files)),
    ...(await commitlintTrap(cwd, files, pkg)),
    ...(await branchTrap(cwd)),
  ].slice(0, MAX_TRAPS);
  const room = MAX_TRAPS - fixed.length;
  return [...fixed, ...(room > 0 ? (await contributingTraps(cwd, files)).slice(0, room) : [])];
}

/** The section, or null when there is nothing to say. */
export function renderTraps(traps) {
  if (!traps || traps.length === 0) return null;
  return `## ${TRAPS_HEADING}\n\n${traps.map((trap) => `- ${trap}`).join('\n')}`;
}
