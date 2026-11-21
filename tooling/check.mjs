// NASO check — does the NASO block in AGENTS.md still match the repository? Every path it
// claims must exist, every real area must be named, and no placeholder may remain.
//
// Zero external dependencies — Node.js core modules only.

import {
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  run,
  coversUnit,
  escapeRegExp,
  section,
  nasoCommand,
  toolVersion,
  compareVersions,
  recordedNasoVersion,
  pinsExactVersions,
  detectPackageManager,
  exactDevInstallText,
  pinAdvice,
  COMMAND_SINCE,
} from './lib.mjs';
import { DECISIONS_LEAD, decisionsLead, readDecisions } from './decisions.mjs';
import {
  AGENTS_FILE,
  NASO_END,
  NASO_START,
  areasOf,
  declaredModuleSystem,
  listRepoFiles,
  runtimeEntry,
  topLevelEntries,
} from './scan.mjs';
import { deriveTraps, TRAPS_HEADING } from './traps.mjs';
import { GUIDES_DIR, ROOT_LINE_BUDGET, TOPICS, TOUCH_HEADING, readLinkedGuides, splitSections } from './guides.mjs';

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

// NASO's own tools are named in a briefing as commands, not as repo paths, so
// flagging them as MISSING would be noise.
const TOOL_SCRIPT_NAMES =
  /^(briefing|scan|render|check|guide|validate|doctor|init|setup|lib|lock|install|naso)\.mjs$/i;

/**
 * A path-shaped token: no globs, no angle brackets, no spaces.
 *
 * A briefing legitimately contains `git status`, `--no-verify` and
 * `type(scope): summary` in prose. Only path-shaped tokens are candidates for a
 * filesystem check; everything else is a false positive waiting to happen.
 */
const PATH_SHAPED_TOKEN = /^[\w.@~()[\]-]+(?:\/[\w.@~()[\]-]+)*\/?$/;

/**
 * A token that names a file or folder rather than a word: it has a slash, a `name.ext`
 * shape, a dotfile name longer than an extension, or is one of the extensionless files
 * every repository knows. `lint`, `formatMoney`, `X-App-Version` and `.svg` are words;
 * checking them as paths reported 29 false MISSING items in one corrected briefing and
 * taught its authors to drop the backticks from code. `(tabs)` and `[id]` are route
 * segments in Expo and Next.js, so they are allowed inside a path.
 */
const NAMES_A_PATH = /\/|^[^.].*\.[A-Za-z][A-Za-z0-9]*$|^\.[\w.-]{5,}$/;
const EXTENSIONLESS_FILES = /^(?:Makefile|Dockerfile|Containerfile|LICEN[CS]E|NOTICE|CODEOWNERS|Gemfile|Procfile|Jenkinsfile|Rakefile|Brewfile|Vagrantfile|VERSION)$/;

const MARKERS = ['TODO(fill)', 'TODO(describe)'];

export { COMMAND_SINCE } from './lib.mjs';

/** A version written as a template, `vX.Y.Z` or `x.y`: a placeholder, so never a path on disk. */
const VERSION_TEMPLATE = /(?:^|[/.-])v?[Xx]\.[Yy](?:\.[Zz])?(?:$|[/.-])/;

/**
 * Prefixes branch names start with. A token like `feat/SCRUM-12-login` that is not on disk
 * under one of these is an example branch name, not a missing path; a real `fix/` folder is
 * still checked, because then the token exists or its first segment does.
 */
const BRANCH_PREFIXES = new Set(['feat', 'feature', 'fix', 'bugfix', 'hotfix', 'chore', 'release', 'refactor', 'perf', 'revert']);

/**
 * Remove fenced code blocks before hunting for path claims.
 *
 * Splitting on a single backtick misaligns the moment the document contains a
 * fence — an odd run of backticks means every span after it is read as the text
 * *between* two code spans, and prose gets tested as a filename. Stripping the
 * fences first removes the ambiguity, and it is also the correct scope: a path
 * inside a shell snippet is a command to run, not a claim about the repository.
 */
export function stripFencedBlocks(text) {
  return String(text).replace(/^```[\s\S]*?^```[ \t]*$/gm, '');
}

