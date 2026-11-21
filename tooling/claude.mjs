#!/usr/bin/env node
// NASO claude — Claude Code extras: deny rules, session hooks, skills. Every one is opt-in.
//
// The core of NASO (AGENTS.md, the handoff, lessons, decisions) works for any agent or a
// person with no Claude at all. These make Claude Code use it without being told:
//
//   deny rules  `permissions.deny` Edit rules for paths outside your CODEOWNERS ownership or
//               NASO_SCOPE, so an edit outside scope never happens instead of being caught
//               at commit. Written to .claude/settings.local.json: which owners "we" are is
//               per person, and a shared file would deny the same paths to every teammate.
//   hooks       SessionStart prints the handoff's NOW and one line about the briefing; Stop
//               reminds the agent, once, to update the handoff when files changed and it
//               did not. They run the vendored .naso/tooling/ copy in exec form (no shell),
//               so the same entry works on macOS, Linux and Windows.
//   skills      .claude/skills/naso-*/SKILL.md: the handoff, a pre-PR self-review, recording
//               a decision, and catching up since the last session.
//
// Files a person has are merged into, never replaced: their keys and rules keep their order,
// NASO removes only rules it recorded as its own, and a skill without NASO's marker is left
// alone. Claude Code's deny rules cover its own file tools and the shell commands it
// recognises; they do not stop a script it runs from writing files.

import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { parseArgs, isMainModule, nasoCommand, SUPPORT_EMAIL, pathExists, listOption, toolVersion } from './lib.mjs';
import { repoContext } from './handoff.mjs';
import { listRepoFiles } from './scan.mjs';
import { CODEOWNERS_FILES } from './repo-rules.mjs';
import { parseCodeowners, deniedPaths } from './codeowners.mjs';
import { excludeLocally, isIgnored } from './install.mjs';

export const LOCAL_SETTINGS = path.join('.claude', 'settings.local.json');
export const SHARED_SETTINGS = path.join('.claude', 'settings.json');
const HOOK_SCRIPT = '${CLAUDE_PROJECT_DIR}/.naso/tooling/session-hook.mjs';
const HOOK_TIMEOUT = 10;
const SKILL_MARKER = '<!-- naso:skill';

export const SKILL_NAMES = ['naso-handoff', 'naso-pre-pr', 'naso-decide', 'naso-sweep'];

const posix = (value) => value.split(path.sep).join('/');

/**
 * One deny rule, anchored at the project root (a leading `/` in project settings is the
 * session's working directory). A folder denies everything under it. A name holding a
 * gitignore metacharacter cannot be written without guessing at escaping, so it is null.
 */
export function denyRule({ path: rel, dir }) {
  if (/[*?[\]\\!#]/.test(rel) || /\s$/.test(rel) || rel.startsWith('#')) return null;
  return dir ? `Edit(/${rel}/**)` : `Edit(/${rel})`;
}

/**
 * Put `rules` into `permissions.deny`. Rules NASO added before (`previous`) and no longer
 * wants are removed; every other rule stays where it is. A rule the person already had is
 * not NASO's, so it is never added again and never removed. Returns the new settings and
 * what NASO added and removed.
 */
export function mergeDeny(settings, rules, previous = []) {
  const next = structuredClone(settings ?? {});
  next.permissions ??= {};
  const current = Array.isArray(next.permissions.deny) ? next.permissions.deny : [];
  const wanted = new Set(rules);
  const removed = previous.filter((rule) => !wanted.has(rule) && current.includes(rule));
  const kept = current.filter((rule) => !removed.includes(rule));
  const added = rules.filter((rule) => !kept.includes(rule));
  next.permissions.deny = [...kept, ...added];
  // NASO's own earlier additions it still wants are still its own.
  const ours = [...previous.filter((rule) => wanted.has(rule) && kept.includes(rule)), ...added];
  return { settings: next, added, removed, ours };
}

const isNasoHook = (group) => (group?.hooks ?? []).some((hook) => (hook.args ?? []).some((arg) => String(arg).includes('.naso/tooling/session-hook.mjs')));

const hookGroup = (event, matcher) => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ type: 'command', command: 'node', args: [HOOK_SCRIPT, event], timeout: HOOK_TIMEOUT }],
});

