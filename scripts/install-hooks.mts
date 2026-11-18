// Explicit installation for a standalone clone only; never changes core.hooksPath.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
process.chdir(root);
if (git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length !== 1 ||
    resolve(git('rev-parse', '--git-dir')) !== resolve(git('rev-parse', '--git-common-dir'))) {
  throw new Error('Shared worktrees: use git -c core.hooksPath=.githooks commit/push. No configuration was changed.');
}
if (git('config', '--list').split('\n').some(line => line.toLowerCase().startsWith('core.hookspath='))) throw new Error('Existing core.hooksPath; preserve it and integrate hooks manually.');
const hooks = git('rev-parse', '--git-path', 'hooks');
mkdirSync(hooks, { recursive: true });
// Check both before writing either. Existing custom hooks are never overwritten.
for (const name of ['pre-commit', 'pre-push']) {
  const target = join(hooks, name), source = readFileSync(join('.githooks', name));
  if (existsSync(target) && !readFileSync(target).equals(source)) throw new Error(`Existing ${name}; integrate manually.`);
}
for (const name of ['pre-commit', 'pre-push']) {
  writeFileSync(join(hooks, name), readFileSync(join('.githooks', name)), { mode: 0o755 });
  chmodSync(join(hooks, name), 0o755);
}
console.log('Installed pre-commit and pre-push. No Git configuration changed.');
