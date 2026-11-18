import type { Overview, Project, DiscoveryAdapter } from '../shared/contracts.mjs';
// Full reads share only pending work. UI polling retains the latest generation;
// it is never used for model tool reads or dispatch authorization.
export class Discovery {
  adapter: DiscoveryAdapter; now: () => number; statusMaxAgeMs: number;
  generation: number; snapshot: Overview | null; catalogReady: Promise<Project[]> | null;
  pending: Promise<Overview> | null; last: { state: string; checkedAt: number; error?: string } | null;
  constructor(adapter: DiscoveryAdapter, { now = Date.now, statusMaxAgeMs = 20_000 } = {}) {
    this.adapter = adapter;
    this.now = now;
    this.statusMaxAgeMs = statusMaxAgeMs;
    this.pending = null;
    this.last = null;
    this.generation = 0;
    this.snapshot = null;
    this.catalogReady = null;
  }
  status() {
    if (this.pending || !this.last || this.now() - this.last.checkedAt >= this.statusMaxAgeMs)
      return { state: 'loading' };
    return { ...this.last, checkedAt: new Date(this.last.checkedAt).toISOString() };
  }
  async progressive(generation?: string | null) {
    // Polling a completed generation must not start another CLI scan.
    if (!generation || !this.generation) {
      this.read().catch(() => {});
    }
    await (this.catalogReady || this.pending);
    if (!this.snapshot) throw new Error(`${this.adapter.name} no disponible.`);
    return { ...this.snapshot, generation: String(this.generation), pending: !!this.pending };
  }
  read() {
    if (this.pending) return this.pending;
    this.generation++;
    this.snapshot = null;
    const reader = this.adapter.createDiscovery?.() || this.adapter;
    const catalog = reader.catalog;
    this.catalogReady = catalog ? Promise.resolve().then(() => catalog()).then(projects => {
      this.snapshot = { backend: this.adapter.id, projects, threads: [], workspaces: [], terminals: [],
        discovery: { complete: false, warnings: [] } };
      return projects;
    }) : null;
    const overview = (projects?: Project[]) => reader.overview({ ...(projects ? { projects: () => projects } : {}),
      onProgress: data => { this.snapshot = data; } });
    this.pending = (this.catalogReady ? this.catalogReady.then(overview) : Promise.resolve().then(() => overview())).then(data => {
      this.snapshot = data;
      this.last = { state: data.discovery?.complete === false ? 'partial' : 'ready', checkedAt: this.now() };
      return data;
    }, error => {
      if (this.snapshot) this.snapshot = { ...this.snapshot,
        discovery: { complete: false, warnings: [{ code: 'activity_unavailable' }] } };
      this.last = { state: 'unreachable', checkedAt: this.now(), error: `${this.adapter.name} not available. Check its CLI and configuration.` };
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
