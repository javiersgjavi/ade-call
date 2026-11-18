// Waits, before the installer restarts the running service, for it to say it
// is idle: no call active or connecting in any ADE, and no tool still running.
// It asks every 5 seconds for at most 2 minutes, measured on a monotonic
// clock; each pause and each request is cut to the time left.
// Exit 0: idle. Exit 1: still in use when the time ran out. Exit 2: unknown
// (no main process, not reachable, no token, an unexpected answer).
//
// It asks the process that is running, never with the values exported for a
// new installation: the PORT, ADE_CALL_HOST and ADE_CALL_CONFIG of
// the main process's environment (/proc/PID/environ) say where it listens and
// which token it accepts. The administrator token is only sent once the
// listening TCP socket at that port is one of the main process's own file
// descriptors (/proc/net/tcp*, /proc/PID/fd), and only to the IP address of
// that socket, so no other process holding the port and no name resolution
// can receive it. Without /proc (not Linux) that cannot be checked and the
// answer is unknown.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, endianness } from 'node:os';
import { isIP } from 'node:net';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WAIT_MS = 120_000, EVERY_MS = 5_000, ASK_MS = 5_000;
export const IDLE = 0, BUSY = 1, UNKNOWN = 2;
export type Answer = typeof IDLE | typeof BUSY | typeof UNKNOWN;

// Asks until the service is idle or the answer is unknown, or until limitMs
// have passed on `now` while it is still in use. ask receives the time it may
// take; sleep, the pause. Neither exceeds the time left.
export async function waitWhileBusy({ ask, now, sleep, say = () => {}, limitMs = WAIT_MS, everyMs = EVERY_MS, askMs = ASK_MS }: {
  ask: (timeoutMs: number) => Promise<Answer>; now: () => number; sleep: (ms: number) => Promise<void>; say?: (text: string) => void;
  limitMs?: number; everyMs?: number; askMs?: number;
}): Promise<Answer> {
  const deadline = now() + limitMs;
  let first = true;
  for (;;) {
    const answer = await ask(Math.min(askMs, Math.max(0, deadline - now())));
    if (answer !== BUSY) return answer;
    if (first) { say('The service is in use (a call or a request is in progress): waiting up to 2 minutes for it to be free before restarting it.'); first = false; }
    const pause = Math.min(everyMs, deadline - now());
    // No time left for another request after the pause: it is still in use.
    if (deadline - now() - pause <= 0) return BUSY;
    await sleep(pause);
    if (deadline - now() <= 0) return BUSY;
  }
}

class Unknown extends Error {}
// The listening TCP sockets in /proc/net/tcp and tcp6: inode, address, port.
function listeners() {
  const found: { inode: string; address: string; port: number }[] = [];
  for (const [file, family] of [['/proc/net/tcp', 4], ['/proc/net/tcp6', 6]] as const) {
    let table: string;
    try { table = readFileSync(file, 'utf8'); } catch { if (family === 6) continue; throw new Unknown('/proc/net/tcp cannot be read'); }
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== '0A') continue;
      const [hex, port] = fields[1].split(':');
      // Each 32-bit word is printed in the kernel's byte order.
      const bytes = Buffer.from(hex, 'hex');
      if (endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
      const address = family === 4 ? [...bytes].join('.') : Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':');
      found.push({ inode: fields[9], address, port: parseInt(port, 16) });
    }
  }
  return found;
}
// The same address written in any IPv6 form.
function sameAddress(a: string, b: string) {
  const expand = (ip: string) => {
    if (isIP(ip) !== 6) return ip;
    const [head, tail = ''] = ip.split('::');
    const left = head ? head.split(':') : [], right = ip.includes('::') && tail ? tail.split(':') : [];
    const words = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return words.map(word => parseInt(word, 16)).join(':');
  };
  return expand(a) === expand(b);
}
// The IP address at which the main process itself listens on port. A wildcard
// listener is reached through loopback of its family.
export function verifiedAddress(pid: string, port: number, host: string) {
  const own = new Set<string>();
  let fds: string[];
  try { fds = readdirSync(`/proc/${pid}/fd`); } catch { throw new Unknown('the descriptors of the running service cannot be read'); }
  for (const fd of fds) {
    try { const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1]; if (inode) own.add(inode); } catch { /* Closed meanwhile. */ }
  }
  const sockets = listeners().filter(socket => socket.port === port && own.has(socket.inode));
  const literal = host.replace(/^\[(.*)\]$/, '$1');
  const wanted = isIP(literal) ? sockets.filter(socket => sameAddress(socket.address, literal)) : sockets;
  if (wanted.length !== 1) throw new Unknown(`the running service's main process is not the one listening on port ${port}`);
  const { address } = wanted[0];
  if (address === '0.0.0.0') return '127.0.0.1';
  if (sameAddress(address, '::')) return '::1';
  return address;
}

