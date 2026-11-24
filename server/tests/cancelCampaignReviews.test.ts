import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const claim = jest.fn<any>();
const cancel = jest.fn<any>();
const audit = jest.fn<any>();
const emit = jest.fn<any>();
const clearPending = jest.fn<any>();
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({ clearPendingApprovalIfMatches: clearPending }));
jest.unstable_mockModule('../models/conversationToolApprovals/functions.js', () => ({ ConversationToolApprovalModel: { claim } }));
jest.unstable_mockModule('../models/widgetStates/functions.js', () => ({ WidgetStateModel: { cancelPendingForThreadForUser: cancel } }));
jest.unstable_mockModule('../models/conversationWorkflow/functions.js', () => ({ setConversationWorkflowActionStatus: audit }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitWidgetUpdate: emit } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { cancelCampaignReviews, cancelPendingCampaignApproval, retireLeadStrategyApproval } = await import('../mastra/cancelCampaignReviews.js');
const pending = { executionId: 'review-1', toolName: 'execute_lead_workflow', args: { platform: 'linkedin' }, message: 'Review' };

beforeEach(() => { jest.clearAllMocks(); });
describe('campaign-wide review cancellation', () => {
  it('passes an exact review identity to the scoped atomic cancellation', async () => {
    cancel.mockResolvedValue([{ id: 42 }]);
    expect(await cancelCampaignReviews(1, 184, 42)).toEqual([42]);
    expect(cancel).toHaveBeenCalledWith(1, 184, 42);
    expect(emit).toHaveBeenCalledWith(1, 184, { id: 42, status: 'cancelled' });
  });
  it('rejects malformed scoped identities without falling back to campaign-wide cancellation', async () => {
    await expect(cancelCampaignReviews(1, 184, NaN)).rejects.toThrow('Invalid review identity');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('retires an old execution approval before selecting another strategy', async () => {
    claim.mockResolvedValue({ approval: { decision: 'reject', status: 'rejected' } });
    expect(await retireLeadStrategyApproval(1, 184, pending)).toEqual({ requestId: 'review-1', toolName: 'execute_lead_workflow' });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
    expect(clearPending).toHaveBeenCalledWith(184, 1, 'review-1', 'execute_lead_workflow');
  });
  it('refuses to replace a strategy that is already executing', async () => {
    claim.mockResolvedValue({ approval: { decision: 'approve', status: 'running' } });
    await expect(retireLeadStrategyApproval(1, 184, pending)).rejects.toThrow('already been accepted');
    expect(clearPending).not.toHaveBeenCalled();
  });
  it('does not retire a different tool approval', async () => {
    expect(await retireLeadStrategyApproval(1, 184, { ...pending, toolName: 'publish_ads' })).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });
  it('rejects the exact tenant/thread pending identity without executing any tool', async () => {
    claim.mockResolvedValue({ claimed: true, approval: { decision: 'reject', status: 'rejected' } });
    expect(await cancelPendingCampaignApproval(1, 183, pending)).toEqual({ requestId: 'review-1', toolName: 'execute_lead_workflow' });
    expect(claim).toHaveBeenCalledWith({ userId: 1, threadId: 183, requestId: 'review-1', toolName: 'execute_lead_workflow', toolArgs: pending.args, approved: false });
  });
  it('does not falsely claim that a racing approval was stopped', async () => {
    claim.mockResolvedValue({ claimed: false, approval: { decision: 'approve', status: 'running' } });
    expect(await cancelPendingCampaignApproval(1, 183, pending)).toBeNull();
  });
  it('does not invent a request identity', async () => {
    expect(await cancelPendingCampaignApproval(1, 183, null)).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });
  it('broadcasts cancellation for every returned review even if an audit row fails', async () => {
    cancel.mockResolvedValue([{ id: 42, runId: 'run-1', actionId: 'a-1' }, { id: 43 }]);
    audit.mockRejectedValueOnce(new Error('old audit missing'));
    expect(await cancelCampaignReviews(1, 183)).toEqual([42, 43]);
    expect(cancel).toHaveBeenCalledWith(1, 183);
    expect(emit.mock.calls).toEqual([[1, 183, { id: 42, status: 'cancelled' }], [1, 183, { id: 43, status: 'cancelled' }]]);
  });
});
