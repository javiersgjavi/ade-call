import { testTool, type TestTool } from './fixtures.mjs';
import type { OrcaRun, Overview } from '../src/shared/contracts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orcaTools } from '../src/adapters/orca/tools.mjs';
import { OrcaDispatch } from '../src/adapters/orca/dispatch.mjs';
import { ades } from '../src/adapters/registry.mjs';

const catalog = () => ({ threads: [], projects: [{ name: 'P', path: '/p', id: 'p' }], workspaces: [{ id: 'p::/repo', projectId: 'p' }],
  terminals: [{ handle: 'term_1', worktreeId: 'p::/repo', agent: 'codex', connected: true, writable: true }] });
function setup(run: OrcaRun, readOverview: () => Promise<Overview> = async () => catalog()) {
  const state = mkdtempSync(join(tmpdir(), 'orca-tools-')), tools: Record<string, TestTool> = {};
  // The server passes its request ID to every call; begin() sets the next one.
  let requestId = '';
  for (const t of orcaTools({ state, run, readOverview })) { const tool = testTool(t); tools[t.name] = { ...tool, execute: (_id, params) => tool.execute(requestId, params) }; }
  return { state, tools, begin(id = 'request-1234') { requestId = id; },
    cleanup() { rmSync(state, { recursive: true, force: true }); } };
}
test('Orca surface only contains its own operations; the voice reaches them through its DirectAde', () => {
  const s = setup(async () => ({}));
  try { assert.deepEqual(Object.keys(s.tools).sort(), ['orca_list_projects', 'orca_read_terminal', 'orca_send_message', 'orca_start_agent']); }
  finally { s.cleanup(); }
  assert.equal(typeof ades.orca.direct, 'function');
  assert.doesNotMatch(ades.orca.limitation!, /not yet/);
});
test('terminal read validates ownership, bounds and passes cursor without mutation', async () => {
  const calls: string[][] = [], s = setup(async (args: string[]) => { calls.push(args); return { terminal: { text: 'output', nextCursor: 10 } }; });
  try {
    await assert.rejects(s.tools.orca_read_terminal.execute('', { projectId: 'other', terminal: 'term_1' }));
    await assert.rejects(s.tools.orca_read_terminal.execute('', { projectId: 'p', terminal: 'term_1', cursor: -1 }));
    await s.tools.orca_read_terminal.execute('', { projectId: 'p', terminal: 'term_1', cursor: 0 });
    assert.deepEqual(calls, [['terminal', 'read', '--terminal', 'term_1', '--limit', '12000', '--cursor', '0']]);
  } finally { s.cleanup(); }
});
test('send requires server identity and live agent; accepted receipts deduplicate across journal reopen', async () => {
  let mutations = 0;
  const s = setup(async () => { mutations++; return { send: { accepted: true, handle: 'term_1', prompt: { requestId: 'orca-request', observation: 'working' } } }; });
  const params = { projectId: 'p', terminal: 'term_1', message: 'Do the requested work' };
  try {
    await assert.rejects(s.tools.orca_send_message.execute('', params), /server's request identifier.*Nothing was sent/); assert.equal(mutations, 0);
    s.begin();
    const a = await s.tools.orca_send_message.execute('', params);
    const b = await s.tools.orca_send_message.execute('', params);
    assert.deepEqual(a, b); assert.equal(mutations, 1);
    assert.match(a.content[0].text, /Accepted does not mean finished/);
    await assert.rejects(s.tools.orca_send_message.execute('', { ...params, message: 'different' }));
  } finally { s.cleanup(); }
  const shell = setup(async () => { throw Error('must not execute'); }, async () => ({ ...catalog(), terminals: [{ ...catalog().terminals[0], agent: null as string | null }] }));
  try { shell.begin(); await assert.rejects(shell.tools.orca_send_message.execute('', params), /shell/); } finally { shell.cleanup(); }
});
test('ambiguous mutation blocks same and new IDs after restart; concurrent preflight cannot double-send', async () => {
  const state = mkdtempSync(join(tmpdir(), 'orca-journal-'));
  let attempts = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a = new OrcaDispatch(state), b = new OrcaDispatch(state);
  try {
    const first = a.dispatch('request-1111', 'p', { message: 'task' }, () => gate, async () => { attempts++; throw Error('lost reply'); });
    await assert.rejects(b.dispatch('request-2222', 'p', {}, async () => {}, async () => ({})), /uncertain/i);
    release(); await assert.rejects(first, /uncertain/i);
    await assert.rejects(b.dispatch('request-1111', 'p', { message: 'task' }, async () => {}, async () => ({})), /its delivery is uncertain: it may have arrived\. Nothing was sent now\. Do not repeat it/);
    assert.equal(attempts, 1);
  } finally { a.close(); b.close(); rmSync(state, { recursive: true, force: true }); }
});
test('launch uses explicit existing project workspace, provider/model and terminal surface; deduplicates', async () => {
  const calls: string[][] = [], s = setup(async (args: string[]) => { calls.push(args); return { worktreeId: 'p::/repo', outcome: { kind: 'terminal', handle: 'term_new' }, receipt: { detail: 'started' } }; });
  try {
    s.begin(); const params = { projectId: 'p', worktreeId: 'p::/repo', agent: 'codex', message: 'task', model: 'chosen-model', effort: 'high' };
    await s.tools.orca_start_agent.execute('', params); await s.tools.orca_start_agent.execute('', params);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['agent','launch','--worktree','id:p::/repo','--agent','codex','--surface','terminal','--prompt','task','--model','chosen-model','--effort','high']);
  } finally { s.cleanup(); }
});
test('missing durable receipt leaves unknown delivery and prevents a fresh retry', async () => {
  let count = 0;
  const s = setup(async () => { count++; return { send: { accepted: true, handle: 'term_1' } }; });
  try {
    const params = { projectId: 'p', terminal: 'term_1', message: 'task' };
    s.begin(); await assert.rejects(s.tools.orca_send_message.execute('', params), /uncertain/i);
    s.begin('request-5678'); await assert.rejects(s.tools.orca_send_message.execute('', params), /uncertain/i);
    assert.equal(count, 1);
  } finally { s.cleanup(); }
});

