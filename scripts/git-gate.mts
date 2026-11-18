// Check the index (commit) or exact outgoing commits (push), never unstaged source.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
process.chdir(root);
const push = process.argv.includes('--push');
const revisions = push ? [...new Set(readFileSync(0, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(' ')[1]).filter(sha => !/^0+$/.test(sha)))] : [null];
for (const revision of revisions) {
  const temp = mkdtempSync(join(tmpdir(), 'ade-gate-'));
  try {
    if (revision) {
      execFileSync('git', ['archive', '--format=tar', revision, '-o', join(temp, 'tree.tar')]);
      execFileSync('tar', ['-xf', join(temp, 'tree.tar'), '-C', temp]);
      rmSync(join(temp, 'tree.tar'));
    } else {
      execFileSync('git', ['checkout-index', '--all', '--prefix=' + temp + '/']);
      execFileSync('git', ['diff', '--cached', '--check'], { stdio: 'inherit' });
    }
    // Dependencies are reused only when the snapshot declares the same environment.
    for (const file of ['package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock', '.python-version', '.node-version']) {
      if (!readFileSync(join(root, file)).equals(readFileSync(join(temp, file)))) {
        throw new Error(`${file} differs from the snapshot. Align it and run npm ci && uv sync --locked before retrying.`);
      }
    }
    symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
    symlinkSync(join(root, '.venv'), join(temp, '.venv'), 'dir');
    const env: NodeJS.ProcessEnv = { ...process.env, UV_PROJECT_ENVIRONMENT: join(root, '.venv') };
    // Git exports repository/index variables to hooks; do not leak them into fixture repos.
    for (const key of git('rev-parse', '--local-env-vars').split('\n')) delete env[key];
    const result = spawnSync(process.execPath, ['scripts/check.mts', ...(push ? [] : ['--fast'])], { cwd: temp, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  } finally { rmSync(temp, { recursive: true, force: true }); }
  if (process.exitCode) break;
}
