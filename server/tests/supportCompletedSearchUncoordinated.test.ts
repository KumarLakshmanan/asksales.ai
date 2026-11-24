import { beforeEach, expect, it, jest } from '@jest/globals';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withAssistantContext, type ResolvedAssistant } from '../services/assistants/AssistantContext.js';

let completed: any;
let graph: any;
const completedReads: any[] = [];
const execute = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ rows: [] });
const fixtureDb: any = {
  execute,
  transaction: async (callback: any) => callback(fixtureDb),
  select: () => ({ from: (table: any) => {
    let condition: SQL;
    const chain: any = { where: (query: SQL) => { condition=query; return chain; }, orderBy: () => chain,
      limit: async () => {
        const name = getTableName(table);
        if (name === 'support_playbook_runs') {
          const query = new PgDialect().sqlToQuery(condition);
          if (query.params.includes('completed')) { completedReads.push(query); return [completed]; }
          return [];
        }
        if (name === 'support_playbook_versions') return [{ graph }];
        return [];
      } };
    return chain;
  } }),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({ assertAssistantFresh: async () => undefined }));
const { playbookEngine } = await import('../services/agents/orchestration/PlaybookEngine.js');
const { currentSupportTurn } = await import('../services/agents/orchestration/SupportConversationTurn.js');
const { INDUSTRY_SUPPORT_PLAYBOOKS } = await import('../services/agents/orchestration/DefaultSupportConfiguration.js');
const { initializeJourneyState } = await import('../services/agents/orchestration/SupportJourneyRuntime.js');
const assistant = { provenance: { assistantId: 'qa-assistant', revision: 4, bindingId: 6,
  channel: 'whatsapp', surface: 'private' }, configuration: { playbooks: { mode: 'selected',
    assignments: [{ playbookId: 21, channel: 'whatsapp', surface: 'private' }] }, privacy: { permittedCollectionFields: [] } },
} as unknown as ResolvedAssistant;
beforeEach(() => {
  completedReads.length=0;
  graph=structuredClone(INDUSTRY_SUPPORT_PLAYBOOKS.find(item=>item.key==='hospitality-sales-enquiries-v2')!.graph);
  completed={ id:414, userId:9, conversationId:737, playbookId:21, playbookVersion:16,
    currentNodeId:'external-search-complete', status:'completed', state:{ ...initializeJourneyState(graph),
      agentType:'hotel_sales', assistantId:'qa-assistant', assistantRevision:4, assistantBindingId:6, deliveryStatus:'sent' } };
});
const resolve = (eventKey: string | undefined = 'message:7538') => withAssistantContext(assistant,()=>playbookEngine.resolve({
  userId:9,conversationId:737,channel:'whatsapp',agentType:'hotel_sales',intent:'booking_request',
  inboundText:'Actually, make that 3 adults instead.',eventKey,
  semanticRequest:{action:'booking',service:'stay',explicit:true,topicSwitch:false,pricingRequested:false,media:'none',confidence:0.99},
}));
it('reuses the completed search for the real WhatsApp path without coordinated-turn rollout', async()=>{
  expect(currentSupportTurn()).toBeUndefined();
  const result=await resolve();
  expect(result).toMatchObject({runId:414,nodeId:'completed-journey-follow-up',readOnlyInformation:true,
    completedJourneyFollowUp:true,publicBookingSearchFollowUp:true});
  expect(completedReads[0].params).toEqual(expect.arrayContaining([9,737,'completed']));
});
it('does not reuse a completed search from another binding', async()=>{
  completed.state.assistantBindingId=5;
  expect(await resolve()).toBeNull();
});
it('requires a durable inbound event outside coordinated execution', async()=>{
  expect(await resolve('')).toBeNull();
  expect(completedReads).toHaveLength(0);
});
