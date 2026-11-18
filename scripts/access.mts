import { join } from 'node:path';
import { homedir } from 'node:os';
import { BrowserAccess } from '../src/access/browsers.mjs';

const [command, ...args] = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!['--url', '--name', '--id'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error('Options: --url URL, --name NAME, --id ID.');
  options.set(args[i], args[i + 1]);
}
const access = new BrowserAccess(join(process.env.ADE_CALL_CONFIG || join(homedir(), '.config/ade-call'), 'browser-access.sqlite'));
try {
  switch (command) {
    case 'pair': {
      const result = access.createCode(options.get('--name') || 'My browser', options.get('--url'));
      console.log(JSON.stringify({ ...result, expiresAt: new Date(result.expiresAt).toISOString() }, null, 2)); break;
    }
    case 'list': console.log(JSON.stringify(access.list(), null, 2)); break;
    case 'revoke': {
      if (!options.get('--id')) throw new Error('Pass a browser\'s --id.');
      console.log(JSON.stringify({ revoked: access.revoke(options.get('--id')!) })); break;
    }
    case 'cancel-codes': access.cancelCodes(); console.log('Pending codes revoked.'); break;
    case 'configure': console.log(JSON.stringify({ origin: access.configure(options.get('--url') || '') })); break;
    default: throw new Error('Usage: npm run access -- pair --url https://your-host --name "My phone" | list | revoke --id ID | cancel-codes | configure --url URL');
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Access could not be configured.'); process.exitCode = 1; }
finally { access.close(); }