test('Orca catalog lookup avoids activity discovery and refreshes names', async () => {
  const calls: string[][] = [];
  let name = 'First';
  const s = setup(async args => { calls.push(args); return { repos: [{ id: 'p', displayName: name, path: '/p' }] }; }, async () => { throw Error('Must not discover activity'); });
  try {
    const first = (await s.tools.orca_list_projects.execute('', {})).content[0].text;
    assert.match(first, /- First · id p/);
    assert.match(first, /activity not queried/); assert.doesNotMatch(first, /terminal term_/);
    name = 'Renamed';
    const second = (await s.tools.orca_list_projects.execute('', { projectId: 'p' })).content[0].text;
    assert.match(second, /- Renamed · id p/);
    assert.deepEqual(calls, [['repo', 'list'], ['repo', 'list']]);
    await assert.rejects(s.tools.orca_list_projects.execute('', { projectId: 'missing' }), /not among the Orca projects/);
  } finally { s.cleanup(); }
  const broken = setup(async () => ({}));
  try { await assert.rejects(broken.tools.orca_list_projects.execute('', {}), /incompatible Orca version/); }
  finally { broken.cleanup(); }
});
test('Orca activity lookup scopes terminals and preserves partial discovery', async () => {
  const s = setup(async () => { throw Error('Unexpected CLI'); }, async () => ({
    ...catalog(), projects: [...catalog().projects, { id: 'other', name: 'Other', path: '/other' }],
    workspaces: [...catalog().workspaces, { id: 'other-space', projectId: 'other' }],
    terminals: [...catalog().terminals, { handle: 'other-terminal', worktreeId: 'other-space' }],
    discovery: { complete: false, warnings: [{ code: 'partial' }] }
  }));
  try {
    const scoped = (await s.tools.orca_list_projects.execute('', { projectId: 'p', includeActivity: true })).content[0].text;
    assert.match(scoped, /- P · id p/); assert.match(scoped, /workspace id p::\/repo/);
    assert.match(scoped, /terminal term_1/); assert.doesNotMatch(scoped, /other/);
    assert.match(scoped, /activity queried/); assert.match(scoped, /Incomplete discovery/);
    assert.match(scoped, /Warning: partial/);
    const all = (await s.tools.orca_list_projects.execute('', { includeActivity: true })).content[0].text;
    assert.match(all, /ORCA PROJECTS: 2/); assert.match(all, /terminal term_1/); assert.match(all, /terminal other-terminal/);
  } finally { s.cleanup(); }
});
test('Orca name search tolerates dictated names, accepts written variants and never hides the listing', async () => {
  const s = setup(async args => args[0] === 'repo' ? { repos: [{ id: 'web', displayName: 'atarazana-web', path: '/w' }, { id: 'api', displayName: 'billing-api', path: '/a' }] } : (() => { throw Error('Unexpected CLI'); })(),
    async () => ({ projects: [{ id: 'web', name: 'atarazana-web', path: '/w' }, { id: 'api', name: 'billing-api', path: '/a' }],
      workspaces: [{ id: 'web::/w', projectId: 'web', name: 'checkout v2' }, { id: 'api::/a', projectId: 'api', name: 'principal' }],
      terminals: [{ handle: 'term_web', worktreeId: 'web::/w', title: 'Whisper transcription', agent: 'codex' }, { handle: 'term_api', worktreeId: 'api::/a', title: 'shell' }],
      threads: [], discovery: { complete: true } }));
  try {
    // Spacing in a project name; only the matching project stays listed.
    const project = (await s.tools.orca_list_projects.execute('', { query: 'a tarazana web' })).content[0].text;
    assert.match(project, /Search "a tarazana web": 1 match\.\n {2}> project "atarazana-web" · id web/);
    assert.doesNotMatch(project, /billing-api/);
    // Spoken digits in a workspace name; the project name may complete it.
    const space = (await s.tools.orca_list_projects.execute('', { query: 'checkout uve dos', includeActivity: true })).content[0].text;
    assert.match(space, /> workspace "checkout v2" · id web::\/w/); assert.match(space, /terminal term_web/); assert.doesNotMatch(space, /term_api/);
    // Pronunciations are not interpreted; the written variant from the model is.
    const spoken = (await s.tools.orca_list_projects.execute('', { query: 'guisper', includeActivity: true })).content[0].text;
    assert.match(spoken, /no project, workspace or terminal name matches\. The full listing is shown; it does not prove absence\./);
    assert.match(spoken, /billing-api/);
    const written = (await s.tools.orca_list_projects.execute('', { query: 'guisper', variants: ['Whisper'], includeActivity: true })).content[0].text;
    assert.match(written, /> terminal "Whisper transcription" · id term_web · by "Whisper"/);
    // Small slips are approximate candidates that do not authorize sending.
    const near = (await s.tools.orca_list_projects.execute('', { query: 'biling api' })).content[0].text;
    assert.match(near, /approximate match(?:es)? .*never authorize a send/); assert.match(near, /> project "billing-api" · id api · similarity 0\.\d+/);
    // Without activity, workspaces are not compared and the note says so.
    assert.match((await s.tools.orca_list_projects.execute('', { query: 'checkout' })).content[0].text, /only compared with includeActivity/);
    await assert.rejects(s.tools.orca_list_projects.execute('', { query: ' ' }), /not valid|Invalid/);
    await assert.rejects(s.tools.orca_list_projects.execute('', { query: 'x', variants: [3] }), /not valid|Invalid/);
  } finally { s.cleanup(); }
});
test('Orca listing cannot authorize sending after a terminal disconnects', async () => {
  let connected = true, reads = 0;
  const s = setup(async () => { throw Error('Must not mutate'); }, async () => {
    reads++;
    return { ...catalog(), terminals: [{ ...catalog().terminals[0], connected }] };
  });
  try {
    await s.tools.orca_list_projects.execute('', { projectId: 'p', includeActivity: true });
    connected = false; s.begin();
    await assert.rejects(s.tools.orca_send_message.execute('', { projectId: 'p', terminal: 'term_1', message: 'task' }), /connected/);
    assert.equal(reads, 2);
  } finally { s.cleanup(); }
});

