import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.browser.json'], { stdio: 'inherit' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
mkdirSync('dist/public', { recursive: true });
for (const name of readdirSync('public')) {
  if (/\.(html|css|svg|png|ico)$/.test(name)) copyFileSync(`public/${name}`, `dist/public/${name}`);
}
