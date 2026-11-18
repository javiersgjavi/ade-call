import type { Overview, ToolArguments, ToolDefinition } from '../shared/contracts.mjs';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { errorText, toolSchema } from '../resources.mjs';

// A page fits whole in a tool output (12 000 bytes, with room for the footer
// and header): nothing is cut from its middle, so nextOffset never skips text.
// Offsets count UTF-16 units, as before; a page never splits a character.
export const PAGE_BYTES = 10_000;
function pageEnd(text: string, offset: number) {
  let end = Math.min(offset, text.length), used = 0;
  while (end < text.length) {
    const char = String.fromCodePoint(text.codePointAt(end)!), size = Buffer.byteLength(char);
    if (used + size > PAGE_BYTES) break;
    used += size; end += char.length;
  }
  return end;
}

// Explicit project membership and canonical paths prevent access to the other
// ADE's private memory, the service state or arbitrary filesystem credentials.
export function documentTool({ id, overview }: { id: 't3' | 'orca'; overview: (signal?: AbortSignal) => Promise<Pick<Overview, 'projects'>> }): ToolDefinition<'t3_read_document' | 'orca_read_document'> {
  return { name: `${id}_read_document`, label: 'Read project document', ...toolSchema('read_document'),
    async execute(_call: string, { projectId, path, offset = 0 }: ToolArguments['t3_read_document'], signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (typeof path !== 'string' || isAbsolute(path) || !/\.(md|txt)$/i.test(path) || path.split(/[\\/]/).some(p => p.startsWith('.')) || /secret|credential|auth|token|config|conversation/i.test(path) || !Number.isSafeInteger(offset) || offset < 0) throw new Error(errorText('document.not_allowed'));
      const project = (await overview(signal)).projects.find(p => p.id === projectId);
      signal?.throwIfAborted();
      if (!project?.path) throw new Error(errorText('document.project_unavailable'));
      try {
        const root = realpathSync(project.path), file = realpathSync(join(root, path));
        const rel = relative(root, file);
        if (rel.split(/[\\/]/).some(p => p.startsWith('.')) || !/\.(md|txt)$/i.test(rel) || /secret|credential|auth|token|config|conversation/i.test(rel) || rel.startsWith('..') || isAbsolute(rel) || !statSync(file).isFile() || statSync(file).size > 1_000_000) throw new Error(errorText('document.out_of_scope'));
        const text = readFileSync(file, 'utf8');
        if (offset > text.length) throw new Error(errorText('document.offset_past_end'));
        const end = pageEnd(text, offset);
        return { content: [{ type: 'text', text: JSON.stringify({ content: text.slice(offset, end), nextOffset: end < text.length ? end : null }) }], details: {} };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        // Filesystem errors contain absolute paths: keep them out of tool outputs.
        if (code) {
          // eslint-disable-next-line preserve-caught-error -- Do not expose private filesystem paths.
          throw new Error(errorText(code === 'ENOENT' ? 'document.not_found' : code === 'EACCES' || code === 'EPERM' ? 'document.no_permission' : 'document.unreadable'));
        }
        throw error;
      }
    }
  } as ToolDefinition<'t3_read_document' | 'orca_read_document'>;
}
