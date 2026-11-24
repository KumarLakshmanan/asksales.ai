import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const where = jest.fn<any>();
const select = jest.fn(() => ({ from: () => ({ where }) }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { select } }));
const { projectMessageApprovalDecisions } = await import('../models/chatMessages/approvalProjection.js');
const message = { id: 1, metadata: { actionButtons: [
  { id: 'approve-review', action: 'approve_tool', data: { requestId: 'review:1', toolName: 'run_workflow' } },
  { id: 'reject-review', action: 'reject_tool', data: { requestId: 'review:1', toolName: 'run_workflow' } },
] } };

describe('durable approval projection on message reload', () => {
  beforeEach(() => { jest.clearAllMocks(); where.mockResolvedValue([]); });
  it('replaces a stale pending surface with the exact accepted approval', async () => {
    where.mockResolvedValue([{ requestId: 'review:1', toolName: 'run_workflow', decision: 'approve' }]);
    const [result] = await projectMessageApprovalDecisions(7, 178, [message]);
    expect(result.metadata).toEqual(expect.objectContaining({ actionResolution: {
      status: 'selected', selectedButtonId: 'approve-review', action: 'approve_tool', outcome: 'approved',
    } }));
    expect(message.metadata).not.toHaveProperty('actionResolution');
  });
  it('projects rejection without claiming approval', async () => {
    where.mockResolvedValue([{ requestId: 'review:1', toolName: 'run_workflow', decision: 'reject' }]);
    const [result] = await projectMessageApprovalDecisions(7, 178, [message]);
    expect(result.metadata).toEqual(expect.objectContaining({ actionResolution: expect.objectContaining({ selectedButtonId: 'reject-review', outcome: 'rejected' }) }));
  });
  it.each([
    { requestId: 'review:2', toolName: 'run_workflow', decision: 'approve' },
    { requestId: 'review:1', toolName: 'publish_ads', decision: 'approve' },
  ])('does not resolve another request or tool: %j', async receipt => {
    where.mockResolvedValue([receipt]);
    expect(await projectMessageApprovalDecisions(7, 178, [message])).toEqual([message]);
  });
  it('supports an identity stored on the original legacy message', async () => {
    where.mockResolvedValue([{ requestId: 'review:1', toolName: 'run_workflow', decision: 'approve' }]);
    const legacy = { metadata: { pendingApproval: { executionId: 'review:1', toolName: 'run_workflow' },
      actionButtons: [{ id: 'legacy-approve', action: 'LEAD_AGENT_APPROVE' }] } };
    const [result] = await projectMessageApprovalDecisions(7, 178, [legacy]);
    expect(result.metadata).toEqual(expect.objectContaining({ actionResolution: expect.objectContaining({ selectedButtonId: 'legacy-approve', outcome: 'approved' }) }));
  });
  it('does not query or invent decisions for unbound messages', async () => {
    const unbound = { metadata: { actionButtons: [{ id: 'approve', action: 'approve_tool' }] } };
    expect(await projectMessageApprovalDecisions(7, 178, [unbound])).toEqual([unbound]);
    expect(select).not.toHaveBeenCalled();
  });
});
