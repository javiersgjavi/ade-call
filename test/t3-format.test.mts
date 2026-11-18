import { testTool, type TestTool } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { t3Tools } from '../src/adapters/t3/tools.mjs';
import { formatFound, formatReceipt, formatThreadList } from '../src/adapters/t3/format.mjs';

const setup = (messages: { role: string; text: string }[]) => {
  const tools = new Map<string, TestTool>();
  for (const t of t3Tools({
    run: async () => ({ thread: { threadId: 'th', title: 'Revisión', status: 'completed', projectId: 'p', link: 'https://example.invalid/th', archived: false, extraField: 'kept' }, messages }),
    findThreads: () => ({ threads: [{ threadId: 'old', projectId: 'p', title: 'Pasado' }], total: 3, truncated: true, metadataOnly: true, searched: { field: 'thread_titles', projects: 1, catalogProjects: 2 }, projectsMatchingName: [{ id: 'p', name: 'Demo' }], note: 'Titles only' })
  })) tools.set(t.name, testTool(t));
  return async (name: string, params: Parameters<TestTool['execute']>[1]) => (await tools.get(name)!.execute('id', params)).content[0].text;
};

test('lists, searches and receipts state their limits in plain text', async () => {
  const list = formatThreadList({ checkedAt: 'T', scope: 'direct_children', subagents: 'requested', projects: [{ id: 'p', name: 'Demo' }],
    threads: [{ threadId: 'c', projectId: 'p', title: 'Hijo', status: 'running', statusVerified: false, parentThreadId: 'root', relationshipToParent: 'subagent' }],
    discovery: { complete: false, warnings: [{ code: 'thread_status_unavailable', threadId: 'c' }] } });
  assert.match(list, /Incomplete discovery/); assert.match(list, /Warning: thread_status_unavailable · c/);
  assert.match(list, /- "Hijo" · id c · project p · running, unverified · parent root \(subagent\)/);
  const found = await setup([])('t3_find_threads', { query: 'Pasado' });
  assert.match(found, /Scope: thread_titles, 1 of 2 projects/);
  assert.match(found, /Projects whose name matches:\n- Demo · id p/); assert.match(found, /Titles only/);
  assert.match(found, /1 of 3 \(trimmed\)/); assert.match(found, /does not confirm activity/);
  const receipt = formatReceipt({ status: 'delivered', delivery: 'queued', threadId: 'th', project: 'Demo', projectId: 'p', link: 'https://example.invalid/th', requestId: 'req-1', runId: null });
  assert.match(receipt, /^SEND ACCEPTED by T3 · queued: queued for the next turn/);
  assert.doesNotMatch(receipt, /Accepted does not mean/);
  assert.match(receipt, /not running yet/);
  const started = formatReceipt({ status: 'delivered', delivery: 'started' });
  assert.match(started, /T3 started a turn with the message/);
  assert.doesNotMatch(started, /finished/);
  const uncertain = formatReceipt({ status: 'uncertain', note: 'No confirmed receipt; do not repeat' });
  assert.match(uncertain, /^SEND uncertain/);
  assert.match(uncertain, /No confirmed receipt; do not repeat/);
  assert.match(formatReceipt({ status: 'delivered', delivery: 'unverified' }), /delivery mode not confirmed/);
});

test('search results show variants, state, similarity and that candidates never authorize sending', () => {
  const text = formatFound({ checkedAt: 'now', threads: [{ threadId: 'a', projectId: 'p', title: 'Old', state: 'archived', updatedAt: '2026-11-01', score: 1, matchedBy: 'written' }],
    searched: { field: 'thread_titles', projects: 1, catalogProjects: 1, queries: ['spoken', 'written'] }, projectsMatchingName: [] });
  assert.match(text, /Variants: "spoken", "written"/);
  assert.match(text, /"Old" · id a · project p · archived · updated 2026-11-01 · by "written"/);
  assert.doesNotMatch(text, /similarity/);
  const counted = formatFound({ checkedAt: 'now', threads: [], closedMatching: { count: 2 }, searched: { field: 'thread_titles', projects: 1, catalogProjects: 1, closed: false } });
  assert.match(counted, /1 of 1 projects, open only/); assert.match(counted, /2 closed threads .*also match.*includeClosed=true/);
  const closedNear = formatFound({ checkedAt: 'now', threads: [], closedMatching: { count: 0, approximate: 1 } });
  assert.match(closedNear, /^1 closed threads \(finished or archived\) are possible approximate matches \(imperfect transcription; confirm them before acting\) and are not shown\. Search them with includeClosed=true/m);
  assert.doesNotMatch(closedNear, /also match/);
  const near = formatFound({ checkedAt: 'now', threads: [], candidates: [{ threadId: 'b', projectId: 'p', title: 'Near', state: 'settled', score: 0.8 }],
    projectCandidates: [{ id: 'p', name: 'Demo', score: 0.9 }] });
  assert.match(near, /Approximate candidates .*they never authorize a send/);
  assert.match(near, /- project Demo · id p · similarity 0.9/); assert.match(near, /"Near" · id b · project p · finished \(settled\) · similarity 0.8/);
});