/**
 * Path tokens the briefing claims, from backticked spans only.
 *
 * Odd-index segments after splitting on ` are the inside of a code span; pairing
 * by regex instead would break on any stray backtick (see stripFencedBlocks).
 */
export function extractPathTokens(text) {
  const segments = stripFencedBlocks(text).split('`');
  const tokens = new Set();

  for (let i = 1; i < segments.length; i += 2) {
    const token = segments[i].trim();
    if (!token) continue;
    if (token.includes('*') || token.includes('<') || token.includes('>')) continue;
    if (token.includes(' ')) continue;
    if (token.startsWith('-')) continue;
    // `@/`, `~/` and `#/` are import-alias prefixes, not folders: a briefing that explains
    // where `@/` points was reported as missing the path "@/".
    if (/^[@~#]\//.test(token)) continue;
    if (TOOL_SCRIPT_NAMES.test(token)) continue;
    // `hotfix/vX.Y.Z` and `release/x.y` name a branch or a version template, not a file.
    if (VERSION_TEMPLATE.test(token)) continue;
    if (!PATH_SHAPED_TOKEN.test(token)) continue;
    if (!NAMES_A_PATH.test(token) && !EXTENSIONLESS_FILES.test(token)) continue;
    tokens.add(token);
  }
  return Array.from(tokens).sort();
}

/**
 * The repository's areas, by name, as git currently sees them.
 *
 * Directories only, `-z` only, exclusions and deletions applied — same rules as
 * `listRepoFiles`, because "the areas" has to mean one thing across the generator, the
 * checker, the guide and the pre-commit append.
 */
export async function listTopLevelEntries(cwd, { exclude = null } = {}) {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inside.ok) return null;

  const files = await listRepoFiles(cwd, { exclude });
  return areasOf(topLevelEntries(files)).map((entry) => `${entry.name}/`);
}

/** Which entries the briefing fails to cover. */
export function findUncovered(entries, briefingText) {
  return (entries ?? []).filter((entry) => !coversUnit(briefingText, entry));
}

/**
 * Claims in the block that the repository contradicts. A path can exist and the sentence
 * about it still be false: `src/app.ts` is real, and it is not what starts the service.
 *
 * Two claims are tested, each against the file that settles it: the entry point against
 * nest-cli.json, a Dockerfile CMD or the start script, and the "Modules:" line against
 * package.json "type" and tsconfig "module". Commit counts are not: they change with every
 * commit, and a check that fails on the next commit teaches people to ignore it.
 */
export async function wrongClaims(cwd, claimed) {
  const out = [];
  const files = await listRepoFiles(cwd).catch(() => []);
  let pkg = null;
  try {
    pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    // No manifest, or one that does not parse: no start script to test against.
  }
  const started = await runtimeEntry(cwd, files ?? [], pkg);
  if (started) {
    const said = [...claimed.matchAll(/\bentry(?: point)?(?: is)? `([^`]+)`/gi)].map((match) => match[1]);
    const area = started.file.split('/')[0];
    for (const file of new Set(said)) {
      if (file !== started.file && file.split('/')[0] === area) {
        out.push(`entry \`${file}\`: ${started.source} starts \`${started.file}\``);
      }
    }
  }
  const modules = await declaredModuleSystem(cwd);
  const line = claimed.match(/^Modules:\s*(.+)$/m)?.[1];
  if (modules && line) {
    const saysEsm = /^ES modules/i.test(line);
    const saysCjs = /^CommonJS/i.test(line);
    if ((modules.kind === 'CommonJS' && saysEsm) || (modules.kind === 'ES modules' && saysCjs)) {
      out.push(`Modules: says ${saysEsm ? 'ES modules' : 'CommonJS'}, but ${modules.why}, so it is ${modules.kind}`);
    }
  }
  // The line saying where the decisions list is goes stale with the first `decide`; the
  // commands rewrite it, but a record added by hand or on another branch leaves it behind.
  const lead = claimed.split('\n').find((line) => line.startsWith(DECISIONS_LEAD)) ?? null;
  if (lead !== null) {
    const expected = decisionsLead(await readDecisions(cwd));
    if (!lead.startsWith(expected)) out.push(`Decisions: the line saying where the list is is out of date. Run: ${nasoCommand()} decisions sync`);
  }
  out.push(...(await staleDecisionCounts(cwd, claimed)), ...(await citationsPastTheEnd(cwd, claimed)), ...(await misquotedCitations(cwd, claimed)));
  return out;
}

