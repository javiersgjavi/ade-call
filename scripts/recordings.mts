import { join } from 'node:path';
import { homedir } from 'node:os';
import { Recordings } from '../src/voice/recordings.mjs';

const [command, id] = process.argv.slice(2);
if (command !== 'recover' || !id) {
  console.error('Usage: node dist/scripts/recordings.mjs recover ID (with the recording stopped)');
  process.exitCode = 1;
} else {
  const root = join(process.env.ADE_CALL_STATE || join(homedir(), '.local/share/ade-call'), 'recordings');
  console.log(JSON.stringify(await new Recordings(root).recover(id)));
}
