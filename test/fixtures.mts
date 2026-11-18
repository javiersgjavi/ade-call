// Partial protocol doubles deliberately implement only operations exercised by
// a test. Supplied fields remain checked; production never uses this assertion.
export type PartialDouble<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => (R extends Promise<infer U> ? Promise<PartialDouble<U>> : PartialDouble<R>)
  : T extends Map<infer K, infer V> ? Map<K, V>
  : T extends Set<infer U> ? Set<U>
  : T extends readonly (infer U)[] ? PartialDouble<U>[]
  : T extends object ? { [K in keyof T]?: PartialDouble<T[K]> } : T;
export function double<T>(value: PartialDouble<T>): T { return value as T; }
import type { ToolDefinition, ToolParameters, ToolResult } from '../src/shared/contracts.mjs';
export interface TestTool extends Omit<ToolDefinition, 'execute'> { execute(id: string, params: Partial<ToolParameters> & Record<string, unknown>): Promise<ToolResult> }
export function testTool(tool: ToolDefinition): TestTool { return { ...tool, execute: (id, params) => tool.execute(id, params as never) }; }
import type { DirectAde, DirectTool } from '../src/direct/contract.mjs';
// An invented ADE for engine tests: no T3 or Orca code involved.
export function fakeAde(tools: DirectTool[] = [], catalog = 'test CATALOG'): DirectAde {
  return { id: 'fake', name: 'Fake', tools, catalog: () => catalog,
    prompt: { role: 'the test projects. Your tools are those of the session.', target: 'thread', destination: 'Send to the thread the user names.',
      evidence: 'done means end of turn.', limits: 'you cannot stop work.', ids: 'use the IDs as is.' } };
}
