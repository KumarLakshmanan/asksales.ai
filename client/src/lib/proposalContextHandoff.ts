import { creatorSessionScope } from './creator-session';
const storageKey = (id: string) => `proposal-context:${creatorSessionScope()}:${id}`;

/** Keep long requirements out of navigation URLs and request-header limits. */
export function proposalContextQuery(context: string): { context?: string; contextKey?: string } {
  if (context.length <= 1000) return { context };
  const contextKey = crypto.randomUUID();
  sessionStorage.setItem(storageKey(contextKey), context.slice(0, 10000));
  return { contextKey };
}
export function readProposalContext(params: URLSearchParams): string {
  if (params.has('context')) return (params.get('context') || '').slice(0, 10000);
  const id = params.get('contextKey');
  if (!id) return '';
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid proposal context reference.');
  const context = sessionStorage.getItem(storageKey(id));
  if (context === null) throw new Error('The proposal requirements are unavailable in this browser session. Open the editor from the campaign again.');
  return context.slice(0, 10000);
}
