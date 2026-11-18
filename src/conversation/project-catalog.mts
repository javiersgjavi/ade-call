import type { Project, ThreadReference } from '../shared/contracts.mjs';

// Routing hints only: no activity, messages, filesystem scan or authorization.
export class ProjectCatalog {
  private value: { backend: string; status: string; checkedAt: string | null; projects: Pick<Project, 'id' | 'name'>[]; total: number; truncated: boolean;
    threads: ThreadReference[]; threadStatus: string; threadCheckedAt: string | null; threadTotal: number; threadsTruncated: boolean };
  constructor(private backend: string, private read?: () => Project[], private readThreads?: (projectIds: string[]) => ThreadReference[], private now = Date.now) {
    this.value = { backend, status: 'unavailable', checkedAt: null, projects: [], total: 0, truncated: false,
      threads: [], threadStatus: 'unavailable', threadCheckedAt: null, threadTotal: 0, threadsTruncated: false };
    this.snapshot({ refresh: true });
  }
  snapshot({ refresh = false } = {}) {
    if (!this.read || !refresh) return this.value;
    const now = this.now();
    let rows: Project[];
    try {
      rows = this.read();
      const projects: Pick<Project, 'id' | 'name'>[] = [];
      let bytes = 0;
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') throw new Error('Invalid catalog');
        const item = { id: row.id, name: row.name };
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (projects.length < 100 && bytes + size <= 12_000) { projects.push(item); bytes += size; }
      }
      this.value = { ...this.value, backend: this.backend, status: 'metadata_only', checkedAt: new Date(now).toISOString(), projects, total: rows.length, truncated: projects.length !== rows.length };
    } catch {
      this.value = { ...this.value, status: this.value.checkedAt ? 'stale' : 'unavailable', threadStatus: this.value.threadCheckedAt ? 'stale' : 'unavailable' };
      return this.value;
    }
    if (!this.readThreads) return this.value;
    try {
      const allowed = new Set(rows.map(p => p.id));
      const all = this.readThreads([...allowed]);
      const threads: ThreadReference[] = [];
      let bytes = 0;
      for (const row of all) {
        if (!allowed.has(row.projectId) || typeof row.threadId !== 'string' || !row.threadId || typeof row.title !== 'string') throw new Error('Invalid thread index');
        const item: ThreadReference = { threadId: row.threadId, projectId: row.projectId, title: row.title };
        if (typeof row.parentThreadId === 'string') item.parentThreadId = row.parentThreadId;
        if (typeof row.relationshipToParent === 'string') item.relationshipToParent = row.relationshipToParent;
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (threads.length < 100 && bytes + size <= 16_000) { threads.push(item); bytes += size; }
      }
      this.value = { ...this.value, threads, threadStatus: 'metadata_only', threadCheckedAt: new Date(now).toISOString(), threadTotal: all.length, threadsTruncated: threads.length !== all.length };
    } catch {
      this.value = { ...this.value, threadStatus: this.value.threadCheckedAt ? 'stale' : 'unavailable' };
    }
    return this.value;
  }
}
