import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const postProcessingExecute = jest.fn(async (ctx: unknown) => ctx);
let brochure = false;

jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js', () => ({
  channelGateway: {
    process: jest.fn(async () => ({
      method: 'ready_for_channel_delivery',
      context: {
        metadata: {
          suppressBusinessEffects: !brochure,
          ...(brochure ? { playbookDirective: { runId: 0, readOnlyInformation: true, capability: { name: 'knowledge.answer' } } } : {}),
        },
        agentResult: {
          replyText: 'The pool is open until 9 PM.\n\nYour support ticket remains open.',
          escalated: false,
          effectProposals: [],
          toolCallsExecuted: [],
          ...(brochure ? { crmPipelineStatus: 'qualified', scheduleReminder: { title: 'Must not run' } } : {}),
        },
      },
    })),
  },
}));

jest.unstable_mockModule('../services/agents/pipeline/stages/PostProcessingStage.js', () => ({
  PostProcessingStage: class {
    execute = postProcessingExecute;
  },
}));

jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(async () => []),
      })),
    })),
  },
}));

jest.unstable_mockModule('../models/agentAuditLogs/schema.js', () => ({
  agentAuditLogsTable: { id: 'id', userId: 'user_id' },
}));

const { agentRouter } = await import('../services/agents/AgentRouter.js');

describe('ticket-aware deferred ownership boundary', () => {
  it.each(['email', 'web'])('preserves the brochure no-effects boundary after deferred %s delivery', async channel => {
    brochure = true;
    try {
      const result = await agentRouter.handle({ userId: 7, conversationId: 41, channel,
        inboundText: 'Please share the corporate brochure', rawMessageId: `${channel}:brochure:1` });
      expect(result?.deferredEffectContext).toMatchObject({ suppressBusinessEffects: true, playbookRunId: null });
      await agentRouter.commitDeferredDelivery(result!);
      expect(postProcessingExecute).toHaveBeenLastCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ suppressBusinessEffects: true, deliveryStatus: 'sent' }),
      }));
    } finally { brochure = false; }
  });
  it.each(['email', 'web'])('keeps business effects suppressed after %s delivery acknowledgement', async (channel) => {
    postProcessingExecute.mockClear();
    const result = await agentRouter.handle({
      userId: 7,
      conversationId: 41,
      channel,
      inboundText: 'What time does the pool close?',
      recipientPhone: 'test-recipient',
      rawMessageId: `${channel}:inbound:1`,
    });

    expect(result?.deferredEffectContext?.suppressBusinessEffects).toBe(true);
    await agentRouter.commitDeferredDelivery(result!);
    expect(postProcessingExecute).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ suppressBusinessEffects: true, deliveryStatus: 'sent' }),
    }));
  });

  it('persists and exposes the bounded-answer disposition without representing ownership resumption', () => {
    const auditSource = readFileSync(
      new URL('../services/agents/pipeline/AuditService.ts', import.meta.url),
      'utf8',
    );
    const supportSource = readFileSync(
      new URL('../services/SupportService.ts', import.meta.url),
      'utf8',
    );

    expect(auditSource).toContain('ticketFollowUpDisposition: ctx.metadata?.ticketFollowUpDisposition');
    expect(auditSource).toContain('ticketReadOnlyVerified: ctx.metadata?.ticketReadOnlyVerified === true');
    expect(auditSource).toContain('ownershipResumed: ctx.metadata?.ownershipResumed === true');
    expect(auditSource).toContain('historyScopedAfterOwnershipResume: ctx.metadata?.historyScopedAfterOwnershipResume === true');
    expect(supportSource).toContain("ticketFollowUpDisposition' IN ('read_only_ai', 'human_queue')");
    expect(supportSource).toContain('latestTicketAutomation');
  });
});
