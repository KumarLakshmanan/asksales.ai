import { describe, expect, it } from '@jest/globals';
import { loadSelectableLeadStrategies, resolveLeadStrategyIntent } from '../mastra/leadStrategyIntent.js';
import { intentWith, semanticRequest } from './helpers/semanticIntent.js';

const catalog = [
  { id: 'linkedin_company_search_employees', title: 'LinkedIn Company Employee Extraction', channel: 'linkedin' },
  { id: 'google_maps', title: 'Google Maps Business Search', channel: 'google_maps' },
];
const selected = (ids = ['linkedin_company_search_employees']) => intentWith({
  lead: { ...semanticRequest().lead, strategySelection: { status: 'selected', workflowIds: ids } },
}, { action: 'revise', leadSettingsRequested: true, nextAgent: 'lead_generation', hiredAgents: ['lead_generation'], leadChannels: ['linkedin'] });

describe('model-selected lead strategies', () => {
  it('binds exact catalog IDs and channels without broadening a narrowed choice', () => {
    expect(resolveLeadStrategyIntent(selected(), catalog)).toEqual({
      kind: 'selected', workflowIds: ['linkedin_company_search_employees'], platforms: ['linkedin'],
    });
  });

  it.each([[], ['invented_strategy'], ['google_maps'], ['linkedin_company_search_employees', 'google_maps']].map(ids => ({ ids })))(
    'asks for clarification for empty, invented or excluded choices: $ids', ({ ids }) => {
      expect(resolveLeadStrategyIntent(selected(ids), catalog).kind).toBe('clarify');
    },
  );

  it('does not silently choose the first option when the model reports ambiguity', () => {
    const intent = selected();
    intent.semanticRequest!.lead.strategySelection!.status = 'ambiguous';
    expect(resolveLeadStrategyIntent(intent, catalog).kind).toBe('clarify');
  });

  it.each([
    { action: 'question' }, { action: 'cancel' }, { needsClarification: true },
    { leadSettingsRequested: false }, { leadCatalogRequested: true }, { leadShortlistRequested: true },
    { nextAgent: 'outreach' }, { excludedAgents: ['lead_generation'] },
  ])('cannot turn a non-selection request into consent: %j', override => {
    expect(resolveLeadStrategyIntent({ ...selected(), ...override } as ReturnType<typeof selected>, catalog).kind).toBe('none');
  });

  it('does not interpret old state without the new semantic selection field as a choice', () => {
    const intent = selected();
    delete intent.semanticRequest!.lead.strategySelection;
    expect(resolveLeadStrategyIntent(intent, catalog).kind).toBe('none');
  });

  it('uses installed catalog identities and canonical Google Maps channels', async () => {
    const actual = await loadSelectableLeadStrategies();
    expect(actual).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'linkedin_company_search_employees', title: 'LinkedIn Company Employee Extraction', channel: 'linkedin' }),
      expect.objectContaining({ channel: 'google_maps' }),
    ]));
    expect(new Set(actual.map(entry => entry.id)).size).toBe(actual.length);
  });
});
