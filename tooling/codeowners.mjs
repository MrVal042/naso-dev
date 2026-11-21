// NASO codeowners — which paths are someone else's, from CODEOWNERS or NASO_SCOPE.
//
// The output becomes deny rules an agent cannot get past, so a mistake in either direction
// costs something: too strict and the agent cannot do its own work, too loose and it edits
// another team's code. So:
//
// - Patterns are read with gitignore semantics, which GitHub, GitLab and Bitbucket all use
//   for CODEOWNERS: a slash at the start or in the middle anchors to the root, `*` and `?`
//   stay inside one folder, `**` spans folders, and a pattern that names a folder covers
//   everything under it.
// - The last matching line wins. A line with no owners makes its paths nobody's.
// - GitLab sections are separate: a path is ours when any section's last match names us.
//   A section's default owners apply to its lines that name none.
// - A pattern this cannot translate exactly (`!`, `[ ]`, `\`) is reported by line, and any
//   path it might match is left editable: an unknown is never a deny.
// - A whole folder is denied as one rule only when no line could ever hand a path under it
//   back to us. Otherwise the tracked files are denied one by one, and the note says that
//   new files there are not covered.
// - NASO's own files (AGENTS.md, CLAUDE.md, .naso/) are never denied: the agent keeps the
//   briefing, the handoff and the lessons current.

const MAX_RULES = 1000;

const isNasoOwn = (file) => file === 'AGENTS.md' || file === 'CLAUDE.md' || file === '.naso' || file.startsWith('.naso/');

const escapeRegExp = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * A CODEOWNERS pattern as { regex, anchoredPrefix, dirOnly } or null when it cannot be
 * translated exactly. `regex` tests one path (file or folder) against the pattern body;
 * `anchoredPrefix` is the folders an anchored pattern starts with before its first glob,
 * or null for a pattern that can match anywhere.
 */
function compile(pattern) {
  let body = pattern.trim();
  const dirOnly = body.endsWith('/');
  if (dirOnly) body = body.replace(/\/+$/, '');
  const anchored = body.startsWith('/') || body.includes('/');
  body = body.replace(/^\/+/, '');
  const leadingAny = body.startsWith('**/');
  if (leadingAny) body = body.slice(3);
  if (!body) return null;

  let source = '';
  for (let i = 0; i < body.length; i++) {
    const rest = body.slice(i);
    if (rest.startsWith('/**/')) {
      source += '/(?:.*/)?';
      i += 3;
    } else if (rest === '/**') {
      source += '/.*';
      i += 2;
    } else if (rest.startsWith('**')) {
      source += '.*';
      i += 1;
    } else if (body[i] === '*') source += '[^/]*';
    else if (body[i] === '?') source += '[^/]';
    else source += escapeRegExp(body[i]);
  }
  const free = !anchored || leadingAny;
  const regex = new RegExp(`^${free ? '(?:.*/)?' : ''}${source}$`);
  // Where CODEOWNERS parts from gitignore: GitHub documents that `docs/*` owns
  // docs/getting-started.md but not docs/build-app/troubleshooting.md. A pattern whose last
  // segment has a wildcard matches paths themselves; only a literal last segment (`/apps/`,
  // `**/logs`) covers everything under a folder it names. `/a/**` matches the contents
  // through its own regex.
  const lastSegment = body.split('/').at(-1);
  const coversContents = !/[*?]/.test(lastSegment);
  const segments = body.split('/');
  const literal = [];
  for (const segment of segments) {
    if (/[*?]/.test(segment)) break;
    literal.push(segment);
  }
  return { regex, dirOnly, coversContents, anchoredPrefix: free ? null : literal };
}

/** Why a pattern cannot be translated exactly, or null when it can. */
function untranslatable(pattern) {
  if (pattern.startsWith('!')) return 'negation (!) is not part of CODEOWNERS syntax on GitHub, and its meaning differs between hosts';
  if (/[[\]]/.test(pattern)) return 'character ranges ([ ]) are not supported by GitHub CODEOWNERS and are read differently elsewhere';
  if (pattern.includes('\\')) return 'escapes (\\) are not supported by GitHub CODEOWNERS';
  return null;
}

/** A matcher for a pattern that could not be translated: wide enough to never miss a path it might mean. */
function loose(pattern) {
  const widened = pattern.replace(/^!/, '').replace(/\\(.)/g, '$1').replace(/\[[^\]]*\]?/g, '?');
  return compile(widened) ?? { regex: /.*/, dirOnly: false, coversContents: true, anchoredPrefix: null };
}

