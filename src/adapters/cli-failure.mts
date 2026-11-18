// Describe only facts from the process failure, never stderr, arguments or paths.
// Whether a mutation may have happened is decided by the dispatch journal.
export function cliFailure(ade: 'T3' | 'Orca', error: unknown) {
  const e = error as { code?: unknown; killed?: boolean } | null;
  const prefix = `${ade}: `;
  if (e?.code === 'ENOENT') return prefix + 'the CLI could not be started. Check its installation and the configured path; repeating the same query will not fix it.';
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return prefix + 'the CLI has no permission to run. Report the limit; do not try to get around permissions.';
  if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return prefix + 'the answer exceeded the output limit. If you were reading, reduce the scope or the amount requested; do not interpret the failure as an empty result.';
  if (e?.killed || e?.code === 'ETIMEDOUT') return prefix + 'the CLI did not finish in time. There is no confirmed result; this does not prove that the operation did not happen.';
  if (error instanceof SyntaxError) return prefix + 'the CLI returned an answer that could not be parsed as JSON. Check the CLI compatibility and status; do not infer content or success.';
  if (e?.code === 'ADE_REJECTED') return prefix + 'the CLI rejected the operation. Check the parameters and the state of the destination; do not assume a connection problem or a completed send.';
  return prefix + 'the CLI failed without a confirmed result. The cause is not verified; check its availability and the parameters. Do not infer that the destination does not exist.';
}
