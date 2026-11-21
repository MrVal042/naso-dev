#!/usr/bin/env node
// NASO session hook — what Claude Code runs at session start and when the agent stops.
//
//   start  prints the handoff's NOW section and one line about the briefing; Claude Code adds
//          a SessionStart hook's output to the agent's context. Records when the session
//          started, for `stop`.
//   stop   when files changed during the session and the handoff did not, prints a reminder
//          to update it, once per session, as Stop hook additionalContext. Says nothing while
//          Claude Code is already continuing because of a Stop hook (stop_hook_active).
//
// A hook that fails gets in the way of every session, so this one cannot: no network, a
// hard time limit, every error swallowed, exit code 0 always. The session record lives in
// the OS temporary folder, never in the repository.

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { run, splitNul, nasoCommand } from './lib.mjs';

const LIMIT_MS = 8000;
const guard = setTimeout(() => process.exit(0), LIMIT_MS);
guard.unref();

async function readInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  const done = new Promise((resolve) => {
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
    setTimeout(resolve, 1000).unref();
  });
  await done;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') ?? {};
  } catch {
    return {};
  }
}

function sessionFile(root, sessionId) {
  const repo = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const id = String(sessionId ?? 'default').replace(/[^\w.-]/g, '_').slice(0, 80);
  return path.join(os.tmpdir(), 'naso-sessions', `${repo}-${id}.json`);
}

async function rootOf(input) {
  const start = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const res = await run('git', ['rev-parse', '--show-toplevel'], { cwd: start });
  return res.ok && res.stdout.trim() ? path.resolve(start, res.stdout.trim()) : path.resolve(start);
}

async function start(input) {
  const root = await rootOf(input);
  const lines = [];
  try {
    const { locateHandoff, nowSection } = await import('./handoff.mjs');
    const located = await locateHandoff(root);
    const text = await readFile(located.file, 'utf8').catch(() => null);
    if (text !== null) {
      const now = nowSection(text).trim();
      lines.push(`NASO handoff NOW (${located.shown}):`, now || '(empty)', '');
    }
  } catch {
    // No handoff to show is not worth a line.
  }
  try {
    if ((await stat(path.join(root, 'AGENTS.md')).catch(() => null))?.isFile()) {
      const { checkBriefing } = await import('./check.mjs');
      const result = await checkBriefing(root);
      lines.push(
        result.ok
          ? `NASO briefing: consistent, ${result.tokens.length} path claim${result.tokens.length === 1 ? '' : 's'} verified${result.notices?.length ? `; ${result.notices.length} section${result.notices.length === 1 ? '' : 's'} missing (\`${nasoCommand()} review\`)` : ''}.`
          : `NASO briefing: ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}. Run \`${nasoCommand()} briefing\` before relying on it.`,
      );
    }
  } catch {
    // The check is a convenience here; doctor and the hook report it properly.
  }
  if (lines.length > 0) console.log(lines.join('\n').trim());
  const file = sessionFile(root, input.session_id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ root, at: Date.now(), reminded: false }), 'utf8');
}

/** Files git sees as changed or new whose modification time is after `since`. */
async function changedSince(root, since) {
  const res = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
  if (!res.ok) return null;
  const fields = splitNul(res.stdout);
  const changed = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.includes('R') || code.includes('C')) i++;
    if (file.startsWith('.naso/') || file.startsWith('.claude/')) continue;
    const info = await stat(path.join(root, file)).catch(() => null);
    if (info && info.mtimeMs > since) changed.push(file);
  }
  return changed;
}

async function stop(input) {
  if (input.stop_hook_active === true) return;
  const root = await rootOf(input);
  const file = sessionFile(root, input.session_id);
  const record = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (!record || record.reminded) return;
  const changed = await changedSince(root, record.at);
  if (!changed || changed.length === 0) return;
  const { locateHandoff } = await import('./handoff.mjs');
  const located = await locateHandoff(root);
  const handoff = await stat(located.file).catch(() => null);
  if (handoff && handoff.mtimeMs > record.at) return;
  await writeFile(file, JSON.stringify({ ...record, reminded: true }), 'utf8');
  const shown = changed.slice(0, 3).join(', ') + (changed.length > 3 ? ` and ${changed.length - 3} more` : '');
  const cmd = nasoCommand();
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          `Files changed this session (${shown}) and the handoff did not. Before you stop, replace its NOW with where things stand: ` +
          `\`${cmd} handoff set "…"\` (open items you leave out are carried over), and log what you did: \`${cmd} handoff log "…"\`.`,
      },
    }),
  );
}

async function main() {
  const event = process.argv[2];
  const input = await readInput();
  if (event === 'start') await start(input);
  else if (event === 'stop') await stop(input);
}

main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
