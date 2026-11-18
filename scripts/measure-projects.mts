import type { DiscoveryAdapter } from '../src/shared/contracts.mjs';
// Read-only adapter timing; no server, provider calls, credentials or dispatch.
// --real uses the configured T3_BIN/T3CODE_HOME and ORCA_BIN.
import { ades } from '../src/adapters/registry.mjs';
import { Discovery } from '../src/adapters/discovery.mjs';
const real = process.argv.includes('--real');
if (process.argv.includes('--http')) {
  const { startupHarness } = await import('./measure-startup.mjs');
  const h = await startupHarness({ real });
  try {
    const start = performance.now();
    const catalog = await h.request('/api/projects?progressive=1');
    const full = await h.request('/api/projects');
    if (catalog.code !== 200 || full.code !== 200) throw new Error('Discovery failed');
    console.log(JSON.stringify({ simulation: !real, transport: 'isolated HTTP', backend: 't3',
      catalogMs: catalog.ms, fullMs: Math.round(performance.now() - start),
      projects: catalog.data.projects.length, spaces: full.data.workspaces.length,
      complete: full.data.discovery.complete }));
  } finally { await h.close(); }
} else for (const id of ['t3', 'orca']) {
  const adapter: DiscoveryAdapter = real ? ades[id] : { id, name: id, catalog: () => [{ id: 'demo', name: 'Demo', path: '' }],
    overview: async ({ projects } = {}) => { await new Promise(r => setTimeout(r, 1000));
      return { projects: projects!(), workspaces: [], threads: [], terminals: [], discovery: { complete: true } }; } };
  const discovery = new Discovery(adapter);
  const start = performance.now();
  const catalog = await discovery.progressive();
  const catalogMs = performance.now() - start;
  if (discovery.pending) await discovery.pending;
  const complete = await discovery.progressive(catalog.generation);
  console.log(JSON.stringify({ simulation: !real, backend: id, catalogMs: Math.round(catalogMs),
    fullMs: Math.round(performance.now() - start), projects: complete.projects.length,
    spaces: complete.workspaces.length, complete: complete.discovery?.complete }));
}