/**
 * A count of decisions written into the Decisions section that the list no longer bears out.
 * Reviewers write "All 6 there are proposed"; the next `decide` makes it false, and nothing
 * else would notice.
 */
async function staleDecisionCounts(cwd, claimed) {
  const at = claimed.indexOf('## Decisions');
  if (at === -1) return [];
  const section = claimed.slice(at, claimed.indexOf('\n## ', at + 1) === -1 ? undefined : claimed.indexOf('\n## ', at + 1));
  const { records } = await readDecisions(cwd);
  const out = [];
  for (const match of section.matchAll(/\b[Aa]ll (\d+)\b|\b(\d+) (?:decisions|records|decision records)\b/g)) {
    const said = Number(match[1] ?? match[2]);
    if (said !== records.length) {
      out.push(`Decisions: says "${match[0]}", and the list has ${records.length}. Point to the list instead of counting it.`);
    }
  }
  return out;
}

/**
 * Line citations past the end of the file they cite: `CONTRIBUTING.md` line 40 in a file
 * of 20 lines. A citation inside the file may still point at the wrong sentence, but one
 * past its end is certainly wrong, and it is the first thing a moved or rewritten file breaks.
 */
async function citationsPastTheEnd(cwd, claimed) {
  const out = [];
  const pattern = /`([^`\s]+)`[^`\n]{0,15}?\blines? (\d+)((?:\s*[–-]\s*\d+)?(?:(?:,\s*|,? and\s+)\d+(?:\s*[–-]\s*\d+)?)*)/g;
  const lengths = new Map();
  for (const match of stripFencedBlocks(claimed).matchAll(pattern)) {
    const file = match[1];
    const highest = Math.max(...`${match[2]}${match[3]}`.match(/\d+/g).map(Number));
    if (!lengths.has(file)) {
      const text = await readFile(path.join(cwd, file), 'utf8').catch(() => null);
      lengths.set(file, text === null ? null : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    }
    const length = lengths.get(file);
    if (length !== null && highest > length) out.push(`\`${file}\` line ${highest}: the file has ${length} lines`);
  }
  return [...new Set(out)];
}

/** Text as a quote compares it: no Markdown emphasis, code or link syntax, one space, straight apostrophes. */
const quoteText = (text) =>
  String(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`|\*\*|__/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Curly-quoted text next to a line citation that the cited lines do not contain.
 *
 * A citation inside the file passes the length check and can still point at the wrong
 * sentence, and a quote can be misquoted; both read as evidence. Each “…” is paired with the
 * nearest `file` line(s) N[–M] on the same line of the block and looked for in those lines,
 * list and quote markers removed and whitespace normalised. An ellipsis in a quote stands for
 * text left out, so the parts around it are looked for in order.
 */
async function misquotedCitations(cwd, claimed) {
  const out = [];
  const files = new Map();
  const citation = /`([^`\s]+)`[^`\n“”]{0,15}?\blines? (\d+)(?:\s*[–-]\s*(\d+))?/g;
  for (const line of stripFencedBlocks(claimed).split('\n')) {
    const cites = [...line.matchAll(citation)];
    if (cites.length === 0) continue;
    for (const quote of line.matchAll(/“([^”]+)”/g)) {
      // Nearest by the text between them, not by where each starts: measured from the start,
      // a citation that closes the previous sentence beat the one right after the quote.
      // On a tie the citation after the quote wins, as in “…” (`file` line N).
      const end = quote.index + quote[0].length;
      const gap = (cite) => (cite.index >= end ? cite.index - end : Math.max(0, quote.index - (cite.index + cite[0].length)) + 0.5);
      const near = cites.reduce((best, cite) => (gap(cite) < gap(best) ? cite : best));
      const [, file, first, last = first] = near;
      if (!files.has(file)) files.set(file, await readFile(path.join(cwd, file), 'utf8').catch(() => null));
      const text = files.get(file);
      if (text === null) continue;
      const [a, b] = [Number(first), Number(last)].sort((x, y) => x - y);
      const lines = text.split('\n');
      if (b > lines.length) continue;
      const cited = quoteText(lines.slice(a - 1, b).map((raw) => raw.replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/, '')).join(' '));
      const parts = quote[1].split(/…|\.\.\./).map(quoteText).filter(Boolean);
      let from = 0;
      const found = parts.every((part) => {
        const at = cited.indexOf(part.replace(/[.,;:]$/, ''), from);
        from = at + part.length;
        return at !== -1;
      });
      if (found) continue;
      const words = quoteText(quote[1].replace(/…|\.\.\./g, ' ')).split(' ');
      let k = 0;
      while (k < words.length && cited.includes(words.slice(0, k + 1).join(' '))) k++;
      const where = a === b ? `line ${a}: the quote is not in that line` : `lines ${a}–${b}: the quote is not in those lines`;
      const word = quote[1].replace(/…|\.\.\./g, ' ').trim().split(/\s+/)[k] ?? words[k] ?? '';
      out.push(`\`${file}\` ${where}; first differing word: "${word.replace(/^[“"'(]+|[”"'),.;:!?]+$/g, '')}"`);
    }
  }
  return [...new Set(out)];
}

