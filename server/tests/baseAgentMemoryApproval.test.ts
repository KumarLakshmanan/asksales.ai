import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const loop = jest.fn<any>();
jest.unstable_mockModule('../mastra/utils/toolCallingLoop.js', () => ({ runToolCallingLoop: loop }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitAgentStatus: jest.fn(), emitChatResponse: jest.fn(), emitChatResponseChunk: jest.fn() } }));
const { createLeadAgent } = await import('../mastra/agents/leadAgent.js');
const { createPerformanceAgent } = await import('../mastra/agents/performanceAgent.js');
beforeEach(() => { loop.mockReset().mockResolvedValue({ text: 'Here is the answer.', toolResults: [] }); });
describe('specialist memory and approval lifecycle', () => {
  it('limits a paid-ad cancellation turn to lookups and the existing stop confirmation', async () => {
    const pending = { toolName: 'execute_lead_workflow', executionId: 'pending-search', args: {} };
    const result = await createPerformanceAgent().run({ userId: 1, threadId: 1, currentAgent: 'lead_generation',
      requiresApproval: true, pendingApproval: pending, messages: [{ role: 'user', content: 'Pause only the saved Meta campaign.' }],
      intentAnalysis: { action: 'cancel', cancellationScope: 'operation' } } as any);
    const call = loop.mock.calls[0][0] as Required<import('../mastra/utils/toolCallingLoop.js').ToolLoopOptions>;
    expect(Object.keys(call.tools).sort()).toEqual(['check_integration_status', 'query_ad_campaigns', 'stop_ads']);
    expect(call.onToolCall('publish_ads', {})).toBe(false);
    expect(call.onToolCall('tasks_completed', {})).toBe(false);
    expect(result).toMatchObject({ currentAgent: 'lead_generation', requiresApproval: true, pendingApproval: pending, tasksCompleted: false, actionButtons: [] });
  });
  it('does not turn an approved stop receipt into approval to advance another campaign step', async () => {
    const agent = createPerformanceAgent() as any;
    await agent.preProcess({ userId: 1, threadId: 1, messages: [], widgetContinuation: { toolName: 'stop_ads', success: true, widgetId: 55 } });
    expect(agent._handleToolCall('tasks_completed')).toBe(false);
    expect(agent._handleToolCall('publish_ads')).toBe(false);
  });
  it('exposes only existing-lead operations for shortlist refinement and preserves another review', async () => {
    const pending = { toolName: 'send_outreach_messages', executionId: 'review-outreach', args: {} };
    const agent = createLeadAgent() as any;
    const result = await agent.run({ userId: 1, threadId: 1, currentAgent: 'outreach',
      selectedLeadIds: [101, 104], leadWorkflowExecuted: true, leadReviewApproved: true,
      requiresApproval: true, pendingApproval: pending,
      messages: [{ role: 'user', content: 'Keep only hotel owners in this shortlist.' }],
      intentAnalysis: { action: 'revise', leadShortlistRequested: true } });
    const call = loop.mock.calls[0][0] as import('../mastra/utils/toolCallingLoop.js').ToolLoopOptions;
    expect(Object.keys(call.tools).sort()).toEqual(['get_lead_shortlist', 'query_leads', 'revise_lead_shortlist']);
    expect(result).toMatchObject({ currentAgent: 'outreach', requiresApproval: true, pendingApproval: pending, tasksCompleted: false });
    expect(result.actionButtons).toEqual([]);
  });
  it('prepares an exact selected strategy review while withholding execution and handoff tools', async () => {
    const agent = createLeadAgent() as any;
    const input = { userId: 1, threadId: 1, currentAgent: 'lead_generation',
      selectedWorkflows: ['linkedin'], messages: [{ role: 'user', content: 'Prepare search settings for my review only. Do not execute.' }],
      intentAnalysis: { action: 'revise', leadSettingsRequested: true } };
    loop.mockImplementation(async (options: any) => {
      expect(options.toolContext.selectedWorkflows).toEqual(['linkedin']);
      expect(options.tools.generate_lead_inputs).toBeDefined();
      expect(options.tools.execute_lead_workflow).toBeUndefined();
      expect(options.tools.tasks_completed).toBeUndefined();
      expect(options.systemPrompt).toContain('SETTINGS PREPARATION ONLY');
      expect(options.systemPrompt).toContain('linkedin');
      expect(options.onToolCall('execute_lead_workflow', {})).toBe(false);
      expect(options.onToolCall('tasks_completed', {})).toBe(false);
      const output = { schemas: [{ platform: 'linkedin', workflowId: 'linkedin' }], workflowIds: ['linkedin'], leadInputSetId: 'set-lg03', leadInputSetRevision: 2 };
      options.onToolResult('generate_lead_inputs', { success: true, output });
      return { text: 'Review the prepared search settings.', toolResults: [{ toolName: 'generate_lead_inputs', success: true, result: { success: true, output } }] };
    });
    const result = await agent.run(input);
    expect(result).toMatchObject({ selectedWorkflows: ['linkedin'], requiresApproval: true,
      pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'lead-input-set:set-lg03:2', args: { selected_workflows: ['linkedin'] } } });
    expect(result.leadWorkflowExecuted).not.toBe(true);
    expect(result.tasksCompleted).not.toBe(true);
    expect(result.actionButtons[0]).toMatchObject({ label: 'Approve & Run Search', data: { inputSetId: 'set-lg03', revision: 2 } });
  });
  it('requires a real receipt for paid review claims and preserves missing-creative and organic boundaries', () => {
    const prompt = createPerformanceAgent().buildSystemPrompt({ userId: 1, threadId: 1, messages: [] } as any);
    expect(prompt).toContain('Only a successful publish_ads tool receipt establishes that a review card exists');
    expect(prompt).toContain('explicitly state that no review card was created');
    expect(prompt).toContain('Do not start generating creative if the user prohibited it');
    expect(prompt).toContain('Organic Facebook or Instagram posts belong to Content Studio');
  });
  it('delivers memory to the provider loop and retains an unresolved review after Q&A', async () => {
    const agent = createLeadAgent() as any;
    agent.preProcess = async () => ({});
    agent.buildSystemPrompt = () => 'System instructions';
    agent.getTools = () => ({});
    agent.postProcess = async (_: unknown, result: unknown) => result;
    agent.buildReturnState = () => ({ requiresApproval: false, pendingApproval: null });
    agent.buildActionButtons = () => [];
    const pending = { toolName: 'execute_lead_workflow', executionId: 'review-3', args: {} };
    const result = await agent.run({ userId: 1, threadId: 1, currentAgent: 'lead_generation', messages: [{ role: 'user', content: 'Why these settings?' }], contextSummary: 'Never send outreach.', scratchpad: { lead_generation: ['Only hotels in Chennai.'] }, requiresApproval: true, pendingApproval: pending });
    expect(loop).toHaveBeenCalledTimes(1);
    const history = (loop.mock.calls[0][0] as any).messages;
    expect(history.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n')).toContain('Never send outreach.');
    expect(history.map((m: any) => m.content).join('\n')).toContain('Only hotels in Chennai.');
    expect(result).toMatchObject({ requiresApproval: true, pendingApproval: pending, tasksCompleted: false });
  });
  it('exposes only registered read-only tools for a question, never generation or pipeline completion', async () => {
    const agent = createLeadAgent() as any;
    agent.preProcess = async () => ({});
    agent.buildSystemPrompt = () => 'Explain only';
    agent.getTools = () => ({ query_leads: {}, generate_lead_inputs: {}, execute_lead_workflow: {}, tasks_completed: {} });
    agent.postProcess = async (_: unknown, result: unknown) => result;
    agent.buildReturnState = () => ({});
    agent.buildActionButtons = () => [];
    await agent.run({ userId: 1, threadId: 1, currentAgent: 'lead_generation', messages: [{ role: 'user', content: 'Why these settings?' }], intentAnalysis: { action: 'question' } });
    const call = loop.mock.calls[0][0] as { tools: Record<string, unknown> };
    expect(Object.keys(call.tools)).toEqual(['query_leads']);
  });
});