// One question to the main process of the running service.
export async function askService(pid: string, timeoutMs: number): Promise<Answer> {
  const active = new Map<string, string>();
  try {
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const equals = entry.indexOf('=');
      if (equals > 0) active.set(entry.slice(0, equals), entry.slice(equals + 1));
    }
  } catch { throw new Unknown('the environment of the running service cannot be read'); }
  // The same defaults as src/server.mts.
  const config = active.get('ADE_CALL_CONFIG') || join(active.get('HOME') || homedir(), '.config/ade-call');
  const port = Number(active.get('PORT') || 8787);
  const host = active.get('ADE_CALL_HOST') || '127.0.0.1';
  let token: string;
  try { token = readFileSync(join(config, 'access-token'), 'utf8').trim(); } catch { throw new Unknown('no access token in the ADE_CALL_CONFIG of the running service'); }
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Unknown('invalid token or port');
  const address = verifiedAddress(pid, port, host);
  const at = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
  let response: Response;
  const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
  try { response = await fetch(`http://${at}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal }); }
  catch { throw new Unknown(`no answer on ${at}`); }
  if (!response.ok) throw new Unknown(`HTTP ${response.status}`);
  let status: unknown;
  try { status = await response.json(); } catch { throw new Unknown('the answer is not JSON'); }
  const busy = status && typeof status === 'object' ? (status as { serviceBusy?: unknown }).serviceBusy : undefined;
  if (typeof busy !== 'boolean') throw new Unknown('the service is too old to report it');
  return busy ? BUSY : IDLE;
}

// The main process is looked up for every question: the service may have
// been restarted meanwhile. systemctl shares the question's time: a user
// manager that does not answer must not stretch the wait past its limit.
export async function ask(service: string, timeoutMs: number, now: () => number = () => performance.now()): Promise<Answer> {
  try {
    const started = now();
    const shown = spawnSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', service], { encoding: 'utf8', timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL' });
    if (shown.error || shown.signal) throw new Unknown('systemctl did not answer in time');
    const pid = shown.stdout?.trim() || '';
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Unknown('the main process of the running service is not known');
    const left = timeoutMs - (now() - started);
    if (left <= 0) throw new Unknown('no time left to ask the service');
    return await askService(pid, left);
  } catch (error) {
    console.error(`Could not ask the service whether it is in use: ${error instanceof Unknown ? error.message : String(error)}.`);
    return UNKNOWN;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = process.argv[2] || 'ade-call.service';
  let answer: Answer = UNKNOWN;
  try {
    answer = await waitWhileBusy({
      ask: timeoutMs => ask(service, timeoutMs),
      now: () => performance.now(),
      // The system sleep: a pause the installer's tests can observe.
      sleep: async ms => { spawnSync('sleep', [String(ms / 1000)]); },
      say: text => console.log(text)
    });
  } catch (error) { console.error(`Could not ask the service whether it is in use: ${String(error)}.`); }
  process.exit(answer);
}
