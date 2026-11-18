// Execution is opt-in per request, never a persistent mode inherited from history.
export function currentUserTurn(history: { role: string; text: string }[]) {
  let end = history.length - 1;
  while (end >= 0 && history[end].role !== 'user') end--;
  let start = end;
  while (start > 0 && history[start - 1].role === 'user') start--;
  return history.slice(start, end + 1).map(h => h.text).join('').trim();
}

export function userTurnSince(history: { role: string; text: string }[], submittedThrough?: { role: string; text: string }) {
  const index = submittedThrough ? history.indexOf(submittedThrough) : -1;
  return currentUserTurn(history.slice(index + 1));
}
