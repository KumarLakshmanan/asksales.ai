import { semanticRequest } from './helpers/semanticIntent.js';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ToolLoopOptions } from '../mastra/utils/toolCallingLoop.js';
const loop = jest.fn<any>();
const brand = jest.fn<any>();
jest.unstable_mockModule('../mastra/utils/toolCallingLoop.js', () => ({ runToolCallingLoop: loop }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitAgentStatus: jest.fn(), emitChatResponse: jest.fn(), emitChatResponseChunk: jest.fn() } }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class extends Error {}, resolveContentBrandContext: brand,
  brandContextSnapshot: () => ({}), formatContentBrandContext: () => '',
}));
const { createContentAgent } = await import('../mastra/agents/contentAgent.js');
// Brand context is mandatory for generation turns; a failed lookup now pauses the turn.
beforeEach(() => { jest.clearAllMocks(); brand.mockResolvedValue({ brandToolkit: { id: 1, name: 'Brand' }, businessProfile: { id: 1, companyName: 'Company' } }); loop.mockResolvedValue({ text: 'Saved schedule checked.', responseSource: 'server', toolResults: [] }); });
describe('content management isolation', () => {
  const pending = { toolName: 'execute_lead_workflow', executionId: 'review-3', args: { selected_workflows: ['linkedin'] } };
  const state = (intentAnalysis: unknown): any => ({ userId: 7, threadId: 9, currentAgent: 'lead_generation', messages: [{ role: 'user', content: 'Show the scheduled post.' }],
    pendingApproval: pending, requiresApproval: true, intentAnalysis });
  it('revises an unexecuted generation review without treating its ID as an asset', async () => {
    const reviewState = state({ action: 'revise', contentManagementRequested: true, semanticRequest: semanticRequest({ contentOperation: 'revise_review', generationReviewId: 70, taskRelation: 'follow_up' }) });
    reviewState.messages = [{ role: 'user', content: 'Make that same LinkedIn post shorter. Keep it text-only. Update review #70 only.' }];
    reviewState.savedToolActions = [{ widgetId: 70, userId: 7, threadId: 9, toolName: 'generate_social_media_post', status: 'active', formValues: { platform: 'linkedin', auto_generate_image: false } }];
    await createContentAgent().run(reviewState);
    const call = loop.mock.calls[0][0] as Required<ToolLoopOptions>;
    expect(Object.keys(call.tools)).toEqual(['generate_social_media_post']);
    expect(call.onToolCall('edit_saved_content', { asset_id: 70 })).toBe(false);
    expect(call.onToolCall('publish_social_post', {})).toBe(false);
    expect(call.onToolCall('generate_social_media_post', {})).toBe(true);
    expect(call.systemPrompt).toContain('Review #70 has not executed');
  });
  it.each(['succeeded', 'cancelled', 'running'])('does not reinterpret a %s review as an editable generation card', async status => {
    const reviewState = state({ action: 'revise', contentManagementRequested: true, semanticRequest: semanticRequest({ contentOperation: 'revise_review', generationReviewId: 70, taskRelation: 'follow_up' }) });
    reviewState.messages = [{ role: 'user', content: 'Edit review #70.' }];
    reviewState.savedToolActions = [{ widgetId: 70, toolName: 'generate_social_media_post', status, formValues: {} }];
    await createContentAgent().run(reviewState);
    expect((loop.mock.calls[0][0] as Required<ToolLoopOptions>).tools).not.toHaveProperty('generate_social_media_post');
  });
  it('answers schedule questions without brand context, generation or disturbing a lead review owner', async () => {
    const result = await createContentAgent().run(state({ action: 'question', contentManagementRequested: true }));
    const call = loop.mock.calls[0][0] as Required<ToolLoopOptions>;
    expect(Object.keys(call.tools).sort()).toEqual(['check_integration_status', 'get_brandtoolkit', 'get_brandtoolkits', 'get_businessprofile', 'get_businessprofiles', 'query_content_assets', 'query_scheduled_posts']);
    expect(brand).not.toHaveBeenCalled();
    expect(result).toMatchObject({ currentAgent: 'lead_generation', requiresApproval: true, pendingApproval: pending, tasksCompleted: false, actionButtons: [] });
  });
  it('allows explicit saved-content management while withholding all generation and handoff tools', async () => {
    const result = await createContentAgent().run(state({ action: 'revise', contentManagementRequested: true }));
    const call = loop.mock.calls[0][0] as Required<ToolLoopOptions>;
    expect(Object.keys(call.tools).sort()).toEqual(['change_scheduled_post', 'edit_saved_content', 'query_content_assets', 'query_scheduled_posts']);
    expect(call.onToolCall('tasks_completed', {})).toBe(false);
    expect(result).toMatchObject({ currentAgent: 'lead_generation', pendingApproval: pending, tasksCompleted: false });
    expect(brand).not.toHaveBeenCalled();
  });
  it('does not let a cancellation turn reschedule, edit or generate even if the model tries', async () => {
    await createContentAgent().run(state({ action: 'cancel', cancellationScope: 'scheduled_post', contentManagementRequested: true }));
    const call = loop.mock.calls[0][0] as Required<ToolLoopOptions>;
    expect(Object.keys(call.tools).sort()).toEqual(['change_scheduled_post', 'query_content_assets', 'query_scheduled_posts']);
    expect(call.onToolCall('change_scheduled_post', { action: 'cancel' })).toBe(true);
    expect(call.onToolCall('change_scheduled_post', { action: 'reschedule' })).toBe(false);
    expect(call.onToolCall('edit_saved_content', {})).toBe(false);
    expect(call.onToolCall('generate_social_media_post', {})).toBe(false);
  });
  it('keeps publication review tools available when an existing asset must be located first', async () => {
    const publishState = state({ action: 'new_task', contentManagementRequested: true, semanticRequest: semanticRequest({ contentOperation: 'publish_new' }) });
    publishState.messages = [{ role: 'user', content: 'Locate the latest Instagram post and prepare a publication review. Keep it unpublished.' }];
    await createContentAgent().run(publishState);
    const call = loop.mock.calls[0][0] as Required<ToolLoopOptions>;
    expect(call.tools).toHaveProperty('query_content_assets');
    expect(call.tools).toHaveProperty('check_integration_status');
    expect(call.tools).toHaveProperty('publish_social_post');
  });
});
