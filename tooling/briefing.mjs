#!/usr/bin/env node
// NASO Briefing — the repository scanner, the AGENTS.md writer, and the checker
// that keeps those two honest.
//
// Three views of one scan:
//
//   create   read the repository, then write AGENTS.md from nothing but what was
//            read. Every path in the output is verified to exist as it is
//            written; every sentence is either a count, a config value, or a
//            path. No placeholders, no descriptions invented from a directory's
//            name, no section kept alive only to look thorough.
//   check    does the briefing still match the repository?
//   (default = check)
//
// The rule that shapes all of it: **state only what you can read off disk.** A
// section that cannot be derived is left out rather than filled with a guess.
// That is what makes `check` able to pass on a freshly generated file with no
// human editing anything — which is the entire point, because a briefing full
// of TODO markers is a chore nobody finishes, and an unfinished briefing is
// worse than no briefing at all.
//
// Usage:
//   npx naso-dev briefing [dir]              # check (exit 1 on problems)
//   npx naso-dev briefing [dir] create       # write the NASO block
//   npx naso-dev briefing [dir] refresh      # move the version stamp only
//
// The scanner, the renderer and the checker live in scan.mjs, render.mjs and check.mjs.
// Everything they export is re-exported here, so `./briefing.mjs` stays the one import
// for every other module, and a vendored copy from before the split keeps working.
//
// Zero external dependencies — Node.js core modules only.