const ancestors = (file) => {
  const parts = file.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

function testCompiled(compiled, file) {
  if (!compiled) return false;
  if (!compiled.dirOnly && compiled.regex.test(file)) return true;
  return compiled.coversContents && ancestors(file).some((dir) => compiled.regex.test(dir));
}

/** Does the pattern cover `dir` as a folder: everything under it, whatever it is named? */
function coversFolder(compiled, dir) {
  if (!compiled) return false;
  if (compiled.coversContents && [dir, ...ancestors(dir)].some((candidate) => compiled.regex.test(candidate))) return true;
  // `/a/**` and `**`: a trailing ** matches any child name, so test one no line would name.
  return /\.\*\$$/.test(compiled.regex.source) && compiled.regex.test(`${dir}/\u0001/\u0001`);
}

/** Does a CODEOWNERS pattern match this path (a file, or a folder and so its contents)? */
export function matchesPattern(pattern, file) {
  return testCompiled(compile(pattern), file);
}

/**
 * The lines of a CODEOWNERS file: { entries, skipped }.
 * entries: [{ pattern, owners, line, section, compiled }] in file order; owners may be empty.
 * skipped: [{ pattern, line, reason, compiled }] for patterns that cannot be translated.
 */
export function parseCodeowners(text) {
  const entries = [];
  const skipped = [];
  let section = null;
  let defaults = [];
  String(text ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const header = /^\^?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (header) {
      section = header[1].trim();
      defaults = header[2].split(/\s+/).filter(Boolean);
      return;
    }
    const [pattern, ...named] = line.split(/\s+/);
    const reason = untranslatable(pattern);
    if (reason) {
      skipped.push({ pattern, line: index + 1, reason, compiled: loose(pattern) });
      return;
    }
    const compiled = compile(pattern);
    if (!compiled) {
      skipped.push({ pattern, line: index + 1, reason: 'the pattern is empty once its slashes are removed', compiled: loose('**') });
      return;
    }
    entries.push({ pattern, owners: named.length > 0 ? named : section ? defaults : [], line: index + 1, section, compiled });
  });
  return { entries, skipped };
}

const lower = (values) => new Set((values ?? []).map((value) => String(value).toLowerCase()));

/** 'ours', 'theirs' or 'nobody' for one path, by CODEOWNERS. */
function codeownersVerdict(file, entries, us) {
  const last = new Map();
  for (const entry of entries) if (testCompiled(entry.compiled, file)) last.set(entry.section, entry);
  if (last.size === 0) return 'nobody';
  const verdicts = [...last.values()].map((entry) => (entry.owners.length === 0 ? 'nobody' : entry.owners.some((owner) => us.has(owner.toLowerCase())) ? 'ours' : 'theirs'));
  if (verdicts.includes('ours')) return 'ours';
  return verdicts.includes('theirs') ? 'theirs' : 'nobody';
}

/** Could a pattern match anything under `dir`? False only when it provably cannot. */
function couldReachUnder(compiled, dir) {
  if (!compiled || compiled.anchoredPrefix === null) return true;
  const prefix = compiled.anchoredPrefix;
  const parts = dir.split('/');
  const shared = Math.min(prefix.length, parts.length);
  for (let i = 0; i < shared; i++) if (prefix[i] !== parts[i]) return false;
  return true;
}

/**
 * Whether every path under `dir`, now and later, is someone else's, and if not, the line
 * that could make one of them ours (for the note). A folder covered by a "theirs" line in
 * some section is safe when, after that line, nothing in that section that could reach
 * under it is ours or nobody's, nothing in any other section that could reach under it is
 * ours, and no untranslated pattern could reach under it.
 */
function folderVerdict(dir, codeowners, us) {
  const { entries, skipped } = codeowners;
  const sections = [...new Set(entries.map((entry) => entry.section))];
  const isOurs = (entry) => entry.owners.some((owner) => us.has(owner.toLowerCase()));
  let blocker = null;
  for (const section of sections) {
    const inSection = entries.filter((entry) => entry.section === section);
    let at = -1;
    for (let i = 0; i < inSection.length; i++) if (coversFolder(inSection[i].compiled, dir)) at = i;
    if (at === -1 || inSection[at].owners.length === 0 || isOurs(inSection[at])) continue;
    const later = inSection.slice(at + 1).find((entry) => (entry.owners.length === 0 || isOurs(entry)) && couldReachUnder(entry.compiled, dir));
    if (later) {
      blocker = later;
      continue;
    }
    const elsewhere = entries.find((entry) => entry.section !== section && isOurs(entry) && couldReachUnder(entry.compiled, dir));
    if (elsewhere) {
      blocker = elsewhere;
      continue;
    }
    const unknown = skipped.find((entry) => couldReachUnder(entry.compiled, dir));
    if (unknown) {
      blocker = unknown;
      continue;
    }
    return { safe: true, covered: true };
  }
  return { safe: false, covered: blocker !== null, blocker };
}

