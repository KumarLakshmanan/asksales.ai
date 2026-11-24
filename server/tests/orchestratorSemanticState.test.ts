import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const route = jest.fn<any>();
const cancelReviews = jest.fn<any>().mockResolvedValue([]);
const cancelApproval = jest.fn<any>().mockResolvedValue(null);
jest.unstable_mockModule('../mastra/cancelCampaignReviews.js', () => ({ cancelCampaignReviews: cancelReviews, cancelPendingCampaignApproval: cancelApproval }));
jest.unstable_mockModule('../mastra/unifiedRouter.js', () => ({ runUnifiedRouter: route }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitAgentStatus: jest.fn(), emitChatResponse: jest.fn(), emitOpenTab: jest.fn(), emitProgressStep: jest.fn(), emitAgentChanged: jest.fn(), emitHiredAgents: jest.fn() } }));
jest.unstable_mockModule('../models/chatMessages/functions.js', () => ({ createChatMessage: jest.fn<any>().mockResolvedValue({ id: 1 }) }));
const { routerLogic, runSupervisor, successfulToolOutput, validToolHandoff, checkAfterAgent, processMessage } = await import('../mastra/orchestrator.js');
const { ConversationRequestError } = await import('../services/ConversationRequestCoordinator.js');
const { routerOutputSchema } = await import('../mastra/routerSchema.js');
const makeState = () => ({ userId: 1, threadId: 100, currentAgent: 'lead_generation', messages: [{ role: 'assistant', content: 'Review these leads.' }, { role: 'user', content: 'continue' }], icpProfile: { fitScore: 80, revision: 2, approvedRevision: 2, approved: true }, agentPipeline: ['icp_generation', 'lead_generation', 'content_studio'], agentPipelineIndex: 1, pipelineRequest: 'Find leads then draft a post. Never publish.' } as any);
const output = (extra: object) => routerOutputSchema.parse({ intent: 'task', action: 'continue', hiredAgents: ['lead_generation', 'content_studio'], mode: 'hire_team', isAffirmative: true, isDomainMatch: true, nextAgent: 'lead_generation', navigationTarget: null, response: 'Understood', suggestAgents: false, recommendedAgents: [], ...extra });
beforeEach(() => { route.mockReset(); cancelReviews.mockReset().mockResolvedValue([]); cancelApproval.mockReset().mockResolvedValue(null); });
describe('semantic orchestration state transitions', () => {
  it.each(['uncertain', 'cancelled'])('propagates %s to the durable request coordinator', async code => {
    const error = new ConversationRequestError(code, 'Stop this turn at the recovery boundary');
    route.mockRejectedValue(error);
    await expect(processMessage(1,100,'Read the saved state',makeState())).rejects.toBe(error);
  });
  it('routes one-post cancellation without revoking unrelated reviews or clearing the plan', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'scheduled_post', hiredAgents: ['content_studio'], nextAgent: 'content_studio' }));
    const state = makeState();
    state.messages.at(-1).content = 'Cancel this scheduled Oral Circle post.';
    state.pendingApproval = { executionId: 'email-review' }; state.requiresApproval = true;
    state.savedToolActions = [{ widgetId: 42, status: 'active' }, { widgetId: 43, status: 'queued' }];
    const result = await routerLogic(state);
    expect(result).toMatchObject({ nextAgent: 'content_studio', stateUpdates: {} });
    expect(cancelReviews).not.toHaveBeenCalled(); expect(cancelApproval).not.toHaveBeenCalled();
    expect(state.agentPipelineIndex).toBe(1);
    expect(state.pendingApproval.executionId).toBe('email-review');
    expect(state.savedToolActions.map((a: any) => a.status)).toEqual(['active', 'queued']);
    state.intentAnalysis = output({ action: 'cancel', cancellationScope: 'scheduled_post' });
    state.tasksCompleted = true; state.routingDecisionConsumed = true;
    expect(checkAfterAgent('content_studio', state)).toBe('end');
    expect((await runSupervisor(state)).nextAgent).toBeNull();
  });
  it('asks for scope when a cancellation is unspecified, even if the classifier chose an agent', async () => {
    route.mockResolvedValue(output({ action: 'cancel', hiredAgents: ['content_studio'], nextAgent: 'content_studio' }));
    const state = makeState();
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: {} });
    expect(cancelReviews).not.toHaveBeenCalled(); expect(cancelApproval).not.toHaveBeenCalled();
    expect(state.messages.at(-1).content).toContain('Nothing has been cancelled');
  });
  it('cancels an exact selected review and preserves all others and the pipeline', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'review', cancellationReviewId: 'widget:42' }));
    cancelReviews.mockResolvedValue([42]);
    const state = makeState();
    state.savedToolActions = [{ widgetId: 42, status: 'active' }, { widgetId: 43, status: 'draft' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: {} });
    expect(cancelReviews).toHaveBeenCalledWith(1, 100, 42);
    expect(cancelApproval).not.toHaveBeenCalled();
    expect(state.savedToolActions.map((a: any) => a.status)).toEqual(['cancelled', 'draft']);
    expect(state.agentPipelineIndex).toBe(1);
  });
  it('asks when multiple reviews could match a cancellation', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'review' }));
    const state = makeState();
    state.savedToolActions = [{ widgetId: 42, status: 'active' }, { widgetId: 43, status: 'draft' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: {} });
    expect(cancelReviews).not.toHaveBeenCalled(); expect(cancelApproval).not.toHaveBeenCalled();
    expect(state.messages.at(-1).content).toContain('widget:42');
  });
  it('rejects the sole pending approval without stopping the plan', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'review', hiredAgents: [], nextAgent: null }));
    const state = makeState();
    state.pendingApproval = { executionId: 'review-5', toolName: 'execute_lead_workflow' };
    cancelApproval.mockResolvedValue({ requestId: 'review-5', toolName: 'execute_lead_workflow' });
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: { pendingApproval: null, requiresApproval: false } });
    expect(cancelReviews).not.toHaveBeenCalled();
    expect(state.agentPipelineIndex).toBe(1);
  });
  it('never routes unsupported running-operation cancellation into ordinary generation tools', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'operation', nextAgent: 'lead_generation' }));
    const state = makeState();
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: {} });
    expect(cancelReviews).not.toHaveBeenCalled(); expect(cancelApproval).not.toHaveBeenCalled();
    expect(state.messages.at(-1).content).toContain('nothing running or waiting for review');
    expect(state.messages.at(-1).content).not.toContain('have not stopped');
  });
  it('cancels the only unstarted review when an "operation" cancel has nothing running', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'operation', nextAgent: 'lead_generation', hiredAgents: ['lead_generation'] }));
    cancelApproval.mockResolvedValue({ requestId: 'lead-input-set:4:2', toolName: 'execute_lead_workflow' });
    const state = makeState();
    state.pendingApproval = { toolName: 'execute_lead_workflow', executionId: 'lead-input-set:4:2' }; state.requiresApproval = true;
    state.savedToolActions = [{ widgetId: 77, toolName: 'generate_lead_inputs', status: 'completed' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: { pendingApproval: null, requiresApproval: false } });
    expect(cancelApproval).toHaveBeenCalledTimes(1);
    expect(state.messages.at(-1).content).toContain('Cancelled that pending review');
  });
  it('still refuses to claim a stop when an operation is actually running', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'operation', nextAgent: 'lead_generation', hiredAgents: ['lead_generation'] }));
    const state = makeState();
    state.pendingApproval = { toolName: 'send_outreach_messages', executionId: 'other-review' };
    state.savedToolActions = [{ widgetId: 78, toolName: 'execute_lead_workflow', status: 'running' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: {} });
    expect(cancelApproval).not.toHaveBeenCalled(); expect(cancelReviews).not.toHaveBeenCalled();
    expect(state.messages.at(-1).content).toContain('have not stopped');
  });
  it('routes a paid-ad stop to the existing stop-review capability without cancelling the plan', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'operation', nextAgent: 'performance_marketing', hiredAgents: ['performance_marketing'] }));
    const state = makeState(); state.pendingApproval = { toolName: 'execute_lead_workflow', executionId: 'keep-review' };
    expect(await routerLogic(state)).toMatchObject({ nextAgent: 'performance_marketing', stateUpdates: {} });
    expect(cancelReviews).not.toHaveBeenCalled(); expect(cancelApproval).not.toHaveBeenCalled();
    expect(state.agentPipelineIndex).toBe(1);
  });
  it('allows explicit lead-settings preparation past an unrun widget without approving either action', async () => {
    route.mockResolvedValue(output({ action: 'continue', hiredAgents: ['lead_generation'], nextAgent: 'lead_generation', leadSettingsRequested: true }));
    const state = makeState();
    state.savedToolActions = [{ widgetId: 42, toolName: 'generate_social_media_post', status: 'active' }];
    state.selectedWorkflows = ['linkedin'];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: 'lead_generation', stateUpdates: {} });
    expect(state.savedToolActions[0].status).toBe('active');
    expect(state.selectedWorkflows).toEqual(['linkedin']);
    expect(state.agentPipelineIndex).toBe(1);
    expect(cancelReviews).not.toHaveBeenCalled();
    expect(cancelApproval).not.toHaveBeenCalled();
  });
  it('does not let a failed widget continuation invent repairs or advance the pipeline', async () => {
    const state = makeState();
    state.widgetContinuation = { widgetId: 46, toolName: 'generate_email_template', success: false };
    state.messages = [{ role: 'user', content: '[WIDGET_EXECUTION_COMPLETE — INTERNAL WORKFLOW CONTINUATION]' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: { workflowOutcome: 'failed', tasksCompleted: false } });
    expect(state.messages.at(-1).content).toContain('not retried');
    expect(route).not.toHaveBeenCalled();
  });
  it.each(['continue', 'revise', 'question'])('preserves the active pipeline on %s', async action => {
    route.mockResolvedValue(output({ action }));
    const state = makeState();
    const result = await routerLogic(state);
    expect(result).toMatchObject({ nextAgent: 'lead_generation', stateUpdates: {} });
    expect(state.agentPipelineIndex).toBe(1);
    expect(state.pipelineRequest).toContain('Never publish');
  });
  it('replaces a stale plan for a genuinely new single-agent task', async () => {
    route.mockResolvedValue(output({ action: 'new_task', hiredAgents: ['content_studio'], nextAgent: 'content_studio' }));
    expect((await routerLogic(makeState())).stateUpdates).toMatchObject({ agentPipeline: ['content_studio'], agentPipelineIndex: 0 });
  });
  it('keeps an unrun draft review pending when the user asks to continue', async () => {
    route.mockResolvedValue(output({ action: 'continue', hiredAgents: ['content_studio'], nextAgent: 'content_studio' }));
    const state = makeState();
    state.savedToolActions = [{ widgetId: 42, toolName: 'generate_social_media_post', status: 'active' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: { workflowOutcome: 'awaiting_approval' } });
    expect(state.messages.at(-1).content).toContain('Confirm and run');
    expect(state.agentPipelineIndex).toBe(1);
  });
  it('allows later work after the user shelves a review as a draft', async () => {
    route.mockResolvedValue(output({ action: 'continue', hiredAgents: ['performance_marketing'], nextAgent: 'performance_marketing' }));
    const state = makeState();
    state.savedToolActions = [{ widgetId: 42, toolName: 'generate_social_media_post', status: 'draft' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: 'performance_marketing' });
    expect(state.savedToolActions[0].status).toBe('draft');
    expect(state.messages.at(-1).content).toBe('continue');
  });
  it('routes a new recipient-campaign review while preserving an unrelated active content card', async () => {
    route.mockResolvedValue(output({ action: 'revise', hiredAgents: ['outreach'], nextAgent: 'outreach' }));
    const state = makeState();
    state.messages.at(-1).content = 'Also prepare WhatsApp outreach for the reviewed leads; do not send.';
    state.savedToolActions = [{ widgetId: 42, toolName: 'generate_social_media_post', status: 'active' }];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: 'outreach' });
    expect(state.savedToolActions[0].status).toBe('active');
  });
  it('does not advance an already-approved ICP or resume a pipeline after answering a question', async () => {
    const state = makeState();
    state.intentAnalysis = output({ action: 'question' });
    state.tasksCompleted = true;
    state.routingDecisionConsumed = true;
    expect(checkAfterAgent('icp_generation', state)).toBe('end');
    expect(checkAfterAgent('content_studio', state)).toBe('end');
    expect((await runSupervisor(state)).nextAgent).toBeNull();
  });
  it('stops further plan steps without pretending a review was cancelled', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'campaign', hiredAgents: [], nextAgent: null }));
    const state = makeState(); state.pendingApproval = { executionId: 'review-5' }; state.requiresApproval = true;
    state.deferredLeadReviewPipeline = ['lead_generation', 'outreach'];
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: { agentPipeline: [], deferredLeadReviewPipeline: [], workflowOutcome: 'cancelled' } });
    expect(state.pendingApproval.executionId).toBe('review-5');
    expect(state.messages.at(-1).content).toContain('could not be revoked');
  });
  it('honors a validated UI switch without asking the model to reclassify it', async () => {
    expect(await routerLogic(makeState(), 'content_studio')).toMatchObject({ nextAgent: 'content_studio', stateUpdates: { agentPipeline: ['content_studio'], agentPipelineIndex: 0 } });
    expect(route).not.toHaveBeenCalled();
  });
  it('revokes unrun review cards on cancellation without claiming running work was stopped', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'campaign', hiredAgents: [], nextAgent: null }));
    cancelReviews.mockResolvedValue([42]);
    const state = makeState();
    state.savedToolActions = [{ widgetId: 42, status: 'active' }, { widgetId: 43, status: 'running' }];
    const result = await routerLogic(state);
    expect(cancelReviews).toHaveBeenCalledWith(1, 100);
    expect(state.savedToolActions.map((action: any) => action.status)).toEqual(['cancelled', 'running']);
    expect(state.messages.at(-1).content).toContain('Cancelled 1 unrun review card');
    expect(state.messages.at(-1).content).toContain('separate stop/reconciliation');
    expect(result.stateUpdates.workflowOutcome).toBe('cancelled');
  });
  it('clears only an exactly rejected pending approval and projects its identity', async () => {
    route.mockResolvedValue(output({ action: 'cancel', cancellationScope: 'campaign', hiredAgents: [], nextAgent: null }));
    cancelApproval.mockResolvedValue({ requestId: 'review-5', toolName: 'execute_lead_workflow' });
    const state = makeState(); state.pendingApproval = { executionId: 'review-5', toolName: 'execute_lead_workflow' }; state.requiresApproval = true;
    expect(await routerLogic(state)).toMatchObject({ nextAgent: null, stateUpdates: { pendingApproval: null, requiresApproval: false, actionButtons: [] } });
    expect(state.messages.at(-1).metadata.cancelledApproval.requestId).toBe('review-5');
  });
  it('allows returning to the approval owner and blocks changing owner mid-review', async () => {
    const state = makeState(); state.pendingApproval = { executionId: 'review-5' }; state.requiresApproval = true;
    expect((await routerLogic(state, 'lead_generation')).nextAgent).toBe('lead_generation');
    expect((await routerLogic(state, 'content_studio')).nextAgent).toBeNull();
    expect(state.pendingApproval.executionId).toBe('review-5');
  });
  it('never replays a consumed decision and can resume an off-pipeline index-zero prerequisite', async () => {
    const state = makeState();
    state.routingDecisionConsumed = true;
    state.intentAnalysis = output({ nextAgent: 'performance_marketing' });
    state.messages = [{ role: 'assistant', content: 'Finished' }];
    state.agentPipeline = [];
    expect((await runSupervisor(state)).nextAgent).toBeNull();
    state.agentPipeline = ['lead_generation', 'content_studio']; state.agentPipelineIndex = 0;
    expect((await runSupervisor(state)).nextAgent).toBe('lead_generation');
    expect(route).not.toHaveBeenCalled();
  });
  it('normalizes both specialist receipt formats and enforces handoff approval gates', () => {
    for (const receipt of [
      { toolName: 'switch_agent', success: true, output: { target_agent: 'content_studio' } },
      { toolName: 'switch_agent', success: true, result: { success: true, output: { target_agent: 'content_studio' } } },
    ]) {
      const output = successfulToolOutput([receipt], 'switch_agent');
      expect(validToolHandoff(makeState(), output)).toBe('content_studio');
      expect(validToolHandoff({ ...makeState(), pendingApproval: { executionId: 'pending' } }, output)).toBeNull();
      expect(validToolHandoff({ ...makeState(), icpProfile: { approved: false } }, output)).toBeNull();
    }
    expect(successfulToolOutput([{ toolName: 'switch_agent', success: true, result: { requiresApproval: true, output: { target_agent: 'content_studio' } } }], 'switch_agent')).toBeNull();
  });
});