/**
 * Which NASO wrote the block, which one the hook runs, and which one is running now.
 *
 * Notes, not problems: a version gap is fixed by `refresh` or an upgrade, not by editing the
 * block, and a check that failed on it would block every commit after a teammate upgraded.
 */
export async function versionNotes(cwd, claimed) {
  const stamped = claimed.match(/^<!--\s*version:\s*([^\s]+)\s*-->$/m)?.[1] ?? null;
  const vendored = (await readFile(path.join(cwd, '.naso', 'tooling', 'VERSION'), 'utf8').catch(() => '')).trim() || null;
  const running = await toolVersion();
  const notes = [];
  // package.json and the lockfile are what teammates install; the vendored copy is what the
  // hook runs. Two versions there and `refresh` from node_modules would move the toolset back.
  const recorded = await recordedNasoVersion(cwd);
  const pm = recorded ? (await detectPackageManager(cwd, recorded.pkg)).name : null;
  const pinGap = pinAdvice({ recorded, vendored, pm });
  // With a pin that disagrees with the toolset, the pin note says which way to go; a second
  // note about the running command would point the other way.
  if (vendored && vendored !== running && !pinGap) {
    const pinned = recorded ? (recorded.installed ?? recorded.spec.replace(/^[\^~=v]+/, '')) : null;
    notes.push(
      `.naso/tooling/ is ${vendored} and this command is ${running}. ` +
        (pinned === vendored
          ? `package.json pins ${vendored}: run \`${nasoCommand({ version: vendored })}\` here${compareVersions(running, vendored) > 0 ? `, or move the team to ${running} with \`${nasoCommand({ version: running })} refresh\` and \`${exactDevInstallText(pm, running)}\`` : ''}.`
          : compareVersions(running, vendored) > 0
            ? `\`${nasoCommand({ version: running })} refresh\` brings the toolset up to ${running}.`
            : `Run \`${nasoCommand({ version: vendored })}\` here; a refresh from ${running} would move the toolset back.`),
    );
  }
  if (stamped && vendored && stamped !== vendored) {
    notes.push(
      compareVersions(stamped, vendored) < 0
        ? `The block is stamped ${stamped} and .naso/tooling/ is ${vendored}. \`${nasoCommand()} briefing refresh\` moves the stamp and nothing else.`
        : `The block is stamped ${stamped}, newer than .naso/tooling/ (${vendored}). \`${nasoCommand({ version: stamped })} refresh\` updates the toolset.`,
    );
  }
  // `npx naso-dev handoff` in the block runs the pinned install, and 1.5.3 answers it with
  // "unknown command". Said against the pin, because that is what teammates run.
  if (recorded) {
    const pinned = recorded.installed ?? recorded.spec.replace(/^[\^~=v]+/, '');
    const absent = Object.entries(COMMAND_SINCE)
      .filter(([, since]) => /^\d+\.\d+\.\d+/.test(pinned) && compareVersions(pinned, since) < 0)
      .map(([name]) => name)
      .filter((name) => new RegExp(`naso-dev(?:@\\S+)?\\s+${name}\\b`).test(claimed));
    if (absent.length > 0) {
      const newest = absent.map((name) => COMMAND_SINCE[name]).sort(compareVersions).at(-1);
      notes.push(
        `The block runs ${absent.map((name) => `\`${name}\``).join(', ')}, which package.json's naso-dev ${pinned} does not have (added in ${newest}). ` +
          `\`${exactDevInstallText(pm, vendored && compareVersions(vendored, newest) >= 0 ? vendored : running)}\` pins one that does.`,
      );
    }
  }
  if (pinGap) {
    notes.push(pinGap);
  } else if (recorded && vendored && /^[\^~]/.test(recorded.spec) && (await pinsExactVersions(cwd, recorded.pkg))) {
    notes.push(`package.json records naso-dev as ${recorded.spec}, and this repository pins exact versions. \`${exactDevInstallText(pm, vendored)}\` pins it.`);
  }
  return notes;
}