test('Orca text output: grouped listing, generic terminal rendering, redaction and receipt limits', async () => {
  const listing = setup(async () => { throw Error('Unexpected CLI'); }, async () => ({ ...catalog(), workspaces: [{ id: 'p::/repo', projectId: 'p', name: 'principal' }],
    terminals: [...catalog().terminals, { handle: 'term_2', worktreeId: 'p::/repo', agent: null, connected: true, writable: true }], discovery: { complete: false, warnings: [{ code: 'partial' }] } }));
  try {
    const text = (await listing.tools.orca_list_projects.execute('', { includeActivity: true })).content[0].text;
    assert.match(text, /^ORCA PROJECTS: 1 · activity queried\nIncomplete discovery/);
    assert.match(text, /- P · id p\n {2}· workspace "principal" id p::\/repo\n {4}- terminal term_1 · agent codex · connected\n {4}- terminal term_2 · shell \(no agent\) · connected/);
  } finally { listing.cleanup(); }
  const read = setup(async () => ({ terminal: { text: 'line 1\nkey sk-proj-secret0123456789abcdef\nline 3', nextCursor: 42 } }));
  try {
    const text = (await read.tools.orca_read_terminal.execute('', { projectId: 'p', terminal: 'term_1' })).content[0].text;
    assert.match(text, /^TERMINAL term_1 · project p · agent codex\nTerminal output, not structured chat messages/);
    assert.match(text, /terminal\.nextCursor: 42/); assert.match(text, /terminal\.text:\nline 1\nkey \[credential omitted\]\nline 3/);
    assert.doesNotMatch(text, /sk-secret|\\n/);
  } finally { read.cleanup(); }
  const send = setup(async () => ({ send: { accepted: true, handle: 'term_1', prompt: { requestId: 'orca-request' } } }));
  try {
    send.begin();
    const text = (await send.tools.orca_send_message.execute('', { projectId: 'p', terminal: 'term_1', message: 'task' })).content[0].text;
    assert.match(text, /^SEND ACCEPTED by Orca · terminal term_1 · project p\nRequest: request-1234/);
    assert.match(text, /receipt\.prompt\.requestId: orca-request/);
    assert.match(text, /Accepted does not mean finished/);
  } finally { send.cleanup(); }
});


test('Orca text preserves end cursors, false flags, zero values and terminal whitespace', async () => {
  const s = setup(async () => ({ terminal: { text: 'line 1\n  indented  \n', nextCursor: null, truncated: false, offset: 0 } }));
  try {
    const text = (await s.tools.orca_read_terminal.execute('', { projectId: 'p', terminal: 'term_1' })).content[0].text;
    assert.match(text, /terminal\.nextCursor: null/);
    assert.match(text, /terminal\.truncated: false/);
    assert.match(text, /terminal\.offset: 0/);
    assert.ok(text.endsWith('line 1\n  indented  \n'));
  } finally { s.cleanup(); }
});
