import type { RouterOutput } from './routerSchema.js';

export interface SelectableLeadStrategy {
  id: string;
  title: string;
  channel: string;
}

/** Real catalog identities, never IDs inferred from user text or titles. */
export async function loadSelectableLeadStrategies(): Promise<SelectableLeadStrategy[]> {
  const { listWorkflowsForChannels } = await import('./tools/executors/leadExecutor.js');
  const catalog = await listWorkflowsForChannels(['linkedin', 'google_maps', 'instagram', 'facebook', 'twitter', 'justdial']);
  return Object.entries(catalog.workflows).flatMap(([channel, workflows]) => workflows.map(workflow => ({
    id: workflow.id, title: workflow.title, channel: channel === 'google' ? 'google_maps' : channel,
  })));
}

export function resolveLeadStrategyIntent(intent: RouterOutput, catalog: SelectableLeadStrategy[]):
  { kind: 'none' } | { kind: 'clarify'; response: string } | { kind: 'selected'; workflowIds: string[]; platforms: string[] } {
  const selection = intent.semanticRequest?.lead.strategySelection;
  // A catalog question, cancellation, or execution affirmation is not a new
  // strategy choice. This gate authorizes settings preparation only.
  if (!selection || selection.status === 'none' || !intent.leadSettingsRequested
    || intent.needsClarification || intent.leadCatalogRequested || intent.leadShortlistRequested
    || !['new_task', 'revise', 'continue'].includes(intent.action || '')
    || intent.nextAgent !== 'lead_generation' || intent.excludedAgents.includes('lead_generation')) return { kind: 'none' };
  const workflowIds = [...new Set(selection.workflowIds)];
  const entries = workflowIds.map(id => catalog.find(entry => entry.id === id));
  if (selection.status === 'ambiguous' || !workflowIds.length || entries.some(entry => !entry)
    || entries.some(entry => intent.leadChannels.length > 0 && !intent.leadChannels.includes(entry!.channel as RouterOutput['leadChannels'][number]))) {
    return { kind: 'clarify', response: 'Which exact lead strategy should I prepare? Please choose a strategy from the current catalog. Your previous selection and reviews are unchanged; no search has run.' };
  }
  return { kind: 'selected', workflowIds, platforms: [...new Set(entries.map(entry => entry!.channel))] };
}