/** Add NASO's SessionStart and Stop hooks unless they are there. The person's hooks stay first. */
export function mergeHooks(settings) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  const add = (eventName, group) => {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    next.hooks[eventName] = groups.some(isNasoHook) ? groups : [...groups, group];
  };
  add('SessionStart', hookGroup('start', 'startup|resume|clear|compact'));
  add('Stop', hookGroup('stop', null));
  return next;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function skillText(name, version) {
  const cmd = nasoCommand();
  const front = (description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${SKILL_MARKER} ${version}: written by NASO; delete this line to keep your own edits through a refresh -->\n\n`;
  switch (name) {
    case 'naso-handoff':
      return `${front('Update the NASO handoff: replace NOW with where things stand, log what happened, close open items. Use when a PR opens or merges, a decision is made, or before stopping.')}# Update the handoff

The handoff is what the next session reads first. Keep NOW one current state, not a log.

1. Run \`${cmd} handoff\` and read NOW, including its open items and their ids.
2. Write the new NOW as a whole: where things stand in two or three sentences, the next steps, and the open items. Keep every open item that is still open, with its id, as \`- [ ] (n) …\`. Write a new one as \`- [ ] …\` or \`- Waiting on <who>: …\`.
3. Replace NOW: \`${cmd} handoff set "…"\` (or \`--file <path>\`). An item you leave out is carried over, not closed; the command prints "carried over" for each.
4. Close only what is done: \`${cmd} handoff done <id>\`, or \`--close <id>\` on the set.
5. Log what happened, one line: \`${cmd} handoff log "Opened PR 41: parser rewrite."\`
6. Never claim something happened that you did not check: a push landed only if \`git ls-remote\` shows it, a PR is open only if you saw its URL.
`;
    case 'naso-pre-pr':
      return `${front('Self-review a change before opening a pull or merge request, then verify the push landed. Use before asking anyone to review.')}# Before opening a pull request

Review your own diff first (\`git diff <base>...HEAD\`). Each item is a question to answer, not a box to tick; say which you checked and what you found.

## Security
- No secret, token, key or credential in the diff, in a fixture, in a log line or in an error message.
- Input from outside (requests, files, environment, command-line arguments) is validated before use; nothing from it reaches a query, a shell command or a file path unescaped.
- Permissions and access checks are as strict as before, or stricter.

## Concurrency
- Two copies running at once (two requests, two workers, two processes, two agents) cannot corrupt shared state: files, rows, caches, counters.
- A retry or a duplicate message does no harm twice.

## The failure path of every external call
For each network call, disk read or write, database query and subprocess the change adds or touches:
- What happens when it fails, times out or returns something unexpected? Is the error reported with what was being attempted, or swallowed?
- Does a failure halfway leave things consistent: no half-written file, no partial transaction, no orphaned process?
- Is there a timeout, and does the caller handle it?

## Docs and tests
- Docs, README, changelog and the NASO block say what the code now does. A changed command, flag or output is documented in the same change.
- A test fails without the change and passes with it.
- The repository's own checks pass (see the briefing's When Done section).

## Claims
- Cite the file and line for every "the team decided", "the docs say" or "CI requires". Without a source, say it is your inference.

## After pushing
Check the push landed before saying it did:

\`\`\`
git rev-parse HEAD
git ls-remote origin <branch>
\`\`\`

The two hashes must match. Then update the handoff (\`${cmd} handoff log "Opened PR …"\`).
`;
    case 'naso-decide':
      return `${front('Record a decision made in this conversation as a NASO decision record, with where it was made. Use when the person decides something that should outlive the session.')}# Record a decision

1. Check it is a decision a person made, not your proposal. If you are unsure, ask.
2. Check it is not recorded already: read the decisions list linked from AGENTS.md. \`decide\` refuses a title it has.
3. Record it, quoting every value:

\`\`\`
${cmd} decide --title "…" --decision "…" --why "…" --source "<where it was decided: file and line, ticket, meeting and date>" --considered "<option> — <why not>"
\`\`\`

   Add \`--applies <paths>\` for the paths it governs, and one \`--considered\` per option turned down. Never write a source you did not see.
4. It is written as proposed. Never accept, reject or supersede it yourself; tell the person the id and the command to accept it.
5. Log it in the handoff: \`${cmd} handoff log "Recorded decision <id>: …"\`
`;
    case 'naso-sweep':
      return `${front('Catch up since the last session: what changed, what is new, what needs the person. Use at the start of a session after time away.')}# Catch up since the last session

1. Read the handoff: \`${cmd} handoff\`. Note the date of the newest log line; that is "since".
2. What changed: \`git log --oneline --since=<date>\` on this branch and the main one; \`git status --short\`.
3. Open pull or merge requests, if the host's command-line tool is installed (\`gh pr list\`, \`glab mr list\`). If neither is, say so; do not guess.
4. Decisions and lessons: \`${cmd} decisions audit\` and \`${cmd} lessons audit\`. Both change nothing.
5. The briefing: \`${cmd} briefing\`.
6. Report in three parts, each item with its source (commit, PR, file and line):
   - **Done**: what landed since the last session.
   - **New**: what changed that the handoff does not mention.
   - **Needs you**: proposals waiting for a person, audit findings, failing checks, and open items waiting on someone.
7. Update NOW with what is true now: \`${cmd} handoff set\`.
`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Plan and apply
// ---------------------------------------------------------------------------

async function readSettings(file) {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return { exists: false, settings: {}, indent: 2, text: null };
  try {
    // Written back with the file's own indentation, so a merge is a diff of the lines it changed.
    const indent = /^\{\s*\n([ \t]+)"/.exec(text)?.[1] ?? 2;
    return { exists: true, settings: JSON.parse(text), indent, text };
  } catch {
    return { exists: true, invalid: true, text };
  }
}

const render = (settings, indent) => `${JSON.stringify(settings, null, indent)}\n`;

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

/** The CODEOWNERS file this repository tracks, read, or null. */
async function readCodeownersFile(root, files) {
  const file = CODEOWNERS_FILES.find((name) => files.includes(name));
  if (!file) return null;
  return { file, parsed: parseCodeowners(await readFile(path.join(root, file), 'utf8').catch(() => '')) };
}

/** Every owner CODEOWNERS names, for the setup question. */
export async function codeownersOwners(cwd) {
  const { root } = await repoContext(cwd);
  const files = await listRepoFiles(root, { exclude: [] }).catch(() => []);
  const found = await readCodeownersFile(root, files);
  if (!found) return [];
  return [...new Set(found.parsed.entries.flatMap((entry) => entry.owners))].sort();
}

const scopeFromEnv = () => String(process.env.NASO_SCOPE ?? '').split(',').map((part) => part.trim()).filter(Boolean);

/**
 * The deny rules this repository wants now: { source, file, owners, scope, rules, unwritable,
 * notes, skipped, truncated, reason }. `reason` says why there are none when there are none.
 */
export async function wantedDeny(root, { owners = [], scope = [] } = {}) {
  const files = await listRepoFiles(root, { exclude: [] }).catch(() => []);
  const found = await readCodeownersFile(root, files);
  const result = deniedPaths({ files, codeowners: found?.parsed ?? null, owners, scope });
  const rules = [];
  const unwritable = [];
  for (const rule of result.rules) {
    const text = denyRule(rule);
    if (text) rules.push(text);
    else unwritable.push(rule.path);
  }
  let reason = null;
  if (!result.source) {
    reason = found
      ? `${found.file} is here, but nobody said which owners you are: --owners @team (or set NASO_SCOPE).`
      : 'There is no CODEOWNERS and no NASO_SCOPE, so nothing says which paths are someone else\'s.';
  }
  return {
    source: result.source,
    file: result.source === 'codeowners' ? found.file : null,
    owners: result.source === 'codeowners' ? owners : [],
    scope: result.source === 'scope' ? scope : [],
    rules,
    unwritable,
    notes: result.notes,
    skipped: result.skipped,
    truncated: result.truncated,
    reason,
  };
}

/**
 * Everything `naso-dev claude` (or setup) would write, computed without writing:
 * { writes, plans, report, errors, apply }. `apply()` writes it.
 */
export async function planClaude(cwd, { track, deny = false, owners = [], scope = [], hooks = false, skills = false, vendoring = false } = {}) {
  const { root, config } = await repoContext(cwd);
  const tracked = track ?? config?.track === true;
  const version = await toolVersion();
  const files = new Map();
  const writes = [];
  const plans = [];
  const report = [];
  const errors = [];
  const record = { ...(config?.claude ?? {}) };
  const excludes = [];

  const settingsAt = async (rel) => {
    if (!files.has(rel)) files.set(rel, await readSettings(path.join(root, rel)));
    return files.get(rel);
  };

  if (deny) {
    const useOwners = owners.length > 0 ? owners : config?.claude?.deny?.owners ?? [];
    const useScope = scope.length > 0 ? scope : scopeFromEnv().length > 0 ? scopeFromEnv() : config?.claude?.deny?.scope ?? [];
    const wanted = await wantedDeny(root, { owners: useOwners, scope: useScope });
    if (!wanted.source) {
      report.push(`Deny rules: none. ${wanted.reason}`);
    } else {
      const target = await settingsAt(LOCAL_SETTINGS);
      if (target.invalid) {
        errors.push(`${posix(LOCAL_SETTINGS)} is not valid JSON, so NASO left it alone. Fix it, then run \`${nasoCommand()} claude --deny\` again.`);
      } else {
        const merged = mergeDeny(target.settings, wanted.rules, config?.claude?.deny?.rules ?? []);
        target.settings = merged.settings;
        target.changed = true;
        const from = wanted.source === 'codeowners' ? `${wanted.file} for ${wanted.owners.join(', ')}` : `NASO_SCOPE ${wanted.scope.join(', ')}`;
        report.push(`Deny rules: ${wanted.rules.length} deny rule${wanted.rules.length === 1 ? '' : 's'} from ${from}, in ${posix(LOCAL_SETTINGS)}.`);
        for (const rule of wanted.rules.slice(0, 20)) report.push(`  ${rule}`);
        if (wanted.rules.length > 20) report.push(`  and ${wanted.rules.length - 20} more`);
        for (const rel of wanted.unwritable) report.push(`  ${rel}: its name holds a glob character, so it cannot be written as a rule without guessing; it is not denied.`);
        for (const entry of wanted.skipped) report.push(`  ${wanted.file} line ${entry.line} (${entry.pattern}) was not translated: ${entry.reason}. Paths it might match are not denied.`);
        for (const note of wanted.notes) report.push(`  ${note}`);
        if (wanted.truncated) report.push('  Only the first 1000 rules were written. Narrow it with NASO_SCOPE or --owners.');
        if (merged.removed.length > 0) report.push(`  Removed ${merged.removed.length} rule${merged.removed.length === 1 ? '' : 's'} NASO wrote before that no longer apply.`);
        report.push('  Deny rules cover Claude Code\'s file tools and the shell commands it recognises, not a script that writes files itself.');
        record.deny = { file: posix(LOCAL_SETTINGS), source: wanted.source, owners: wanted.owners, scope: wanted.scope, rules: merged.ours };
        plans.push({
          target: posix(LOCAL_SETTINGS),
          verb: target.exists ? 'Merge' : 'Write',
          detail: `${wanted.rules.length} Claude Code deny rule${wanted.rules.length === 1 ? '' : 's'} for paths outside ${wanted.source === 'codeowners' ? `your ownership in ${wanted.file}` : 'NASO_SCOPE'}. Your own rules and settings stay as they are.`,
        });
      }
    }
  }

  // A hook whose script is missing fails at the start of every session. Setup vendors the
  // toolset before it writes these (`vendoring`); on its own, this command needs it there.
  const hookScript = path.join(root, '.naso', 'tooling', 'session-hook.mjs');
  if (hooks && !vendoring && !(await pathExists(hookScript))) {
    errors.push(`.naso/tooling/session-hook.mjs is not there, so the hooks would fail every session; they were not added. Run \`${nasoCommand()} refresh\` (or set NASO up here first), then \`${nasoCommand()} claude --hooks\`.`);
    hooks = false;
  }

  if (hooks) {
    const rel = tracked ? SHARED_SETTINGS : LOCAL_SETTINGS;
    const target = await settingsAt(rel);
    if (target.invalid) {
      errors.push(`${posix(rel)} is not valid JSON, so NASO left it alone; the hooks were not added.`);
    } else {
      target.settings = mergeHooks(target.settings);
      target.changed = true;
      record.hooks = { file: posix(rel) };
      report.push(`Hooks: SessionStart prints the handoff's NOW and the briefing check; Stop reminds once to update the handoff. In ${posix(rel)}.`);
      plans.push({
        target: posix(rel),
        verb: target.exists ? 'Merge' : 'Write',
        detail: 'Claude Code hooks: SessionStart prints the handoff NOW and one line about the briefing; Stop reminds the agent, once, to update the handoff when files changed and it did not. They run .naso/tooling/session-hook.mjs, need no network, and exit 0 whatever happens.',
      });
    }
  }

  const skillWrites = [];
  if (skills) {
    const written = [];
    for (const name of SKILL_NAMES) {
      const rel = path.join('.claude', 'skills', name, 'SKILL.md');
      const existing = await readFile(path.join(root, rel), 'utf8').catch(() => null);
      if (existing !== null && !existing.includes(SKILL_MARKER)) {
        report.push(`Skills: ${name}: not written by NASO, left as it is.`);
        continue;
      }
      const text = skillText(name, version);
      skillWrites.push({ rel, text });
      written.push(name);
      writes.push({ path: posix(rel), change: existing === null ? 'new' : 'replace', lines: text.split('\n').length - 1 });
    }
    if (written.length > 0) {
      report.push(`Skills: ${written.join(', ')} in .claude/skills/.`);
      plans.push({ target: '.claude/skills/', verb: 'Write', detail: `Claude Code skills: ${written.join(', ')}. A skill you edited and removed the NASO line from is never replaced.` });
      excludes.push('.claude/skills/naso-*/');
    }
    record.skills = written;
  }

  for (const [rel, state] of files) {
    if (!state.changed) continue;
    writes.unshift({ path: posix(rel), change: state.exists ? 'merge' : 'new', lines: render(state.settings, state.indent).split('\n').length - 1 });
    if (rel === LOCAL_SETTINGS) excludes.push(posix(LOCAL_SETTINGS));
  }

  const apply = async () => {
    for (const [rel, state] of files) if (state.changed) await writeAtomic(path.join(root, rel), render(state.settings, state.indent));
    for (const { rel, text } of skillWrites) await writeAtomic(path.join(root, rel), text);
    if (!tracked) {
      const missing = [];
      for (const pattern of excludes) if (!(await isIgnored(root, pattern.replace('naso-*/', 'naso-handoff/SKILL.md')))) missing.push(pattern);
      if (!(await pathExists(path.join(root, '.naso'))) && !(await isIgnored(root, '.naso/config.json'))) missing.push('.naso');
      if (missing.length > 0) await excludeLocally(root, missing);
    }
    if (deny || hooks || skills) {
      const configFile = path.join(root, '.naso', 'config.json');
      const current = (await readFile(configFile, 'utf8').then(JSON.parse).catch(() => null)) ?? {};
      await writeAtomic(configFile, `${JSON.stringify({ ...current, claude: record }, null, 2)}\n`);
    }
  };

  return { root, writes, plans, report, errors, apply, record };
}

/** Whether the hooks NASO wrote can run: null when there are none; otherwise { ok, file }. */
export async function hooksHealth(cwd) {
  const { root, config } = await repoContext(cwd);
  if (!config?.claude?.hooks) return null;
  return { ok: await pathExists(path.join(root, '.naso', 'tooling', 'session-hook.mjs')), file: config.claude.hooks.file };
}

/**
 * Drift between what ownership asks for now and the deny rules on disk, for doctor:
 * null when deny rules were never set up; otherwise { ok, expected, missing, stale, file }.
 */
export async function denyDrift(cwd) {
  const { root, config } = await repoContext(cwd);
  const recorded = config?.claude?.deny;
  if (!recorded) return null;
  const wanted = await wantedDeny(root, { owners: recorded.owners ?? [], scope: recorded.scope?.length ? recorded.scope : scopeFromEnv() });
  const settings = await readSettings(path.join(root, recorded.file ?? LOCAL_SETTINGS));
  const inFile = settings.invalid ? [] : settings.settings?.permissions?.deny ?? [];
  const missing = wanted.rules.filter((rule) => !inFile.includes(rule));
  const stale = (recorded.rules ?? []).filter((rule) => !wanted.rules.includes(rule) && inFile.includes(rule));
  return { ok: missing.length === 0 && stale.length === 0 && !settings.invalid, expected: wanted.rules, missing, stale, file: recorded.file, source: wanted.source, invalid: Boolean(settings.invalid) };
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, lists, positional } = parseArgs(argv);
  const cmd = nasoCommand();
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO claude

Usage:
  ${cmd} claude [target-dir] [--deny [--owners @a,@b] [--scope a,b]] [--hooks] [--skills] [--dry-run]

Claude Code extras, each opt-in:
  --deny     permissions.deny Edit rules in .claude/settings.local.json for every path outside
             your CODEOWNERS ownership (--owners), or outside NASO_SCOPE (--scope or the
             environment variable). Run again after CODEOWNERS changes; doctor says when.
  --hooks    SessionStart prints the handoff's NOW and the briefing check; Stop reminds once to
             update the handoff. In settings.json when .naso/ is committed, settings.local.json
             when it is not.
  --skills   .claude/skills/: naso-handoff, naso-pre-pr, naso-decide, naso-sweep.

Your own settings, rules and skills are kept. Nothing here is needed for NASO to work.`);
    return;
  }
  const options = {
    deny: flags.has('deny'),
    hooks: flags.has('hooks'),
    skills: flags.has('skills'),
    owners: listOption(lists, 'owners'),
    scope: listOption(lists, 'scope'),
  };
  if (!options.deny && !options.hooks && !options.skills) {
    console.log(`Say what to write: --deny, --hooks, --skills, or any of them together. ${cmd} claude --help explains each.`);
    return;
  }
  const plan = await planClaude(positional[0] ?? process.cwd(), options);
  console.log(`NASO claude  ${plan.root}\n`);
  for (const line of plan.report) console.log(line);
  for (const error of plan.errors) console.error(`naso-dev claude: ${error}`);
  if (flags.has('dry-run')) {
    console.log('\n--dry-run: nothing was written.');
    return;
  }
  await plan.apply();
  if (plan.errors.length > 0) process.exitCode = 1;
}


if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev claude: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
