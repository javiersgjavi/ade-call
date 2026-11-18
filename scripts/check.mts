// Local and CI entry point. No providers, browser smoke tests, or personal state.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
function files(dir = '.'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', '.venv', '.tools', '.ruff_cache', '__pycache__', 'dist'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.browser.json']);
run(process.execPath, ['node_modules/eslint/bin/eslint.js', '.', '--max-warnings=0']);
run('uv', ['run', '--locked', '--no-sync', 'ruff', 'check', '.']);
run('uv', ['run', '--locked', '--no-sync', 'ruff', 'format', '--check', '.']);
for (const file of files()) {
  if (file.endsWith('.sh') || file.startsWith('.githooks/')) run('bash', ['-n', file]);
  if (!file.endsWith('.md')) continue;
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(target)))) throw new Error(`Broken link in ${file}: ${target}`);
  }
  for (const match of text.matchAll(/```json\s*\n([\s\S]*?)```/g)) JSON.parse(match[1]);
}
if (!process.argv.includes('--fast')) {
  run(process.execPath, ['scripts/build.mts']);
  run(process.execPath, ['--test', ...files('dist/test').filter(f => f.endsWith('.test.mjs'))]);
  run(process.execPath, ['--test', 'dist/scripts/verify-hooks.mjs']);
  run('uv', ['run', '--locked', '--no-sync', 'python', 'test/project-sync_test.py']);
}
