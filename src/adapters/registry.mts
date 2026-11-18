import type { Overview, Capabilities, DiscoveryAdapter, DiscoveryOptions, Project, ThreadReference, Snapshot } from '../shared/contracts.mjs';
import type { DirectAde } from '../direct/contract.mjs';
import { join } from 'node:path';
import { t3, t3Overview, t3Projects, t3OpenThreadIndex } from './t3/client.mjs';
import { overview, orcaProjects, orcaDiscovery } from './orca/client.mjs';
import { t3DirectAde } from '../direct/t3.mjs';
import { orcaDirectAde } from '../direct/orca.mjs';

// What the server needs to build an ADE's direct tools for one runtime.
export interface DirectOptions { snapshot: () => Pick<Snapshot, 'projects' | 'threads'> }
export interface Ade extends DiscoveryAdapter {
  id: string; name: string; theme: string; capabilities: Capabilities; limitation?: string;
  promptCatalog?: () => Project[]; promptThreads?: (projectIds: string[]) => ThreadReference[];
  overview: () => Promise<Overview>; readThread: typeof t3 | null; statePath: (state: string) => string;
  // The voice calls these tools directly. An ADE without it has no voice;
  // the page and the API say so.
  direct?: (options: DirectOptions) => DirectAde;
}

// Each adapter owns its protocol and capabilities. No fallback executor.
export const ades: Readonly<Record<string, Ade>> = Object.freeze({
  t3: Object.freeze({ id: 't3', name: 'T3', theme: 't3',
    capabilities: { listThreads: true, readThreadMessages: true, sendMessagesOnRequest: true },
    catalog: t3Projects, promptCatalog: t3Projects, promptThreads: t3OpenThreadIndex, overview: t3Overview, readThread: t3,
    statePath: (state: string) => join(state, 'ades', 't3'), direct: t3DirectAde }),
  orca: Object.freeze({ id: 'orca', name: 'Orca', theme: 'orca',
    capabilities: { listThreads: false, readThreadMessages: false, readTerminalOutput: true, startAgent: true, sendMessagesOnRequest: true },
    // The voice reads terminal output; Orca's CLI offers no structured chats to read.
    limitation: 'With Orca, the voice reads terminal output and sends to its agents; it does not read or continue its structured chats or notify when an agent finishes.',
    createDiscovery: orcaDiscovery, catalog: orcaProjects, overview: (options?: DiscoveryOptions) => overview(undefined, options), readThread: null,
    statePath: (state: string) => join(state, 'ades', 'orca'), direct: orcaDirectAde })
});
export function getAde(id = 't3') {
  if (!Object.hasOwn(ades, id)) throw new Error('Unknown ADE.');
  return ades[id];
}
export async function availability(adapter: { name: string; overview: () => Promise<{ discovery?: { complete: boolean } }> }) {
  try { const data = await adapter.overview(); return { state: data.discovery?.complete === false ? 'partial' : 'ready' }; }
  catch { return { state: 'unreachable', error: `${adapter.name} not available. Check its CLI and configuration.` }; }
}
