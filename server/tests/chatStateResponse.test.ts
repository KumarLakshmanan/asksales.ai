import { describe, expect, it } from '@jest/globals';
import { stateToResponse } from '../mastra/chatController.js';

describe('chat state response normalization', () => {
  it('never turns the latest user message or an older reply into a new assistant response', () => {
    const response = stateToResponse({
      userId: 7,
      threadId: 42,
      currentAgent: 'supervisor',
      messages: [
        { role: 'assistant', content: 'How can I help?', agentType: 'supervisor' },
        { role: 'user', content: 'I want the leads for my company' },
      ],
    } as never);

    expect(response.content).toBe('');
    expect(response.content).not.toBe('I want the leads for my company');
    expect(response.agentType).toBe('supervisor');
  });

  it('uses the assistant response produced after the latest user turn', () => {
    const response = stateToResponse({
      userId: 7,
      threadId: 42,
      currentAgent: 'lead_generation',
      messages: [
        { role: 'assistant', content: 'Older reply', agentType: 'supervisor' },
        { role: 'user', content: 'Find leads' },
        { role: 'assistant', content: 'I will find those leads.', agentType: 'lead_generation' },
      ],
    } as never);

    expect(response.content).toBe('I will find those leads.');
    expect(response.agentType).toBe('lead_generation');
  });

  it('returns an empty response when a routing-only state has no assistant message', () => {
    const response = stateToResponse({
      userId: 7,
      threadId: 42,
      currentAgent: 'supervisor',
      messages: [{ role: 'user', content: 'Find leads' }],
    } as never);

    expect(response.content).toBe('');
  });

  it('does not return provider infrastructure details in content or tool metadata', () => {
    const rawProviderError = 'Lightning dunning decision is deny for project: projects/740750721991';
    const response = stateToResponse({
      userId: 9,
      threadId: 141,
      currentAgent: 'icp_generation',
      messages: [
        { role: 'user', content: 'Create my ICP' },
        { role: 'assistant', content: rawProviderError, agentType: 'icp_generation' },
      ],
      toolResults: [{ toolName: 'generate_icp', success: false, error: rawProviderError }],
    } as never);

    expect(response.content).toBe('The AI service is temporarily unavailable. Please try this action again.');
    expect(response.metadata.toolResults[0].error).toBe(
      'The AI service is temporarily unavailable. Please try this action again.',
    );
    expect(JSON.stringify(response)).not.toContain('projects/740750721991');
    expect(JSON.stringify(response)).not.toContain('Lightning dunning');
  });
});
