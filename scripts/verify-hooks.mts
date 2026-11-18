import type { TestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  delete env.UV_PROJECT_ENVIRONMENT;
  delete env.NODE_TEST_CONTEXT; // A real Git hook is not nested inside the Node test runner.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  for (const sub of ['scripts', '.githooks', 'test', 'public']) mkdirSync(join(dir, sub));
  for (const file of ['package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock', '.python-version', '.node-version', 'eslint.config.mts', 'tsconfig.json', 'tsconfig.browser.json', 'scripts/build.mts', '.gitignore', 'scripts/check.mts', 'scripts/git-gate.mts', 'scripts/install-hooks.mts', '.githooks/pre-commit', '.githooks/pre-push']) copyFileSync(file, join(dir, file));
  for (const hook of ['pre-commit', 'pre-push']) chmodSync(join(dir, '.githooks', hook), 0o755);
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  symlinkSync(resolve('.venv'), join(dir, '.venv'), 'dir');
  const write = (path: string, text: string) => writeFileSync(join(dir, path), text);
  write('public/good file.ts', 'export const value = 1;\n');
  // The browser project always has a source; renaming the other one must not empty it.
  write('public/keep.ts', 'export const kept = true;\n');
  write('test/pass.test.mts', "import test from 'node:test';\ntest('pass', () => {});\n");
  write('scripts/verify-hooks.mts', "import test from 'node:test';\ntest('fixture hooks', () => {});\n");
  write('test/project-sync_test.py', 'print("fixture Python check")\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const node = (...args: string[]) => spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
  const commit = () => spawnSync('git', ['-c', 'core.hooksPath=.githooks', 'commit', '-qm', 'change'], { cwd: dir, env, encoding: 'utf8' });
  return { dir, env, git, node, write, commit };
}

test('commit checks staged bytes, including partial commits, renames and deletions', t => {
  const f = fixture(t);
  f.write('public/good file.ts', 'missingGlobal();\n'); f.git('add', 'public/good file.ts');
  f.write('public/good file.ts', 'export const value = 2;\n');
  assert.notEqual(f.commit().status, 0, 'unstaged repair must not hide a bad index');
  assert.match(f.git('show', ':public/good file.ts'), /missingGlobal/);
  assert.equal(readFileSync(join(f.dir, 'public/good file.ts'), 'utf8'), 'export const value = 2;\n');
  f.git('add', 'public/good file.ts');
  f.write('public/good file.ts', 'broken syntax !!!\n');
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(f.git('show', 'HEAD:public/good file.ts'), /value = 2/);
  assert.match(readFileSync(join(f.dir, 'public/good file.ts'), 'utf8'), /broken syntax/);
  f.git('restore', 'public/good file.ts'); f.git('mv', 'public/good file.ts', 'renamed file.mts');
  assert.equal(f.commit().status, 0);
  f.git('rm', 'renamed file.mts'); assert.equal(f.commit().status, 0);
  f.write('package.json', readFileSync(join(f.dir, 'package.json'), 'utf8') + '\n');
  assert.notEqual(f.node('scripts/git-gate.mts').status, 0, 'mismatched dependency declarations fail closed');
});

test('pre-push checks outgoing commit even when working tree repairs it; deletion is skipped', t => {
  const f = fixture(t);
  f.write('test/pass.test.mts', "import test from 'node:test';\ntest('fail', () => { throw new Error('outgoing regression'); });\n");
  f.git('add', '.'); f.git('commit', '-qm', 'bad test');
  const sha = f.git('rev-parse', 'HEAD').trim();
  f.write('test/pass.test.mts', "import test from 'node:test';\ntest('pass', () => {});\n");
  const push = (input: string) => spawnSync(join(f.dir, '.githooks/pre-push'), [], { cwd: f.dir, env: f.env, input, encoding: 'utf8' });
  const failed = push(`refs/heads/test ${sha} refs/heads/test ${'0'.repeat(40)}\n`);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /outgoing regression/);
  f.git('add', '.'); f.git('commit', '-qm', 'repair');
  const repaired = f.git('rev-parse', 'HEAD').trim();
  const passed = push(`refs/heads/test ${repaired} refs/heads/test ${sha}\n`);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(push(`(delete) ${'0'.repeat(40)} refs/heads/test ${sha}\n`).status, 0);
});

test('explicit hook installer is idempotent and preserves existing hooks and config', t => {
  const f = fixture(t), config = readFileSync(join(f.dir, '.git/config'));
  f.write('.git/hooks/pre-push', '#!/bin/sh\nexit 42\n');
  assert.notEqual(f.node('scripts/install-hooks.mts').status, 0);
  assert.equal(readFileSync(join(f.dir, '.git/hooks/pre-push'), 'utf8'), '#!/bin/sh\nexit 42\n');
  rmSync(join(f.dir, '.git/hooks/pre-push'));
  assert.equal(f.node('scripts/install-hooks.mts').status, 0);
  assert.equal(f.node('scripts/install-hooks.mts').status, 0);
  assert.deepEqual(readFileSync(join(f.dir, '.git/config')), config);
  f.git('config', 'core.hooksPath', 'custom-hooks');
  assert.notEqual(f.node('scripts/install-hooks.mts').status, 0);
});

test('installer refuses linked/shared worktrees without editing common config', t => {
  const f = fixture(t), linked = join(f.dir, 'linked');
  f.git('worktree', 'add', '-qb', 'linked', linked);
  const before = readFileSync(join(f.dir, '.git/config'));
  assert.notEqual(f.node('scripts/install-hooks.mts').status, 0);
  const result = spawnSync(process.execPath, ['scripts/install-hooks.mts'], { cwd: linked, env: f.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Shared worktrees/);
  assert.deepEqual(readFileSync(join(f.dir, '.git/config')), before);
});