/**
 * The paths to deny, from CODEOWNERS (with `owners`, the people or teams who are "us") or,
 * without owners, from NASO_SCOPE prefixes. Nothing to go on means nothing to deny.
 *
 * Returns { source, rules, denied: { files }, skipped, notes, truncated }:
 *   source  — 'codeowners', 'scope' or null
 *   rules   — [{ path, dir }], sorted: a folder (everything under it) or one file
 *   denied  — every tracked file the rules cover today
 *   skipped — CODEOWNERS lines that could not be translated, with why
 *   notes   — folders whose new files are not covered, and why
 */
export function deniedPaths({ files = [], codeowners = null, owners = [], scope = [] } = {}) {
  const tracked = [...new Set(files)].filter(Boolean).sort();
  const us = lower(owners);
  const prefixes = (scope ?? []).map((prefix) => String(prefix).replace(/^\.?\/+|\/+$/g, '')).filter(Boolean);
  const skipped = (codeowners?.skipped ?? []).map(({ compiled, ...rest }) => rest);
  const empty = (source) => ({ source, rules: [], denied: { files: [] }, skipped, notes: [], truncated: false });

  let isDenied;
  let folderSafe;
  let source;
  const notes = [];
  if (codeowners && us.size > 0) {
    source = 'codeowners';
    isDenied = (file) =>
      !isNasoOwn(file) &&
      !codeowners.skipped.some((entry) => testCompiled(entry.compiled, file)) &&
      codeownersVerdict(file, codeowners.entries, us) === 'theirs';
    folderSafe = (dir) => {
      const verdict = folderVerdict(dir, codeowners, us);
      if (!verdict.safe && verdict.covered && verdict.blocker) {
        notes.push(`New files under ${dir}/ are not denied: ${verdict.blocker.pattern} (line ${verdict.blocker.line}) could make some of them ${verdict.blocker.owners ? 'yours or nobody\'s' : 'unknown'}, so only the tracked files there are.`);
      }
      return verdict.safe;
    };
  } else if (prefixes.length > 0) {
    source = 'scope';
    const inScope = (file) => prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
    isDenied = (file) => !isNasoOwn(file) && !inScope(file);
    // A folder that holds no scope prefix and sits under none is outside scope for good.
    folderSafe = (dir) => !isNasoOwn(dir) && !prefixes.some((prefix) => prefix === dir || prefix.startsWith(`${dir}/`) || dir.startsWith(`${prefix}/`));
  } else {
    return empty(null);
  }

  const rules = [];
  const denied = [];
  const walk = (dir, list) => {
    const depth = dir ? dir.split('/').length : 0;
    const children = new Map();
    for (const file of list) {
      const parts = file.split('/');
      if (parts.length === depth + 1) {
        if (isDenied(file)) {
          rules.push({ path: file, dir: false });
          denied.push(file);
        }
      } else {
        const child = parts.slice(0, depth + 1).join('/');
        if (!children.has(child)) children.set(child, []);
        children.get(child).push(file);
      }
    }
    for (const [child, under] of children) {
      const all = under.every(isDenied);
      if (all && folderSafe(child)) {
        rules.push({ path: child, dir: true });
        denied.push(...under);
        continue;
      }
      // Some of it denied, some not: the folder cannot be one rule, and the note says why
      // new files there are left editable.
      if (!all && under.some(isDenied)) folderSafe(child);
      walk(child, under);
    }
  };
  walk('', tracked);
  rules.sort((a, b) => a.path.localeCompare(b.path));
  const truncated = rules.length > MAX_RULES;
  return {
    source,
    rules: truncated ? rules.slice(0, MAX_RULES) : rules,
    denied: { files: denied.sort() },
    skipped,
    notes: [...new Set(notes)].slice(0, 10),
    truncated,
  };
}
