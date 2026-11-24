import { describe, expect, it } from '@jest/globals';
import { buildCampaignActionStatus, reviewedOutreachLeadIds, type PendingExecutionApprovalLedger } from '../mastra/campaignActionStatus.js';

describe('durable campaign action status in chat', () => {
  it('lists exact saved tool identity and never relabels a template as a send', () => {
    const status = buildCampaignActionStatus([
      { id: 60, toolName: 'generate_email_template', agentType: 'content_studio', status: 'active' },
      { id: 62, toolName: 'send_outreach_messages', agentType: 'outreach', status: 'active', formValues: { channel: 'email' } },
      { id: 61, toolName: 'send_outreach_messages', agentType: 'outreach', status: 'failed', executionError: 'No WhatsApp provider configured' },
    ]);
    expect(status).toContain('review #60: generate_email_template');
    expect(status).toContain('review #62: send_outreach_messages, channel email');
    expect(status).toContain('review #61: send_outreach_messages');
    expect(status).not.toContain('No active or saved-draft review');
    expect(status).toContain('does not by itself prove provider delivery');
  });

  it('limits stored-send checks to exact outreach review recipients', () => {
    const widgets = [
      { id: 60, toolName: 'generate_email_template', agentType: 'content_studio', status: 'active', formValues: { lead_ids: [999] } },
      { id: 62, toolName: 'send_outreach_messages', agentType: 'outreach', status: 'active', formValues: { lead_ids: [1230, 1232] } },
    ];
    expect(reviewedOutreachLeadIds(widgets)).toEqual([1230, 1232]);
    expect(buildCampaignActionStatus(widgets, [])).toContain('Outreach delivery counts unavailable');
    expect(buildCampaignActionStatus(widgets, [{ channel: 'email', status: 'sent', count: 1 }]))
      .not.toContain('sent: 1');
  });
});

describe('pending execution approval ledger separate from widget reviews', () => {
  const metadata = () => ({
    pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'approval-223:run-1',
      args: { secret: 'PRIVATE_ARGUMENT', leadIds: [9991] }, message: 'PRIVATE_APPROVAL_MESSAGE' },
    pendingApprovalOwner: { requestId: 'approval-223:run-1', agentType: 'lead_generation' },
  });

  it('shows the legacy Approve Run gate even when no widget exists and no requiresApproval flag is saved', () => {
    const text = buildCampaignActionStatus([], undefined, { status: 'available', metadata: metadata() });
    expect(text).toContain('Pending execution approval (separate from widget reviews): tool execute_lead_workflow, request ID approval-223:run-1, owner lead_generation — awaiting approval.');
    expect(text).toContain('No active or saved-draft review cards');
    expect(text).not.toContain('No pending execution approval');
    for (const hidden of ['PRIVATE_ARGUMENT', 'PRIVATE_APPROVAL_MESSAGE', '9991', 'secret', 'leadIds']) expect(text).not.toContain(hidden);
  });

  it('lists widget reviews and the execution approval independently', () => {
    const text = buildCampaignActionStatus([
      { id: 42, toolName: 'generate_email_template', agentType: 'content_studio', status: 'active' },
    ], undefined, { status: 'available', metadata: metadata() });
    expect(text).toContain('review #42: generate_email_template');
    expect(text).toContain('Pending execution approval (separate from widget reviews)');
    expect(text).toContain('tool execute_lead_workflow');
  });

  it.each([{}, { pendingApproval: null, requiresApproval: false }])('reports none only from successfully read, consistent metadata: %j', value => {
    expect(buildCampaignActionStatus([], undefined, { status: 'available', metadata: value }))
      .toContain('No pending execution approval is recorded in the freshly read conversation metadata');
  });

  it.each<PendingExecutionApprovalLedger | undefined>([
    undefined, { status: 'unavailable' },
    ...[undefined, null, [], 'PRIVATE_BAD_METADATA', { requiresApproval: true },
      { requiresApproval: 'false' }, { pendingApproval: false }, { pendingApproval: [] },
      { pendingApproval: {} }, { pendingApproval: { toolName: 'execute_lead_workflow' } },
      { pendingApproval: { toolName: '<script>PRIVATE_TOOL</script>', executionId: 'approval-223' } },
      { pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'id\nPRIVATE_INJECTION' } },
      { pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'x'.repeat(201) } },
    ].map(value => ({ status: 'available' as const, metadata: value })),
  ])('reports unavailable rather than a false absence for malformed or unread ledgers: %#', ledger => {
    const text = buildCampaignActionStatus([], undefined, ledger);
    expect(text).toContain('Pending execution approval ledger unavailable');
    expect(text).not.toContain('No pending execution approval');
    expect(text).not.toContain('PRIVATE_');
    expect(text).not.toContain('<script>');
  });

  it('supports the legacy toolCallId identity and does not borrow a stale owner or currentAgent', () => {
    const text = buildCampaignActionStatus([], undefined, { status: 'available', metadata: {
      pendingApproval: { toolName: 'execute_lead_workflow', toolCallId: 'call_223' },
      pendingApprovalOwner: { requestId: 'old-call', agentType: 'content_studio' }, currentAgent: 'outreach',
    } });
    expect(text).toContain('request ID call_223, owner unavailable');
    expect(text).not.toContain('owner content_studio');
    expect(text).not.toContain('owner outreach');
  });

  it('does not hide a durable pending object behind a stale false requiresApproval flag', () => {
    expect(buildCampaignActionStatus([], undefined, { status: 'available', metadata: { ...metadata(), requiresApproval: false } }))
      .toContain('request ID approval-223:run-1');
  });

  it('redacts malformed owner tokens while retaining the valid pending approval identity', () => {
    const value = metadata();
    value.pendingApprovalOwner.agentType = '<PRIVATE_OWNER>';
    const text = buildCampaignActionStatus([], undefined, { status: 'available', metadata: value });
    expect(text).toContain('request ID approval-223:run-1, owner unavailable');
    expect(text).not.toContain('PRIVATE_OWNER');
  });
});
