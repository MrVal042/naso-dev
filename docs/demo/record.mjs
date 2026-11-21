#!/usr/bin/env node
// Records the README's demo from a real run: setup, then stats, on examples/go-cli.
//
// Nothing in the demo is typed by hand. This copies the example into a scratch repository,
// runs `naso-dev --yes` and `naso-dev stats` there, keeps the lines that tell the story (the
// repository as read, the files written, the check, the tokens an agent loads), and writes:
//
//   setup.svg   an animated terminal, about 15 seconds, looping; what the README shows
//   setup.cast  the same lines as an asciicast v2 file, for `asciinema play` or `agg`
//
//   node docs/demo/record.mjs

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { seedExample } from '../../examples/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', '..', 'bin', 'naso-dev.mjs');
const SECONDS = 15;

function naso(args, cwd) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  if (res.status !== 0) throw new Error(res.stderr || res.stdout);
  return res.stdout;
}

/** The lines of `text` from the one starting with `from` up to (not including) `to`. */
function section(text, from, to) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(from));
  const end = lines.findIndex((line, at) => at > start && line.startsWith(to));
  return lines.slice(start, end === -1 ? undefined : end).filter((line) => line.trim() !== '');
}

/** What the recording shows, each entry a line and the pause before it in seconds. */
export async function script() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'naso-demo-'));
  const dir = path.join(parent, 'go-cli');
  try {
    await seedExample('go-cli', dir);
    // Both spellings of the scratch path: macOS prints /private/var for /var.
    const real = await realpath(dir);
    const tidy = (text) => text.replaceAll(real, '~/go-cli').replaceAll(dir, '~/go-cli');
    const setup = tidy(naso(['--yes'], dir));
    const stats = tidy(naso(['stats'], dir));

    const repo = section(setup, 'Branch', 'What this does');
    const files = section(setup, '## Files this writes', '  ').concat(
      section(setup, '  AGENTS.md', '  .naso/tooling/'),
      // Thirty toolset rows say less than one: the overview a person sees folds them the same way.
      [`  .naso/tooling/                  new  (${section(setup, '  .naso/tooling/', '  .naso/config.json').length} files; the hook runs this copy)`],
      section(setup, '  .naso/config.json', '  .git/info/exclude'),
    );
    const written = section(setup, '## Accepted', '## Verify');
    const verify = section(setup, '## Verify', '## What you have now');
    const load = section(stats, '  File', 'Largest sections');

    const lines = [
      [0.4, '$ npx naso-dev --yes'],
      [0.6, setup.split('\n').find((line) => line.startsWith('NASO '))],
      ...repo.map((line) => [0.12, line]),
      [0.9, ''],
      ...files.map((line) => [0.1, line]),
      [0.9, ''],
      ...written.map((line) => [0.15, line]),
      ...verify.map((line) => [0.3, line]),
      [1.2, ''],
      [0.2, '$ npx naso-dev stats'],
      ...load.map((line) => [0.15, line]),
    ];
    // Paced to the length a person reads at, whatever the number of lines.
    const total = lines.reduce((sum, [pause]) => sum + pause, 0);
    return lines.map(([pause, text]) => [pause * ((SECONDS - 2) / total), text]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function colour(line) {
  if (line.startsWith('$ ')) return '#7ee787';
  if (line.startsWith('##') || line.startsWith('NASO ')) return '#e6edf3';
  if (line.startsWith('✓')) return '#7ee787';
  if (line.startsWith('!')) return '#d29922';
  return '#b1bac4';
}

export function renderSvg(lines) {
  const height = 20;
  const width = 1060;
  const total = lines.reduce((sum, [pause]) => sum + pause, 0);
  // The last frame holds until the loop restarts.
  const cycle = Math.max(SECONDS, total + 3);
  let at = 0;
  const rows = [];
  const styles = [];
  lines.forEach(([pause, text], index) => {
    at += pause;
    const on = ((at / cycle) * 100).toFixed(2);
    styles.push(`@keyframes l${index}{0%,${on}%{opacity:0}${(Number(on) + 0.01).toFixed(2)}%,98%{opacity:1}100%{opacity:0}}.l${index}{animation:l${index} ${cycle.toFixed(1)}s linear infinite}`);
    rows.push(`<text class="l${index}" x="20" y="${54 + index * height}" fill="${colour(text)}"${text.startsWith('##') || text.startsWith('$') ? ' font-weight="bold"' : ''}>${escape(text)}</text>`);
  });
  const h = 54 + lines.length * height + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-label="npx naso-dev --yes on a Go command-line tool, then npx naso-dev stats">
<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre;opacity:0}${styles.join('')}</style>
<rect width="${width}" height="${h}" rx="8" fill="#0d1117"/>
<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
${rows.join('\n')}
</svg>
`;
}

export function renderCast(lines) {
  const out = [JSON.stringify({ version: 2, width: 110, height: lines.length + 2, title: 'npx naso-dev --yes, then stats' })];
  let at = 0;
  for (const [pause, text] of lines) {
    at += pause;
    out.push(JSON.stringify([Number(at.toFixed(2)), 'o', `${text}\r\n`]));
  }
  return `${out.join('\n')}\n`;
}

async function main() {
  const lines = await script();
  await writeFile(path.join(HERE, 'setup.svg'), renderSvg(lines));
  await writeFile(path.join(HERE, 'setup.cast'), renderCast(lines));
  console.log(`${lines.length} lines, ${lines.reduce((sum, [pause]) => sum + pause, 0).toFixed(1)} seconds: docs/demo/setup.svg, docs/demo/setup.cast`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
