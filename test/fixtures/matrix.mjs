// The repository shapes every phase's tests run against. Each one is generated on disk by
// the test that needs it: no binaries, no network, nothing checked in but this file.
//
// A shape is here because NASO has to behave the same in it as in a Node app, and the
// easy mistake is to assume package.json, a commit, a normal .git directory, or a git
// repository at all. Each entry names which of those it takes away.

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { exec, put } from '../helpers.mjs';

async function gitInit(dir) {
  const git = (...args) => exec('git', args, dir);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'NASO Test');
  return git;
}

async function commitAll(git, message = 'init') {
  await git('add', '-A');
  await git('commit', '-qm', message);
}

/**
 * name      — how a failing test names it.
 * git       — 'repo' (a normal clone), 'worktree' (`.git` is a file), 'empty' (no
 *             commits yet) or 'none' (a plain folder holding repositories).
 * seed(dir) — writes the files; returns { dir } where `dir` is the folder a command runs in,
 *             which for a worktree is the linked worktree, not the main checkout.
 */
export const FIXTURES = [
  {
    name: 'node-monorepo',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'package.json', JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'], scripts: { test: 'node --test' } }, null, 2));
      await put(dir, 'package-lock.json', '{"lockfileVersion":3}\n');
      await put(dir, 'packages/api/package.json', JSON.stringify({ name: '@mono/api' }));
      await put(dir, 'packages/api/src/index.js', 'export const api = 1;\n');
      await put(dir, 'packages/web/package.json', JSON.stringify({ name: '@mono/web' }));
      await put(dir, 'packages/web/src/index.js', 'export const web = 1;\n');
      await put(dir, 'README.md', '# Mono\n');
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'python',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'pyproject.toml', '[project]\nname = "svc"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
      await put(dir, 'svc/__init__.py', '');
      await put(dir, 'svc/app.py', 'def main():\n    return 1\n');
      await put(dir, 'tests/test_app.py', 'from svc.app import main\n\ndef test_main():\n    assert main() == 1\n');
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'go',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'go.mod', 'module example.invalid/tool\n\ngo 1.22\n');
      await put(dir, 'cmd/tool/main.go', 'package main\n\nfunc main() {}\n');
      await put(dir, 'internal/run/run.go', 'package run\n');
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'rust',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'Cargo.toml', '[workspace]\nmembers = ["crates/core"]\n');
      await put(dir, 'Cargo.lock', '# generated\nversion = 3\n');
      await put(dir, 'crates/core/Cargo.toml', '[package]\nname = "core"\nversion = "0.1.0"\nedition = "2021"\n');
      await put(dir, 'crates/core/src/lib.rs', 'pub fn one() -> u8 { 1 }\n');
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'java-gradle',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'settings.gradle.kts', 'rootProject.name = "svc"\ninclude("app", "lib")\n');
      await put(dir, 'build.gradle.kts', 'plugins { java }\n');
      await put(dir, 'app/build.gradle.kts', 'plugins { application }\n');
      await put(dir, 'app/src/main/java/App.java', 'public class App {}\n');
      await put(dir, 'lib/src/main/java/Lib.java', 'public class Lib {}\n');
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'terraform-only',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'main.tf', 'terraform {\n  required_version = ">= 1.5"\n}\n');
      await put(dir, 'variables.tf', 'variable "name" {}\n');
      await put(dir, 'modules/network/main.tf', 'resource "null_resource" "n" {}\n');
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'docs-only',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'README.md', '# Handbook\n');
      await put(dir, 'docs/intro.md', '# Intro\n');
      await put(dir, 'docs/guides/setup.md', '# Setup\n');
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'empty-repo',
    git: 'empty',
    async seed(dir) {
      await gitInit(dir);
      return { dir };
    },
  },
  {
    name: 'worktree',
    git: 'worktree',
    async seed(dir) {
      const main = path.join(dir, 'main');
      await mkdir(main, { recursive: true });
      const git = await gitInit(main);
      await put(main, 'package.json', JSON.stringify({ name: 'wt', scripts: { test: 'node --test' } }));
      await put(main, 'src/index.js', 'export const x = 1;\n');
      await commitAll(git);
      const linked = path.join(dir, 'linked');
      await git('worktree', 'add', '-q', '-b', 'feature', linked);
      return { dir: linked, main };
    },
  },
  {
    name: 'gitlab-sectioned-codeowners',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'package.json', JSON.stringify({ name: 'gl' }));
      await put(dir, 'src/app.js', 'export const app = 1;\n');
      await put(dir, 'infra/main.tf', 'terraform {}\n');
      await put(dir, 'docs/readme.md', '# Docs\n');
      await put(
        dir,
        '.gitlab/CODEOWNERS',
        '* @platform-team\n\n[Backend][2] @backend-team\n/src/ @backend-team\n\n^[Docs]\n/docs/ @writers\n\n[Infra]\ninfra/ @ops\n',
      );
      await commitAll(git);
      return { dir };
    },
  },
  {
    name: 'husky-hook',
    git: 'repo',
    async seed(dir) {
      const git = await gitInit(dir);
      await put(dir, 'package.json', JSON.stringify({ name: 'hk', scripts: { prepare: 'husky' }, devDependencies: { husky: '9.0.0' } }));
      await put(dir, 'src/index.js', 'export const x = 1;\n');
      await put(dir, '.husky/pre-commit', 'echo husky ran\n');
      await commitAll(git);
      await git('config', 'core.hooksPath', '.husky');
      return { dir };
    },
  },
  {
    name: 'non-git-parent',
    git: 'none',
    async seed(dir) {
      for (const child of ['service-a', 'service-b']) {
        const repo = path.join(dir, child);
        await mkdir(repo, { recursive: true });
        const git = await gitInit(repo);
        await put(repo, 'README.md', `# ${child}\n`);
        await put(repo, 'src/main.py', 'print(1)\n');
        await commitAll(git);
      }
      return { dir, children: ['service-a', 'service-b'] };
    },
  },
];

/** Seed one fixture in a fresh temporary folder, run `fn`, and always clean up. */
export async function withFixture(fixture, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), `naso-${fixture.name}-`));
  try {
    const seeded = await fixture.seed(root);
    return await fn({ root, ...seeded });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
