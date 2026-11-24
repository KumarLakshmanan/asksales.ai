import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';

const saveMessage = jest.fn<any>();
jest.unstable_mockModule('../services/agents/MessageService.js', () => ({ MessageService: { saveMessage } }));

const { saveIntermediateResponses, stateToResponse } = await import('../mastra/chatController.js');
const { pipelinePauseAtTimeLimit, continuationPipelineAgent, CONTINUE_PIPELINE_MESSAGE } = await import('../mastra/orchestrator.js');
const { automaticPipelineRequest } = await import('../mastra/agents/BaseAgent.js');
const { announceExpiredApprovals, expiredApprovalMessage } = await import('../mastra/approvalExpiry.js');

beforeEach(() => { saveMessage.mockReset(); saveMessage.mockResolvedValue({ id: 1 }); });

describe('every reply of a resumed turn is saved', () => {
  it('saves all but the last reply, which the caller saves as the response', async () => {
    await saveIntermediateResponses(7, 9, [
      { agentType: 'content_studio', content: 'Alex finished the email template.' },
      { agentType: 'orchestrator', content: '   ' },
      { agentType: 'performance_marketing', content: 'Sarah prepared the ad review.' },
    ], { workflowResumed: true });
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 9, agentType: 'content_studio', content: 'Alex finished the email template.',
      metadata: expect.objectContaining({ workflowResumed: true }),
    }));
  });

  it('saves nothing extra for a single-reply turn', async () => {
    await saveIntermediateResponses(7, 9, [{ agentType: 'outreach', content: 'Done.' }]);
    expect(saveMessage).not.toHaveBeenCalled();
  });
});

describe('the turn time limit between pipeline steps', () => {
  const handedOver = (extra: Record<string, unknown> = {}) => ({
    messages: [{ role: 'user', content: 'Find leads then write the email' }, { role: 'assistant', content: 'Leads approved.' }],
    agentPipeline: ['lead_generation', 'content_studio'], agentPipelineIndex: 1, error: null,
    requiresApproval: false, pendingApproval: null, workflowOutcome: 'running', ...extra,
  }) as never;

  it('pauses with a continue button instead of reporting a timeout', () => {
    const pause = pipelinePauseAtTimeLimit(handedOver(), 'supervisor', 'lead_generation');
    expect(pause?.pendingAgent).toBe('content_studio');
    expect(pause?.message.content).toContain('has not started yet');
    expect(pause?.message.content).not.toMatch(/timed out/i);
    expect(pause?.actionButtons[0]).toMatchObject({ data: { message: CONTINUE_PIPELINE_MESSAGE, agentType: 'content_studio' } });
  });

  it('still reports a real timeout when a step failed, is awaiting approval, or nothing is waiting', () => {
    expect(pipelinePauseAtTimeLimit(handedOver({ error: 'boom' }), 'supervisor', 'lead_generation')).toBeNull();
    expect(pipelinePauseAtTimeLimit(handedOver({ requiresApproval: true }), 'supervisor', 'lead_generation')).toBeNull();
    expect(pipelinePauseAtTimeLimit(handedOver({ agentPipelineIndex: 2 }), 'supervisor', 'lead_generation')).toBeNull();
    expect(pipelinePauseAtTimeLimit(handedOver(), 'content_studio', 'lead_generation')).toBeNull();
  });

  it('routes a bare continue to the waiting step, not the specialist that finished', () => {
    const state = { agentPipeline: ['lead_generation', 'content_studio'], agentPipelineIndex: 1, currentAgent: 'lead_generation' } as never;
    expect(continuationPipelineAgent(state, { action: 'continue', needsClarification: false, nextAgent: null })).toBe('content_studio');
    expect(continuationPipelineAgent(state, { action: 'continue', needsClarification: false, nextAgent: 'content_studio' })).toBe('content_studio');
    expect(continuationPipelineAgent(state, { action: 'continue', needsClarification: false, nextAgent: 'outreach' })).toBeNull();
    expect(continuationPipelineAgent(state, { action: 'revise', needsClarification: false, nextAgent: null })).toBeNull();
    expect(continuationPipelineAgent({ ...(state as object), agentPipelineIndex: 0 } as never,
      { action: 'continue', needsClarification: false, nextAgent: null })).toBeNull();
  });

  it('gives the resumed step the original request on a continue turn only', () => {
    const base = { pipelineRequest: 'Find hotel leads and write the email.', agentPipelineIndex: 1,
      messages: [{ role: 'user', content: CONTINUE_PIPELINE_MESSAGE }] };
    expect(automaticPipelineRequest({ ...base, intentAnalysis: intentWith({}, { action: 'continue' }) } as never))
      .toBe('Find hotel leads and write the email.');
    expect(automaticPipelineRequest({ ...base, intentAnalysis: intentWith({}, { action: 'new_task' }) } as never)).toBeNull();
  });
});

describe('expired approvals', () => {
  it('posts a notice that retires the exact expired review', async () => {
    const save = jest.fn<any>().mockResolvedValue({ id: 55, createdAt: '2026-11-14T10:00:00Z' });
    const emit = jest.fn();
    await announceExpiredApprovals([{ id: 9, user_id: 7, tool_name: 'execute_lead_workflow', request_id: 'lead-input-set:4:2', agent_type: 'lead_generation' }], { save, emit });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, threadId: 9, agentType: 'lead_generation',
      metadata: { approvalExpired: true, cancelledApproval: { requestId: 'lead-input-set:4:2', toolName: 'execute_lead_workflow' } },
    }));
    expect(emit).toHaveBeenCalledWith(7, 9, expect.objectContaining({ id: 55, content: expiredApprovalMessage('execute_lead_workflow') }));
    expect(expiredApprovalMessage('execute_lead_workflow')).toContain('execute lead workflow review expired');
  });

  it('keeps sweeping when one notice cannot be saved', async () => {
    const save = jest.fn<any>().mockRejectedValueOnce(new Error('db')).mockResolvedValue({ id: 2, createdAt: new Date() });
    const emit = jest.fn();
    await announceExpiredApprovals([
      { id: 1, user_id: 7, tool_name: 'send_outreach_messages', request_id: 'a', agent_type: null },
      { id: 2, user_id: 7, tool_name: 'send_outreach_messages', request_id: 'b', agent_type: null },
    ], { save, emit });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('saved reply metadata', () => {
  it('keeps a bounded receipt of large tool outputs', () => {
    const response = stateToResponse({
      userId: 7, threadId: 9, currentAgent: 'lead_generation',
      messages: [{ role: 'user', content: 'Show leads' }, { role: 'assistant', content: 'Here they are.' }],
      toolResults: [{ toolName: 'query_leads', success: true, result: { success: true, output: { leads: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `Lead ${i}` })) } } }],
    } as never);
    const saved = JSON.stringify(response.metadata.toolResults);
    expect(saved.length).toBeLessThan(5000);
    expect(response.metadata.toolResults[0]).toMatchObject({ toolName: 'query_leads', success: true });
  });
});
