import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';

const loop = jest.fn<any>();
const ground = jest.fn<any>();
jest.unstable_mockModule('../mastra/utils/toolCallingLoop.js', () => ({ runToolCallingLoop: loop }));
jest.unstable_mockModule('../mastra/utils/responseGrounding.js', () => ({ groundAgentResponse: ground }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitAgentStatus: jest.fn(), emitChatResponse: jest.fn(), emitChatResponseChunk: jest.fn() } }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class extends Error {},
  resolveContentBrandContext: async () => ({ brandToolkit: { id: 1, name: 'Brand' }, businessProfile: { id: 1, companyName: 'Company' } }),
  brandContextSnapshot: () => ({}), formatContentBrandContext: () => '',
}));

const { createContentAgent } = await import('../mastra/agents/contentAgent.js');
const { normalizeRouterDecision } = await import('../mastra/unifiedRouter.js');

beforeEach(() => {
  jest.clearAllMocks();
  ground.mockImplementation(async (_state: unknown, text: string) => text);
  loop.mockResolvedValue({ text: 'Model summary of the finished step.', responseSource: 'model', toolResults: [] });
});

const baseState = (): any => ({
  userId: 7, threadId: 9, currentAgent: 'content_studio',
  brandToolkit: { id: 1, name: 'Brand' }, companyProfile: { id: 1, companyName: 'Company' },
  messages: [{ role: 'assistant', content: 'Earlier reply', agentType: 'content_studio' }, { role: 'user', content: 'Write a LinkedIn post.' }],
});

describe('model calls that cannot change the outcome are skipped', () => {
  it('does not audit the fixed handoff message written after a confirmed content card', async () => {
    const state = { ...baseState(), agentPipeline: ['content_studio', 'outreach'], agentPipelineIndex: 0,
      widgetContinuation: { widgetId: 3, toolName: 'generate_email_template', success: true } };
    const update = await createContentAgent().run(state);
    expect(update.messages?.[0].content).toContain('approved generate email template action completed successfully');
    expect(ground).not.toHaveBeenCalled();
  });

  it('still audits an ordinary model-written content reply', async () => {
    await createContentAgent().run(baseState());
    expect(ground).toHaveBeenCalledTimes(1);
  });
});

describe('savedDataLookup routing flag', () => {
  it('is only false for a plain advice question', () => {
    expect(normalizeRouterDecision(intentWith({}, { action: 'question', savedDataLookup: false })).savedDataLookup).toBe(false);
    expect(normalizeRouterDecision(intentWith({}, { action: 'question' })).savedDataLookup).toBe(true);
    expect(normalizeRouterDecision(intentWith({}, { action: 'new_task', savedDataLookup: false })).savedDataLookup).toBe(true);
    expect(normalizeRouterDecision(intentWith({}, { action: 'question', savedDataLookup: false, needsClarification: true })).savedDataLookup).toBe(true);
  });

  it('stays true whenever the question is about saved records or status', () => {
    expect(normalizeRouterDecision(intentWith({ status: 'campaign_actions' }, { action: 'question', savedDataLookup: false })).savedDataLookup).toBe(true);
    expect(normalizeRouterDecision(intentWith({}, { action: 'question', savedDataLookup: false, contentManagementRequested: true })).savedDataLookup).toBe(true);
    expect(normalizeRouterDecision(intentWith({}, { action: 'question', savedDataLookup: false, hiredAgents: ['lead_generation'], nextAgent: 'lead_generation', leadShortlistRequested: true })).savedDataLookup).toBe(true);
  });
});
