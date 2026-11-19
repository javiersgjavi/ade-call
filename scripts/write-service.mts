import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
const env = process.env as NodeJS.ProcessEnv & Record<'NODE_BIN' | 'T3CODE_HOME' | 'ADE_CALL_STATE' | 'ADE_CALL_CONFIG' | 'PATH', string>;
// Quote systemd values, including specifiers and ExecStart variable expansion.
const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
const execQuote = (value: string) => quote(value.replaceAll('$', '$$'));
// WorkingDirectory takes the path as is: systemd does not remove quotes there
// (it would read them as part of the path) and has no escape for a line
// break. Only specifiers are escaped. A path ending in a space or tab would
// be trimmed, and one ending in a backslash would continue onto the next
// line, so those end in "/." (the same directory).
const workingDirectory = (path: string) => {
  if (/[\r\n]/.test(path)) {
    console.error(`Cannot install from ${JSON.stringify(path)}: systemd cannot use a working directory with a line break in its path. Move or rename the checkout.`);
    process.exit(1);
  }
  const escaped = path.replaceAll('%', '%%');
  return /[\\ \t]$/.test(escaped) ? `${escaped}/.` : escaped;
};
const cwd = workingDirectory(process.cwd());
const settings: Record<string, string> = {
  PATH: `${dirname(env.NODE_BIN)}:${env.PATH}`,
  T3CODE_HOME: env.T3CODE_HOME,
  ADE_CALL_STATE: env.ADE_CALL_STATE,
  ADE_CALL_CONFIG: env.ADE_CALL_CONFIG,
  ADE_CALL_HOST: env.ADE_CALL_HOST || '127.0.0.1',
  PORT: env.PORT || '8787',
};
// T3_BIN is missing in an Orca-only installation (see install-user.sh).
for (const key of ['T3_BIN', 'ORCA_BIN', 'ADE_CALL_TIME_ZONE']) if (env[key]) settings[key] = env[key];
writeFileSync(join(homedir(), '.config/systemd/user/ade-call.service'), `[Unit]
Description=ADE Call
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${execQuote(env.NODE_BIN)} ${execQuote(join(process.cwd(), 'dist/src/server.mjs'))}
${Object.entries(settings).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')}
Restart=on-failure
RestartSec=5
UMask=0077
TimeoutStopSec=25

[Install]
WantedBy=default.target
`, { mode: 0o600 });
