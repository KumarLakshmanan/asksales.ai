import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const countThread = jest.fn<any>();
const countAccount = jest.fn<any>();
const toolLoop = jest.fn<any>();
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: { countByUserAndThread: countThread, countByUser: countAccount } }));
jest.unstable_mockModule('../mastra/utils/toolCallingLoop.js', () => ({ runToolCallingLoop: toolLoop }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {
  emitAgentStatus: jest.fn(), emitChatResponse: jest.fn(), emitChatResponseChunk: jest.fn(),
} }));
const { createOutreachAgent } = await import('../mastra/agents/outreachAgent.js');
const { blockPrematureOutreach } = await import('../mastra/orchestrator.js');
const { runAndMergeSpecialistTurn } = await import('../mastra/orchestrator.js');
beforeEach(() => {
  jest.clearAllMocks(); countThread.mockResolvedValue(0); countAccount.mockResolvedValue(0);
  toolLoop.mockResolvedValue({ text: 'No outreach is recorded.', responseSource: 'server', toolResults: [] });
});
describe('Outreach read-only follow-ups before recipient approval', () => {
  it('prepares an imported audience as a separate draft without clearing an existing search review or exposing sends',async()=>{
    const state:any={userId:1,threadId:42,currentAgent:'lead_generation',messages:[{role:'user',content:'Prepare the imported audience for review only'}],
      requiresApproval:true,pendingApproval:{toolName:'execute_lead_workflow',executionId:'preserve-search'},agentPipeline:['lead_generation','outreach'],agentPipelineIndex:0,
      intentAnalysis:{action:'new_task',semanticRequest:{dashboardOperation:'campaign_prepare'}}};
    expect(blockPrematureOutreach(state,'outreach')).toBeNull();
    await runAndMergeSpecialistTurn(state,input=>createOutreachAgent().run(input));
    const options=toolLoop.mock.calls.at(-1)?.[0] as {tools:Record<string,unknown>};
    expect(Object.keys(options.tools).sort()).toEqual(['get_dashboard_operation','get_outreach_preparation_options','get_prepared_outreach','prepare_outreach_campaign']);
    expect(state.pendingApproval.executionId).toBe('preserve-search');expect(state.agentPipelineIndex).toBe(0);expect(state.currentAgent).toBe('lead_generation');
    expect(countThread).not.toHaveBeenCalled();expect(countAccount).not.toHaveBeenCalled();
  });
  it('restricts assistant diagnostics to its read tools, leaving sending and campaign mutation unavailable',async()=>{
    const state:any={userId:1,threadId:42,currentAgent:'outreach',messages:[{role:'user',content:'Check my assistant readiness'}],
      intentAnalysis:{action:'question',semanticRequest:{dashboardOperation:'assistant_diagnostics'}}};
    await createOutreachAgent().run(state);
    const options=toolLoop.mock.calls.at(-1)?.[0] as {tools:Record<string,unknown>};
    expect(Object.keys(options.tools).sort()).toEqual(['check_integration_status','query_assistant_diagnostics']);
    expect(countThread).not.toHaveBeenCalled();expect(countAccount).not.toHaveBeenCalled();
  });
  it('reaches queries across two turns with no leads and exposes no send or publication tools', async () => {
    const state: any = { userId: 1, threadId: 42, currentAgent: 'lead_generation', messages: [],
      intentAnalysis: { action: 'question' }, leadWorkflowExecuted: true, leadReviewApproved: false,
      agentPipeline: ['lead_generation', 'outreach'], selectedLeadIds: [],
    };
    for (const content of ['Which leads in this campaign have email addresses?', 'Have any WhatsApp messages been sent?']) {
      state.messages.push({ role: 'user', content });
      expect(blockPrematureOutreach(state, 'outreach')).toBeNull();
      const result = await createOutreachAgent().run(state);
      state.messages.push(...(result.messages || []));
      const options = toolLoop.mock.calls.at(-1)?.[0] as { tools: Record<string, unknown> };
      expect(options.tools.query_leads).toBeDefined();
      expect(options.tools.query_outreach_campaigns).toBeDefined();
      expect(options.tools.send_outreach_messages).toBeUndefined();
      expect(options.tools.publish_social_post).toBeUndefined();
    }
    expect(toolLoop).toHaveBeenCalledTimes(2);
    expect(countThread).not.toHaveBeenCalled();
  });
  it('still requires recipients for a new send-review request', async () => {
    await createOutreachAgent().run({ userId: 1, threadId: 42, messages: [{ role: 'user', content: 'Prepare outreach.' }],
      intentAnalysis: { action: 'new_task' },
    } as any);
    expect(toolLoop).not.toHaveBeenCalled();
    expect(countThread).toHaveBeenCalledWith(1, 42);
  });
  it.each([
    ['queue_review',['preview_outreach_retries','get_outreach_retry_preview']],
    ['customer_engagement',['query_campaign_customers','query_campaign_history']],
    ['report_export',['create_campaign_export','get_campaign_export']],
  ] as const)('exposes the supported %s operations without a customer-delivery tool',async(operation,expected)=>{
    await createOutreachAgent().run({userId:1,threadId:42,messages:[{role:'user',content:'Read the saved campaign operation.'}],
      intentAnalysis:{action:'question',semanticRequest:{dashboardOperation:operation}}} as any);
    const tools=(toolLoop.mock.calls.at(-1)?.[0] as {tools:Record<string,unknown>}).tools;
    for(const name of expected)expect(tools[name]).toBeDefined();
    expect(tools.send_outreach_messages).toBeUndefined();expect(tools.publish_social_post).toBeUndefined();expect(tools.prepare_outreach_campaign).toBeUndefined();
    expect(countThread).not.toHaveBeenCalled();
  });
  it('opens the review tools for exact selected CRM leads without requiring campaign ownership', async () => {
    const selectedLeadIds = [11, 22, 33, 44];
    await createOutreachAgent().run({ userId: 1, threadId: 42,
      messages: [{ role: 'user', content: 'Prepare WhatsApp outreach for exactly these selected leads; do not send yet.' }],
      selectedLeadIds, intentAnalysis: { action: 'new_task' },
    } as any);
    expect(toolLoop).toHaveBeenCalledTimes(1);
    const options = toolLoop.mock.calls[0][0] as { tools: Record<string, unknown> };
    expect(options.tools.send_outreach_messages).toBeDefined();
    expect(countThread).not.toHaveBeenCalled();
    expect(selectedLeadIds).toEqual([11, 22, 33, 44]);
  });
  it('answers readiness with an actual specialist while preserving Marcus’s pending search across turns', async () => {
    const state: any = { userId: 1, threadId: 210, currentAgent: 'lead_generation', messages: [],
      requiresApproval: true, pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'keep' },
      agentPipeline: ['lead_generation', 'outreach'], agentPipelineIndex: 0,
      intentAnalysis: { action: 'question' }, selectedLeadIds: [], leadReviewApproved: false };
    for (const content of ['Emily, is email connected?', 'And WhatsApp? Keep the search unapproved.']) {
      state.messages.push({ role: 'user', content });
      const update = await runAndMergeSpecialistTurn(state, input => createOutreachAgent().run(input));
      expect(update.actionButtons).toEqual([]);
      expect(state.currentAgent).toBe('lead_generation');
      expect(state.requiresApproval).toBe(true);
      expect(state.pendingApproval.executionId).toBe('keep');
      expect(state.agentPipelineIndex).toBe(0);
      expect(state.selectedLeadIds).toEqual([]);
      const options = toolLoop.mock.calls.at(-1)?.[0] as { tools: Record<string, unknown> };
      expect(options.tools.check_integration_status).toBeDefined();
      expect(options.tools.send_outreach_messages).toBeUndefined();
      expect(options.tools.tasks_completed).toBeUndefined();
    }
    expect(countThread).not.toHaveBeenCalled();
  });
});
