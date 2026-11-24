/** Let Next observe query changes while preserving unrelated recovery ledgers. */
export function writeSupportQueryHistory(href: string, mode: 'push' | 'replace'): void {
  const state = { ...window.history.state };
  delete state.__NA;
  delete state._N;
  if (mode === 'push') window.history.pushState(state, '', href);
  else window.history.replaceState(state, '', href);
}
