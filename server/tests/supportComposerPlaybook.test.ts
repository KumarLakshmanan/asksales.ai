import { beforeEach, expect, it, jest } from '@jest/globals';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';
import { withAssistantContext, type ResolvedAssistant } from '../services/assistants/AssistantContext.js';
let graph: any;
let run: any;
const save = jest.fn();
const load = jest.fn();
const update = jest.fn();
const fixture: any = {
  execute: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ rows: [] }),
  update,
  select: () => ({ from: (table: any) => {
    const chain: any = { where: () => chain, orderBy: () => chain, limit: async () => {
      switch (getTableName(table)) {
        case 'support_playbook_runs': return [run];
        case 'support_playbooks': return [{ agentType: 'hotel_sales' }];
        case 'support_playbook_versions': return [{ graph }];
        default: throw new Error('Unexpected table');
      }
    } }; return chain;
  } }),
  transaction: async (callback: any) => callback(fixture),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: fixture }));
jest.unstable_mockModule('../services/agents/orchestration/SupportPreviewStore.js', () => ({ supportPreviewStore: { save, load } }));
const { INDUSTRY_SUPPORT_PLAYBOOKS } = await import('../services/agents/orchestration/DefaultSupportConfiguration.js');
const { initializeJourneyState } = await import('../services/agents/orchestration/SupportJourneyRuntime.js');
const { playbookEngine } = await import('../services/agents/orchestration/PlaybookEngine.js');
const { semanticIntent } = await import('./helpers/supportSemanticFixture.js');
beforeEach(() => {
  jest.clearAllMocks();
  graph = structuredClone(INDUSTRY_SUPPORT_PLAYBOOKS.find(item => item.key === 'hospitality-sales-enquiries-v2')!.graph);
  run = { id: 1, userId: 9, conversationId: 10, playbookId: 2, playbookVersion: 1,
    currentNodeId: 'collect-corporate', status: 'active',
    state: { ...initializeJourneyState(graph), agentType: 'hotel_sales' } };
  run.state.fields['journey.type'] = { value: 'corporate', status: 'collected', source: 'customer' };
});
it('reads the current customer journey but never advances it or saves preview state while drafting a spa reply', async () => {
  const before = structuredClone(run);
  const result = await playbookEngine.resolve({ userId: 9, conversationId: 10, channel: 'whatsapp',
    agentType: 'hotel_sales', inboundText: 'I would like to book a spa slot.',
    semanticRequest: semanticIntent('booking', 'spa', { topicSwitch: true }),
    contactAvailable: true, dryRun: true, readOnlyDraft: true });
  expect(result?.nodeId).toBe('collect-spa-request');
  expect(run).toEqual(before);
  expect(update).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

function boundAssistant(): ResolvedAssistant {
  const configuration = emptyAssistantDraft();
  configuration.agentType = 'hotel_sales';
  configuration.playbooks = { mode: 'selected', assignments: [
    { playbookId: 2, channel: 'whatsapp', surface: 'private', intent: null, priority: 100 },
  ] };
  const provenance = { assistantId: '00000000-0000-4000-8000-000000000001', revision: 1,
    bindingId: 200, bindingVersion: 1, businessProfileId: 22,
    accountId: 'fixture-whatsapp', channel: 'whatsapp' as const, surface: 'private' as const };
  Object.assign(run.state, { assistantId: provenance.assistantId, assistantRevision: provenance.revision,
    assistantBindingId: provenance.bindingId });
  return { provenance, configuration, preview: true };
}
const outstandingPrompt = () => playbookEngine.getOutstandingCollectPrompt({
  userId: 9, conversationId: 10, agentType: 'hotel_sales',
});

it('explicit None cannot reuse a named assistant journey even if stale assignments remain', async () => {
  const assistant = boundAssistant();
  assistant.configuration.playbooks.mode = 'none';
  expect(await withAssistantContext(assistant, outstandingPrompt)).toBeNull();
});

it('does not reuse a prompt from an earlier binding of the same assistant and revision', async () => {
  const assistant = boundAssistant();
  run.state.assistantBindingId = 199;
  expect(await withAssistantContext(assistant, outstandingPrompt)).toBeNull();
});

it('does not reuse an intake assigned only to another channel', async () => {
  const assistant = boundAssistant();
  assistant.configuration.playbooks.assignments[0].channel = 'email';
  expect(await withAssistantContext(assistant, outstandingPrompt)).toBeNull();
});

it('retains an outstanding prompt for the exact current assistant binding and permitted playbook', async () => {
  const assistant = boundAssistant();
  expect(await withAssistantContext(assistant, outstandingPrompt)).toEqual(expect.any(String));
});

it('draft resolution ignores an old binding without advancing it or falling back to business assignments', async () => {
  const assistant = boundAssistant();
  run.state.assistantBindingId = 199;
  const before = structuredClone(run);
  const result = await withAssistantContext(assistant, () => playbookEngine.resolve({
    userId: 9, conversationId: 10, channel: 'whatsapp', agentType: 'hotel_sales',
    inboundText: 'Continue my enquiry', intent: 'faq', dryRun: true, readOnlyDraft: true,
  }));
  expect(result).toBeNull();
  expect(run).toEqual(before);
  expect(update).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  const dialect = new PgDialect();
  expect(fixture.execute.mock.calls.some(([statement]: any[]) =>
    dialect.sqlToQuery(statement).sql.includes('FROM support_playbook_assignments'))).toBe(false);
});