/**
 * Linked guides git ignores while AGENTS.md is not ignored: the block will be committed and
 * the guide never will. `migrate` moved sections into .naso/guides/ in a repository that
 * commits AGENTS.md and excludes .naso/, and the check passed.
 */
export async function localOnlyGuides(cwd, rels) {
  if (rels.length === 0) return [];
  if ((await ignoredPaths(cwd, [AGENTS_FILE])).length > 0) return [];
  return ignoredPaths(cwd, rels);
}

/** The paths among these that .gitignore covers, whether or not they exist yet. */
async function ignoredPaths(cwd, paths) {
  if (paths.length === 0) return [];
  const res = await run('git', ['check-ignore', '--', ...paths], { cwd });
  const listed = new Set(res.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  return paths.filter((p) => listed.has(p) || listed.has(p.replace(/\/$/, '')));
}

/**
 * Compare the briefing against the repository.
 *
 * Three failure modes, and the middle one is the reason this exists: the old
 * shell snippet only ever checked paths the briefing claimed. It never checked
 * the areas that exist and were never mentioned, which is where the real gaps
 * are.
 */
/**
 * Sections NASO added to the block after 1.5, with the version that added each.
 *
 * A block people reviewed is never regenerated and refresh never rewrites prose, so without
 * this a block written before a section existed would keep its old shape for good, and
 * nobody would know. A missing one is a notice, never a failure: the block is still true,
 * it is only missing something newer. `review` says what to add and where.
 */
export const SECTIONS_SINCE = [
  {
    heading: 'Read First',
    since: '1.6.0',
    why: 'it tells the agent to read the handoff first and to keep it current',
    place: 'right after the "What this is" line (after the title if there is none)',
  },
  {
    heading: TRAPS_HEADING,
    since: '1.6.0',
    why: 'it states the rules an agent gets wrong, each with its reason and source',
    place: 'right after the "When This Block Is Wrong" section',
    // Only where there is something to say: a repository with no decisions, owners,
    // templates or written rules gets no section, so it is not missing one.
    applies: async (cwd) => {
      const files = await listRepoFiles(cwd).catch(() => []);
      const pkg = await readFile(path.join(cwd, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
      return (await deriveTraps(cwd, files ?? [], { pkg })).length > 0;
    },
  },
];

/**
 * Notices about the block's shape: a block from before 2.0.0 that keeps every section in
 * AGENTS.md, and a root block grown past its budget. Neither is a failure: the block is still
 * true, it only costs every session more than it has to.
 */
export function layoutNotices(block, guides) {
  const out = [];
  const layered = new RegExp(`^##\\s+${escapeRegExp(TOUCH_HEADING)}\\s*$`, 'm').test(block) || guides.length > 0;
  if (!layered) {
    const movable = splitSections(block).sections.filter((entry) => TOPICS.some((topic) => topic.sections.includes(entry.heading)));
    if (movable.length > 0) {
      out.push({
        kind: 'single-file',
        heading: TOUCH_HEADING,
        since: '2.0.0',
        text: `Single-file block from before 2.0.0: ${movable.map((entry) => entry.heading).join(', ')} load in every session. \`${nasoCommand()} briefing migrate\` moves them into guides, word for word.`,
      });
    }
    return out;
  }
  const lines = block.split('\n').filter((line) => line.trim() !== '' && !/^<!--.*-->$/.test(line.trim())).length;
  if (lines > ROOT_LINE_BUDGET) {
    out.push({
      kind: 'over-budget',
      heading: TOUCH_HEADING,
      since: '2.0.0',
      text: `The block is ${lines} lines of text, past the ${ROOT_LINE_BUDGET} every session can afford. Move detail that only one kind of task needs into the guide that ${TOUCH_HEADING} names for it.`,
    });
  }
  return out;
}

/** The SECTIONS_SINCE entries a NASO block lacks and this repository would have. Text outside the markers does not count. */
export async function missingSections(block, cwd) {
  const missing = [];
  for (const section of SECTIONS_SINCE) {
    if (new RegExp(`^##\\s+${escapeRegExp(section.heading)}\\s*$`, 'm').test(block)) continue;
    if (section.applies && !(await section.applies(cwd))) continue;
    missing.push(section);
  }
  return missing;
}

export async function checkBriefing(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    return { ok: false, reason: 'missing', agentsPath, problems: [] };
  }

  const briefing = await readFile(agentsPath, 'utf8');
  // Only the NASO block is NASO's claim. Text around it is the owner's, and a hand-written
  // rule like "scope commits to `web` or `mobile`" names areas, not files — checking it as
  // paths failed a fresh setup on every repository whose own AGENTS.md used backticks.
  const start = briefing.indexOf(NASO_START);
  const end = briefing.indexOf(NASO_END);
  const hasBlock = start !== -1 && end > start;
  const block = hasBlock ? briefing.slice(start, end) : briefing;
  // The guides the block links are part of its claim: every path and quote in them is checked
  // as if it were in the block. A linked guide that is not on disk is MISSING even where .naso/
  // is git-ignored, because the block sends the agent to it.
  const guides = hasBlock ? await readLinkedGuides(cwd, block) : [];
  const claimed = [block, ...guides.filter((guide) => guide.text !== null).map((guide) => guide.text)].join('\n\n');
  const tokens = extractPathTokens(claimed);
  const entries = await listTopLevelEntries(cwd);

  const absent = [];
  for (const token of tokens) {
    if (await pathExists(path.join(cwd, token))) continue;
    const first = token.split('/')[0];
    if (token.includes('/') && BRANCH_PREFIXES.has(first) && !(await pathExists(path.join(cwd, first)))) continue;
    absent.push(token);
  }
  // A git-ignored path is generated, not invented: `src/gen/` is real once the build runs.
  // Reporting it as missing pushed briefing writers to drop true facts.
  const ignored = await ignoredPaths(cwd, absent);
  const lostGuides = guides.filter((guide) => guide.text === null).map((guide) => guide.rel);
  const missing = [...new Set([...absent.filter((token) => !ignored.includes(token)), ...lostGuides])];
  // A committed block that links a guide git never sees sends every other clone to a file
  // that is not there. Where AGENTS.md itself is kept out of git, the guides are too, and
  // that is consistent.
  const localOnly = hasBlock ? await localOnlyGuides(cwd, guides.filter((guide) => guide.text !== null).map((guide) => guide.rel)) : [];

  const uncovered = findUncovered(entries, claimed);
  const wrong = await wrongClaims(cwd, claimed);
  const notes = await versionNotes(cwd, briefing);
  // A single-file block is the right shape where guides could not be committed: migrating
  // would put its rules where no other clone can read them, so it is not suggested.
  const guidesLocal = hasBlock && guides.length === 0 && (await localOnlyGuides(cwd, [`${GUIDES_DIR}/decisions.md`])).length > 0;
  const layout = hasBlock ? layoutNotices(block, guides).filter((notice) => !(guidesLocal && notice.kind === 'single-file')) : [];
  const notices = hasBlock ? [...(await missingSections(block, cwd)), ...layout] : [];
  if (localOnly.length > 0) {
    notices.push({
      kind: 'local-only',
      text: `${AGENTS_FILE} is not ignored, so its block reaches every clone, and git ignores the guides it links: ${localOnly.join(', ')}. On any other clone the block points at files that are not there. Commit them (\`git add -f\`), or keep what a teammate needs in the block.`,
    });
  }

  const markerCounts = MARKERS.map((marker) => ({
    marker,
    count: (claimed.match(new RegExp(escapeRegExp(marker), 'g')) ?? []).length,
  }));
  const unfilled = markerCounts.filter((m) => m.count > 0);

  const problems = [
    ...wrong.map((w) => ({ kind: 'WRONG', item: w })),
    ...missing.map((m) => ({ kind: 'MISSING', item: m })),
    ...uncovered.map((u) => ({ kind: 'UNCOVERED', item: u })),
    ...unfilled.map((m) => ({ kind: 'UNFILLED', item: `${m.marker} x${m.count}` })),
  ];

  return {
    ok: problems.length === 0,
    agentsPath,
    briefing,
    guides,
    tokens,
    entries: entries ?? [],
    ignored,
    wrong,
    missing,
    uncovered,
    localOnly,
    unfilled,
    notes,
    notices,
    problems,
  };
}

/** Print a check result in the same shape for every caller. */
export function printCheck(result) {
  if (result.reason === 'missing') {
    console.error(`naso-dev briefing: no ${AGENTS_FILE} in ${path.dirname(result.agentsPath)}.`);
    console.error(`  Run \`${nasoCommand()} setup\` against this repository first.`);
    return;
  }

  if (result.wrong?.length > 0) {
    section(`WRONG (${result.wrong.length}) — the repository says otherwise`);
    for (const item of result.wrong) console.log(`- ${item}`);
    console.log('');
  }

  if (result.missing.length > 0) {
    section(`MISSING (${result.missing.length}) — claimed by the briefing, not on disk`);
    for (const item of result.missing) console.log(`- ${item}`);
    console.log('');
    console.log('A path in another repository is not a claim about this one: write it as `repo:path`,');
    console.log('for example `customer-changelog:changelog/customer/`, and it is not checked.');
    console.log('');
  }

  if (result.uncovered.length > 0) {
    section(`UNCOVERED (${result.uncovered.length}) — on disk, absent from the briefing`);
    for (const item of result.uncovered) console.log(`- ${item}`);
    console.log('');
  }

  if (result.unfilled.length > 0) {
    section(`UNFILLED (${result.unfilled.length}) — placeholder markers still present`);
    for (const item of result.unfilled) console.log(`- ${item.marker}: ${item.count}`);
    console.log('');
  }

  if (result.notices?.length > 0) {
    section(`NOTICES (${result.notices.length}) — the block is still true; not a failure`);
    for (const item of result.notices) {
      if (item.text) console.log(`- ${item.text}`);
      else console.log(`- ${item.heading} missing (added in ${item.since}): ${item.why}. \`${nasoCommand()} review\` says what to add, inside the markers.`);
    }
    console.log('');
  }

  if (result.notes?.length > 0) {
    section(`VERSIONS (${result.notes.length}) — not a problem with the block`);
    for (const item of result.notes) console.log(`- ${item}`);
    console.log('');
  }

  if (result.ok) {
    console.log(
      `Briefing is consistent with the repository: ${result.tokens.length} path claim(s) ` +
        `verified${result.ignored?.length ? ` (${result.ignored.length} git-ignored, so generated rather than tracked)` : ''}, ` +
        `${result.entries.length} top-level area(s) covered, no placeholders left.`,
    );
    return;
  }

  console.log(
    `${result.problems.length} problem(s). Every path the briefing claims must exist, every ` +
      'real area must be\nmentioned, and no placeholder marker may remain. ' +
      `Regenerate with \`${nasoCommand()} briefing create --force\`.`,
  );
}

/**
 * Write AGENTS.md from a fresh scan, under the repo lock.
 *
 * Generation re-reads the repository inside the lock and re-renders from what it
 * finds there, so two concurrent setups produce one of two complete briefings
 * rather than a half-written file.
 */