import {
  readFile,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import path from 'node:path';
import { NASO_DIR } from './vendor.mjs';
import {
  pathExists,
  parseArgs,
  compareVersions,
  isMainModule,
  toolVersion,
  banner,
  SUPPORT_EMAIL,
  nasoCommand,
} from './lib.mjs';
import {
  withLock,
} from './lock.mjs';
import {
  AGENTS_FILE,
  NASO_END,
  NASO_START,
  blockDigest,
  blockEdited,
  plural,
  scanRepo,
  listRepoFiles,
  areasOf,
  topLevelEntries,
} from './scan.mjs';
import { migrateBlock, planGuides, writeGuides } from './guides.mjs';
import {
  countPhrase,
  describeEntry,
  renderLayers,
  renderRootFiles,
} from './render.mjs';
import {
  checkBriefing,
  localOnlyGuides,
  printCheck,
} from './check.mjs';

export * from './scan.mjs';
export * from './render.mjs';
export * from './check.mjs';
export * from './guides.mjs';

export const EDITED_BLOCK_NOTE =
  `- ${AGENTS_FILE}: the NASO block was edited after NASO wrote it (or was written before\n` +
  '  NASO kept a digest), so it was left exactly as it is. Reviewed corrections are never\n' +
  '  replaced by a regenerate. To replace it anyway, add --discard-edits; the old block is\n' +
  '  saved under .naso/backups/ first.';

/**
 * Write the NASO block into AGENTS.md, under the repo lock, without ever touching
 * anything a person wrote.
 *
 * Four cases, and the differences between them are the whole point:
 *
 *   no file            write the block as the whole file
 *   file, no markers   append the block below what is there, byte for byte
 *   file, markers     replace only what is between them — and only with --force
 *   --force            never reaches outside the markers, whatever else it does
 *
 * The 2.x behaviour — "AGENTS.md exists, so overwrite it" — is gone. A 193-line
 * hand-written AGENTS.md is not a stale cache entry, and a tool that deletes it on
 * setup is a tool nobody runs twice. `--force` now means exactly one thing: replace
 * the block between the markers. It is not, and cannot be, permission to rewrite the file.
 *
 * Generation re-reads the repository inside the lock and re-renders from what it
 * finds there, so two concurrent setups produce one of two complete briefings
 * rather than a half-written file.
 */
export async function createBriefing(cwd, { force = false, discardEdits = false, exclude = null } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);

  const version = await toolVersion();
  const now = new Date().toISOString().slice(0, 10);

  const outcome = await withLock(
    cwd,
    async () => {
      const before = await readFile(agentsPath, 'utf8').catch(() => null);
      const existingLines = before === null ? 0 : before.split('\n').length;

      const facts = await scanRepo(cwd, { exclude });
      const { block, guides } = await renderLayers(facts, { version, now });

      if (before === null) {
        await writeFile(agentsPath, block, 'utf8');
        const written = await writeGuides(cwd, guides);
        return { ok: true, appended: false, agentsPath, content: block, facts, guides: written };
      }

      const start = before.indexOf(NASO_START);
      const end = before.indexOf(NASO_END);

      if (start === -1 || end === -1 || end < start) {
        // No block of ours in the file: append one and keep every existing line.
        const appended = appendBlock(before, block);
        await writeFile(agentsPath, appended, 'utf8');
        const written = await writeGuides(cwd, guides);
        return { ok: true, appended: true, existingLines, agentsPath, content: appended, facts, guides: written };
      }

      if (!force) {
        return { ok: false, reason: 'has-block', agentsPath, existingLines };
      }

      // People corrected this block in review. --force alone never discards that; it takes
      // --discard-edits, and even then the old block is saved first.
      const edited = blockEdited(before);
      if (edited && !discardEdits) {
        return { ok: false, reason: 'edited', agentsPath, existingLines };
      }
      let backup = null;
      if (edited) {
        backup = path.join(NASO_DIR, 'backups', `AGENTS-block-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        await mkdir(path.join(cwd, path.dirname(backup)), { recursive: true });
        await writeFile(path.join(cwd, backup), before.slice(start, end + NASO_END.length) + '\n', 'utf8');
      }

      const replaced =
        before.slice(0, start) + block.trimEnd() + before.slice(end + NASO_END.length);
      await writeFile(agentsPath, replaced, 'utf8');
      const written = await writeGuides(cwd, guides, { discardEdits });
      return {
        ok: true,
        guides: written,
        appended: false,
        replacedBlock: true,
        backup,
        existingLines,
        agentsPath,
        content: replaced,
        facts,
      };
    },
    {
      reason: 'write the AGENTS.md briefing',
      onBusy: (holder) => {
        console.log(`  ! ${AGENTS_FILE} is locked by ${holder}; skipped the write.`);
      },
    },
  );

  return outcome.ok ? outcome.value : { ok: false, reason: 'locked', holder: outcome.holder };
}

/**
 * Split a block written before 2.0.0 into a root block and guides, word for word.
 *
 * Nothing is regenerated: each section moves with every line people wrote in it, and the
 * root keeps what every session needs. A guide that is already on disk is never replaced;
 * the run stops and says which. Without `write`, it only says what it would do.
 */
export async function migrateBriefing(cwd, { write = false } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  const outcome = await withLock(
    cwd,
    async () => {
      const before = await readFile(agentsPath, 'utf8').catch(() => null);
      if (before === null) return { ok: false, reason: 'missing' };
      const start = before.indexOf(NASO_START);
      const end = before.indexOf(NASO_END);
      if (start === -1 || end < start) return { ok: false, reason: 'no-block' };

      const edited = blockEdited(before);
      const inner = before.slice(start + NASO_START.length, end);
      const project = inner.match(/^#\s+(.+?)\s+—\s+Agent Instructions\s*$/m)?.[1] ?? path.basename(cwd);
      const files = await listRepoFiles(cwd).catch(() => []);
      const areas = areasOf(topLevelEntries(files ?? [])).map((entry) => entry.name);
      const split = migrateBlock(inner, { project, areas, edited });
      if (!split) return { ok: false, reason: 'layered' };

      const planned = await planGuides(cwd, split.guides);
      const taken = planned.filter((guide) => guide.change !== 'new' && guide.change !== 'unchanged');
      if (taken.length > 0) return { ok: false, reason: 'guides-exist', taken: taken.map((guide) => guide.rel) };

      let block = `${NASO_START}${split.root.startsWith('\n') ? '' : '\n'}${split.root}${NASO_END}`;
      // An untouched block stays untouched: its digest follows the move. An edited one keeps
      // the digest it had, so it still reads as edited.
      if (!edited) block = block.replace(/^(<!--\s*digest:\s*)[0-9a-f]+(\s*-->)$/m, `$1${blockDigest(block)}$2`);
      const after = before.slice(0, start) + block + before.slice(end + NASO_END.length);
      const lines = (text) => text.split('\n').length;
      const result = {
        ok: true,
        written: write,
        agentsPath,
        rootLines: { before: lines(before.slice(start, end)), after: lines(block) },
        guides: split.guides.map((guide) => ({ rel: guide.rel, headings: guide.headings, lines: lines(guide.text) })),
        kept: split.kept,
        localOnly: await localOnlyGuides(cwd, split.guides.map((guide) => guide.rel)),
      };
      if (!write) return result;
      await writeFile(agentsPath, after, 'utf8');
      await writeGuides(cwd, split.guides);
      return result;
    },
    { reason: 'split the AGENTS.md block into guides' },
  );
  return outcome.ok ? outcome.value : { ok: false, reason: 'locked', holder: outcome.holder };
}

/**
 * A hand-written AGENTS.md with the NASO block appended, every existing byte kept.
 *
 * One function for the write and for the plan's line count, so the preview cannot
 * disagree with the file about how much was added.
 */
export function appendBlock(before, block) {
  const separator =
    before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${separator}${block}`;
}

/** Read one of the machine-readable header markers, or null when absent. */
export function readBriefingMarkerValue(content, field) {
  const pattern = new RegExp(`^<!--\\s*${field}:\\s*(.+?)\\s*-->$`, 'm');
  return content.match(pattern)?.[1] ?? null;
}

/**
 * Move the `<!-- version: X -->` stamp and say the refresh on the "Generated by NASO" line, and nothing else.
 *
 * Used by `refresh`, whose whole promise is that a briefing somebody spent twenty minutes
 * on survives a version bump. Only the stamp line is rewritten; every other byte is
 * written back untouched.
 *
 * The stamp only ever moves forward. A briefing generated by a newer NASO than the tool
 * asking is reported and left alone: rewriting it would erase the only evidence that the
 * tool — not the briefing — needs updating.
 */
export async function refreshBriefingStamp(cwd, { current } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    return { ok: false, reason: 'missing', agentsPath };
  }

  const version = current ?? (await toolVersion());
  const content = await readFile(agentsPath, 'utf8');
  const stamped = readBriefingMarkerValue(content, 'version');

  if (!stamped) {
    return { ok: false, reason: 'unstamped', agentsPath };
  }
  if (stamped === version || compareVersions(stamped, version) > 0) {
    return { ok: true, changed: false, agentsPath, version, previous: stamped };
  }

  // The prose line says the same version; leaving it behind had the block contradict itself.
  const restamped = content.replace(/^<!--\s*version:\s*.+?\s*-->$/m, `<!-- version: ${version} -->`);
  // The original version and date stay: "Generated by NASO 1.5.1 on <a date before
  // 1.5.1 existed>" was false. The refresh is said beside them. A reviewed block may have
  // reworded that line; then only the stamp moves, and the caller must not say otherwise.
  const after = restamped.replace(
    /^> Generated by NASO (\S+) on (\S+?)(?: \(refreshed to \S+ on \S+\))? from /m,
    (_, first, date) => `> Generated by NASO ${first} on ${date} (refreshed to ${version} on ${new Date().toISOString().slice(0, 10)}) from `,
  );
  await writeFile(agentsPath, after, 'utf8');
  return { ok: true, changed: true, noted: after !== restamped, agentsPath, version, previous: stamped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`NASO briefing

Usage:
  ${nasoCommand()} briefing [dir]                    check the briefing against the repo
  ${nasoCommand()} briefing [dir] check              same
  ${nasoCommand()} briefing [dir] create             write the NASO block into AGENTS.md
  ${nasoCommand()} briefing [dir] create --force     replace an existing naso:start/naso:end block
  ${nasoCommand()} briefing [dir] refresh            move the version stamp only
  ${nasoCommand()} briefing [dir] migrate            show how a block from before 2.0.0 splits into guides
  ${nasoCommand()} briefing [dir] migrate --write    do it: sections move word for word

Never rewrites anything outside <!-- naso:start --> and <!-- naso:end -->.

Exit codes: 0 clean, 1 problems found or the write was refused.
Support: ${SUPPORT_EMAIL}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }

  const [maybeCommand, ...rest] = positional;
  const COMMANDS = new Set(['check', 'create', 'refresh', 'migrate']);

  // The verb and the directory may come in either order. A positional that
  // matches a verb *and* names a directory that exists is a directory, so a repo
  // literally called `create` still works when named as `./create`.
  const isVerb = async (token) => COMMANDS.has(token) && !(await pathExists(path.resolve(token)));
  let command = 'check';
  let cwd;

  if (await isVerb(maybeCommand)) {
    command = maybeCommand;
    cwd = path.resolve(rest[0] ?? process.cwd());
  } else {
    cwd = path.resolve(maybeCommand ?? process.cwd());
  }
  for (const token of positional) {
    if (await isVerb(token)) command = token;
  }

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev briefing: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  if (command === 'create') {
    const result = await createBriefing(cwd, { force: flags.has('force'), discardEdits: flags.has('discard-edits') });
    if (!result.ok) {
      if (result.reason === 'edited') {
        console.log(EDITED_BLOCK_NOTE);
      } else if (result.reason === 'has-block') {
        console.log(
          `- ${AGENTS_FILE} already has a naso:start / naso:end block. Left it exactly as it is.\n` +
            '  Re-run with --force to replace just that block. Nothing outside the markers\n' +
            '  is ever rewritten, with or without --force.',
        );
      } else {
        console.log(`- Skipped ${AGENTS_FILE}: locked by ${result.holder}.`);
      }
      process.exitCode = 1;
      return;
    }

    banner('Briefing', result.agentsPath);
    console.log(
      result.appended
        ? `Appended the NASO block below the ${plural(result.existingLines, 'line')} already in ${AGENTS_FILE}. Nothing existing was changed.`
        : result.replacedBlock
          ? `Replaced the naso:start / naso:end block. The other ${plural(result.existingLines, 'line')} of ${AGENTS_FILE} are byte for byte as you left them.`
          : `Wrote ${AGENTS_FILE} from ${countPhrase(result.facts)}.`,
    );
    console.log('');
    for (const entry of result.facts.areas) {
      console.log(`  ${describeEntry(entry)}`);
    }
    const rootFiles = renderRootFiles(result.facts.entries, result.facts);
    if (rootFiles) {
      console.log('');
      console.log(`  ${rootFiles.split('\n').join('\n  ')}`);
    }
    console.log('');
    const verified = await checkBriefing(cwd);
    printCheck(verified);
    if (!verified.ok) process.exitCode = 1;
    return;
  }

  if (command === 'migrate') {
    const write = flags.has('write');
    const result = await migrateBriefing(cwd, { write });
    if (!result.ok) {
      const why = {
        missing: `No ${AGENTS_FILE} in ${cwd}. Run \`${nasoCommand()} setup\` first.`,
        'no-block': `${AGENTS_FILE} has no naso:start / naso:end block; nothing of NASO's to split.`,
        layered: `The block already links its guides; nothing to migrate.`,
        'guides-exist': `These guides are already on disk and would be replaced: ${(result.taken ?? []).join(', ')}. Move them aside, or merge them into the block by hand first. Nothing was written.`,
        locked: `${AGENTS_FILE} is locked by ${result.holder}; nothing was written.`,
      }[result.reason];
      console.log(`- ${why}`);
      if (result.reason !== 'layered') process.exitCode = 1;
      return;
    }
    banner('Briefing Migrate', result.agentsPath);
    console.log(`${result.written ? 'Moved' : 'Would move'} these sections out of the block, word for word:`);
    for (const guide of result.guides) console.log(`  ${guide.rel}: ${guide.headings.join(', ')} (${plural(guide.lines, 'line')})`);
    console.log(`The block ${result.written ? 'went' : 'would go'} from ${plural(result.rootLines.before, 'line')} to ${plural(result.rootLines.after, 'line')}, with a ${'When You Touch'} table naming each guide.`);
    if (result.localOnly.length > 0) {
      console.log(
        `\nGit ignores ${result.localOnly.join(', ')}, and ${AGENTS_FILE} is not ignored: the block would reach every clone and these guides would not. ` +
          'Commit them with `git add -f`, or leave this block in one file.',
      );
    }
    if (result.kept.length > 0) console.log(`Left in the block, because NASO does not know where they belong: ${result.kept.join(', ')}. Move them into a guide by hand if only one kind of task needs them.`);
    if (!result.written) {
      console.log(`\nNothing was written. \`${nasoCommand()} briefing migrate --write\` does it.`);
      return;
    }
    console.log('');
    const verified = await checkBriefing(cwd);
    printCheck(verified);
    if (!verified.ok) process.exitCode = 1;
    return;
  }

  if (command === 'refresh') {
    const result = await refreshBriefingStamp(cwd);
    if (!result.ok) {
      console.log(
        result.reason === 'missing'
          ? `- No ${AGENTS_FILE} in ${cwd} yet. Run \`naso setup\` to create it.`
          : `- No version stamp found in ${AGENTS_FILE}; nothing changed.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!result.changed) {
      if (compareVersions(result.previous, result.version) > 0) {
        console.log(
          `- ${AGENTS_FILE} was written by a newer NASO (${result.previous}); this tool is ${result.version}. ` +
            `Update naso-dev rather than downgrading the briefing.`,
        );
      } else {
        console.log(`- ${AGENTS_FILE} is already stamped ${result.version} — nothing to refresh.`);
      }
      return;
    }
    console.log(`- Refreshed ${AGENTS_FILE} version stamp: ${result.previous} -> ${result.version}`);
    console.log(
      result.noted
        ? '  Noted the refresh on the "Generated by" line; nothing else in the briefing changed.'
        : '  No "Generated by NASO" line in the form NASO writes, so only the stamp moved; nothing else in the briefing changed.',
    );
    return;
  }

  banner('Briefing Check', cwd);
  const result = await checkBriefing(cwd);
  printCheck(result);
  if (!result.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev briefing: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
