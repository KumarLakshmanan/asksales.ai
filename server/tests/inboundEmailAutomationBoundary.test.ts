import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { InboundEmailData } from '../services/InboundEmailService.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const txExecute = jest.fn<(...args: any[]) => Promise<any>>();
const draft = jest.fn<(...args: any[]) => Promise<any>>();
const generate = jest.fn<(...args: any[]) => Promise<any>>();
const support = jest.fn<(...args: any[]) => Promise<any>>();
const commitSupport = jest.fn<(...args: any[]) => Promise<any>>();
const send = jest.fn<(...args: any[]) => Promise<any>>();
const logError = jest.fn();
const resolveCampaign = jest.fn<(...args: any[]) => Promise<any>>();
const reconcileCampaign = jest.fn<(...args: any[]) => Promise<any>>();
let campaignReply = true;
const conversation = {
  id: 68,
  userId: 9,
  leadId: 12,
  channel: 'gmail',
  providerAccountId: 'owner@example.test',
  leadName: 'Shiv Das',
  leadEmail: 'shiv@example.test',
  integrationProvider: 'gmail',
};
const parse = (query: SQL) => new PgDialect().sqlToQuery(query);
jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    execute,
    transaction: async (work: any) => work({ execute: txExecute }),
  },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: logError },
}));
jest.unstable_mockModule('../events/EventBus.js', () => ({
  eventBus: { publish: async () => {} },
}));
jest.unstable_mockModule(
  '../services/outreach/CampaignEmailReplyService.js',
  () => ({
    generateCampaignEmailReply: generate,
    conversationCampaignReplyContext: resolveCampaign,
  }),
);
jest.unstable_mockModule(
  '../models/outreachConversations/functions.js',
  () => ({
    getConversationByProviderThread: async () => conversation,
    getOutreachConversationById: async () => conversation,
    getOrCreateConversation: async () => conversation,
    updateOutreachConversation: async () => {},
    createOutreachMessage: draft,
  }),
);
jest.unstable_mockModule(
  '../services/agents/orchestration/PrivacyVaultService.js',
  () => ({
    privacyVaultService: {
      protectInbound: async () => ({ vaultId: 1, piiTypes: [], tokenCount: 0 }),
    },
    redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
  }),
);
jest.unstable_mockModule('../services/InboundContactResolver.js', () => ({
  inboundContactResolver: { reconcile: async () => {} },
}));
jest.unstable_mockModule('../services/emailFollowUpService.js', () => ({
  cancelConversationEmailFollowUps: async () => {},
}));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({
  cancelSocialFollowUpsForConversation: async () => {},
}));
jest.unstable_mockModule('../services/outreach/OutreachJobCampaignService.js', () => ({
  reconcileOutreachJobCampaign: reconcileCampaign,
}));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({
  agentRouter: { handle: support, commitDeferredDelivery: commitSupport },
}));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  withPublishedAssistant: async (_value: unknown, work: () => Promise<unknown>) => work(),
}));
jest.unstable_mockModule('../services/EmailReplyService.js', () => ({
  emailReplyService: { sendSmartReply: send },
}));
const { processInboundEmail, automatedEmailSuppressionReason, hasPublishedReceivingEmailAssistant, extractLatestReplyContent } =
  await import('../services/InboundEmailService.js');
const { prepareHandoffOffer } = await import('../services/agents/orchestration/HandoffConsent.js');
const email = () => ({
  provider: 'gmail' as const,
  receivingUserId: 9,
  externalMessageId: 'inbound-1',
  senderEmail: 'shiv@example.test',
  recipientEmails: ['owner@example.test'],
  gmailThreadId: 'thread-68',
  inReplyTo: '<campaign@example.test>',
  subject: 'Re: Finance AI Assessment',
  body: "I'm ready to discuss the Finance AI Assessment.",
});
const context = {
  kind: 'campaign',
  conversationId: 68,
  campaignId: 51,
  source: { table: 'sent_messages', id: 41 },
  senderId: 3,
  accountId: 'owner@example.test',
  recipientEmail: 'shiv@example.test',
};
beforeEach(() => {
  jest.clearAllMocks();
  campaignReply = true;
  resolveCampaign.mockReset().mockResolvedValue(null);
  execute.mockReset().mockImplementation(async (query: SQL) => {
    const text = parse(query).sql;
    if (text.includes('SELECT sm.id'))
      return {
        rows: [
          {
            id: 41,
            user_id: 9,
            lead_id: 12,
            campaign_id: campaignReply ? 51 : null,
            lead_name: 'Shiv Das',
            match_source: 'sent_messages',
            conversation_id: 68,
          },
        ],
      };
    if (text.includes('SELECT id,email FROM email_senders'))
      return { rows: [{ id: 3, email: 'owner@example.test' }] };
    return { rows: [] };
  });
  txExecute.mockReset().mockImplementation(async (query: SQL) => {
    const text = parse(query).sql;
    if (text.includes('SELECT conversation.id')) return { rows: [{ id: 68 }] };
    if (text.includes('UPDATE outreach_conversations') && text.includes('RETURNING')) return { rows: [{ id: 68 }] };
    if (text.includes('INSERT INTO sent_messages'))
      return { rows: [{ id: 91 }] };
    if (text.includes('INSERT INTO outreach_messages'))
      return { rows: [{ id: 701 }] };
    return { rows: [] };
  });
  generate
    .mockReset()
    .mockResolvedValue({
      body: 'What time suits a discussion of the Finance AI Assessment?',
      context,
      subject: 'Re: Finance AI Assessment',
      autoSend: false,
    });
  draft.mockReset().mockResolvedValue({ id: 702 });
  send.mockReset().mockResolvedValue({ success: true });
  support.mockReset();
});

describe('email automation boundaries', () => {
  it.each([
    { verifiedAck:true, outcome:'ready_for_channel_delivery', negative:false, sends:true },
    { verifiedAck:true, outcome:'ready_for_channel_delivery', negative:true, sends:true },
    { verifiedAck:false, outcome:'ready_for_channel_delivery', negative:false, sends:false },
    { verifiedAck:false, outcome:'ready_for_channel_delivery', negative:true, sends:false },
    { verifiedAck:true, outcome:'pending_approval', negative:false, sends:false },
    { verifiedAck:true, outcome:'blocked', negative:false, sends:false },
  ])('delivers only a ready verified decline acknowledgement without requiring sentiment: %j',async scenario=>{
    campaignReply=false;
    support.mockResolvedValueOnce({replyText:scenario.verifiedAck?'Okay, I’ll keep helping you here. What would you like to know?':'Ordinary customer reply',
      deliveryOutcome:scenario.outcome,handoffDeclineAcknowledged:scenario.verifiedAck,
      ...(scenario.negative?{classifiedSentiment:{sentiment:'negative',score:-1,keywords:[]}}:{})});
    const original=execute.getMockImplementation()!;
    execute.mockImplementation(async(query:SQL)=>parse(query).sql.includes("m.metadata->'assistant'")?{rows:[{id:42}]}:original(query));
    const originalTx=txExecute.getMockImplementation()!;
    txExecute.mockImplementation(async(query:SQL)=>parse(query).sql.includes('SELECT message.id, message.metadata')
      ?{rows:[{id:701,metadata:{supportTicketRoutingVersion:1}}]}:originalTx(query));
    await processInboundEmail({...email(),body:'No'});
    if(scenario.sends) expect(send).toHaveBeenCalledWith(91,undefined,9,[]);
    else expect(send).not.toHaveBeenCalled();
  });
  it.each(['Yes','No','Please do not connect me.'])('keeps only the current reply before a folded Gmail attribution: %s', reply => {
    expect(extractLatestReplyContent(`${reply}\n\nOn Thu, Oct 29, 2026 at 1:30 AM Agent <\nagent@example.test> wrote:\n> Reply Yes to connect, or No to continue.`)).toBe(reply);
  });
  it('does not turn quoted-only text or ordinary multiline customer prose into a consent answer', () => {
    const quoted='On Thu, Oct 29, 2026 at 1:30 AM Agent <\nagent@example.test> wrote:\n> Yes';
    expect(extractLatestReplyContent(quoted)).not.toBe('Yes');
    const ordinary='No\n\nOn arrival I want to ask about\nwhat the website wrote:\nPlease keep helping here.';
    expect(extractLatestReplyContent(ordinary)).toBe(ordinary);
  });
  it('routes a first enquiry to the assistant published for its verified receiving inbox', async () => {
    campaignReply = false;
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (query: SQL) => {
      const text = parse(query).sql;
      if (text.includes('receiving_email_binding_id')) return { rows: [{ receiving_email_binding_id: 20 }] };
      if (text.includes('SELECT id, name, full_name')) return { rows: [{ id: 12, name: 'Shiv Das' }] };
      return original(query);
    });
    const originalTx = txExecute.getMockImplementation()!;
    txExecute.mockImplementation(async (query: SQL) => parse(query).sql.includes('SELECT message.id, message.metadata')
      ? { rows: [{ id: 701, metadata: { supportTicketRoutingVersion: 1 } }] } : originalTx(query));
    await withBusinessScope({ userId: 9, businessProfileId: 7 }, () => processInboundEmail({
      ...email(), inReplyTo: undefined, subject: 'Check-in times', body: 'What are the check-in and check-out times?',
    }));
    expect(generate).not.toHaveBeenCalled();
    expect(support).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 68, channel: 'email',
      metadata: expect.objectContaining({ verifiedReceivingAccountId: 'owner@example.test' }) }));
    const receipt = txExecute.mock.calls.map(([query]) => parse(query))
      .find(query => query.sql.includes('INSERT INTO sent_messages'))!;
    expect(receipt.params.some(value => typeof value === 'string' && value.includes('"kind":"support"'))).toBe(true);
  });
  it('keeps campaign routing ahead of a published support inbox assignment', async () => {
    await withBusinessScope({ userId: 9, businessProfileId: 7 }, () => processInboundEmail(email()));
    expect(generate).toHaveBeenCalled();
    expect(support).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([query]) => parse(query).sql.includes('receiving_email_binding_id'))).toBe(false);
  });
  it.each([0, 2])('does not authorize a missing or ambiguous receiving assignment: %i rows', async count => {
    execute.mockResolvedValueOnce({ rows: Array.from({ length: count }, () => ({ receiving_email_binding_id: 20 })) });
    expect(await withBusinessScope({ userId: 9, businessProfileId: 7 }, () =>
      hasPublishedReceivingEmailAssistant(9, 68, 'owner@example.test', 3))).toBe(false);
  });
  it('requires exact business, current publication, private email account, verified sender and original conversation', async () => {
    execute.mockResolvedValueOnce({ rows: [{ receiving_email_binding_id: 20 }] });
    expect(await withBusinessScope({ userId: 9, businessProfileId: 7 }, () =>
      hasPublishedReceivingEmailAssistant(9, 68, 'owner@example.test', 3))).toBe(true);
    const query = parse(execute.mock.calls[0][0]);
    expect(query.params).toEqual([3, 'owner@example.test', 68, 'owner@example.test', 9, 7, 'owner@example.test']);
    expect(query.sql).toContain('sender.business_profile_id=binding.business_profile_id AND sender.is_verified');
    expect(query.sql).toContain('conversation.business_profile_id=binding.business_profile_id');
    expect(query.sql).toContain("binding.channel='email' AND binding.surface='private'");
    expect(query.sql).toContain("binding.enabled AND assistant.state='live' AND assistant.published_revision=binding.revision");
  });
  it('fails closed without owner scope, verified receiving identity, sender, or an available assignment lookup', async () => {
    expect(await hasPublishedReceivingEmailAssistant(9, 68, 'owner@example.test', 3)).toBe(false);
    await withBusinessScope({ userId: 8, businessProfileId: 7 }, async () => {
      expect(await hasPublishedReceivingEmailAssistant(9, 68, 'owner@example.test', 3)).toBe(false);
    });
    await withBusinessScope({ userId: 9, businessProfileId: 7 }, async () => {
      expect(await hasPublishedReceivingEmailAssistant(9, 68, null, 3)).toBe(false);
      expect(await hasPublishedReceivingEmailAssistant(9, 68, 'owner@example.test', null)).toBe(false);
    });
    expect(execute).not.toHaveBeenCalled();
    execute.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await withBusinessScope({ userId: 9, businessProfileId: 7 }, () =>
      hasPublishedReceivingEmailAssistant(9, 68, 'owner@example.test', 3))).toBe(false);
  });
  it.each([[true,false],[true,true],[false,false]])('persists or clears only the generated support offer before delivery: offer=%s formatted=%s', async (hasOffer,formatted) => {
    campaignReply = false;
    const ctx: any = { message: { userId: 9, conversationId: 68, channel: 'email', rawMessageId: 'inbound-1' }, metadata: {} };
    prepareHandoffOffer(ctx);
    const choice = ctx.metadata.handoffChoice;
    const decision = { replyText: hasOffer ? formatted ? choice.fallbackText.replace(/\n/g,'<br />') : choice.prompt : 'A supported factual reply', deliveryOutcome: 'ready_for_channel_delivery',
      classifiedSentiment: { sentiment: 'neutral', score: 0, keywords: [] }, choiceManifest: hasOffer ? choice : undefined,
      deferredEffectContext: { assistantProvenance: { conversationId: 68 } } };
    support.mockResolvedValueOnce(decision);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (query: SQL) => parse(query).sql.includes("m.metadata->'assistant'") ? { rows: [{ id: 42 }] } : original(query));
    const originalTx = txExecute.getMockImplementation()!;
    txExecute.mockImplementation(async (query: SQL) => parse(query).sql.includes('SELECT message.id, message.metadata')
      ? { rows: [{ id: 701, metadata: { supportTicketRoutingVersion: 1 } }] } : originalTx(query));
    await processInboundEmail(email());
    expect(logError.mock.calls).toEqual([]);
    expect(support).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(91, undefined, 9, []);
    const saved = execute.mock.calls.map(([query]) => parse(query)).find(query => query.sql.includes('smart_reply_assistant ='))!;
    expect(saved.params.some(value => typeof value === 'string' && value === JSON.stringify({ handoffChoice: hasOffer ? choice : null }))).toBe(true);
    expect(saved.sql).toContain("COALESCE(reply_context, '{}'::jsonb)");
    expect(commitSupport).toHaveBeenCalledWith(expect.objectContaining({ replyText: decision.replyText }));
  });
  it('blocks conflicting campaigns in the same provider thread instead of choosing the active business', async () => {
    resolveCampaign.mockResolvedValueOnce({ ...context, campaignId: 99 });
    await processInboundEmail(email());
    expect(generate).not.toHaveBeenCalled();
    expect(support).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([query]) => parse(query).sql.includes('UPDATE outreach_jobs job'))).toBe(false);
  });
  it('honors an explicit unsubscribe without entering campaign or support generation', async () => {
    await processInboundEmail({ ...email(), body: 'Unsubscribe me' });
    expect(generate).not.toHaveBeenCalled();
    expect(support).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const cancellation = execute.mock.calls.map(([query]) => parse(query))
      .find((query) => query.sql.includes('UPDATE outreach_jobs job'))!;
    expect(cancellation.params).toEqual([9, 51, 12]);
    expect(cancellation.sql).toContain("job.channel='email' AND job.status='pending'");
    expect(cancellation.sql).toContain('campaign.business_profile_id=job.business_profile_id');
    expect(txExecute.mock.calls.some(([query]) => parse(query).sql.includes("automation_mode = 'opted_out'"))).toBe(true);
  });
  it('routes a campaign reply only to its campaign and saves an exact-thread draft', async () => {
    expect(await processInboundEmail(email())).toMatchObject({
      success: true,
      conversationId: 68,
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining(context) }),
    );
    expect(draft).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 68,
        campaignId: 51,
        status: 'draft',
      }),
    );
    expect(support).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([query]) => parse(query).sql.includes('UPDATE outreach_jobs job'))).toBe(true);
    const sender = execute.mock.calls
      .map(([query]) => parse(query))
      .find((query) =>
        query.sql.includes('SELECT id,email FROM email_senders'),
      )!;
    expect(sender.params).toContain('gmail');
    expect(sender.params).not.toContain('gmail_oauth');
    expect(sender.sql).toMatch(/lower\(email\) IN \(\$\d+\)/);
    expect(sender.params).toContain('owner@example.test');
  });
  it('reconciles campaign progress after pending follow-ups are cancelled', async () => {
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (query: SQL) => parse(query).sql.includes('UPDATE outreach_jobs job')
      ? { rows: [{ id: 100 }] } : original(query));
    await processInboundEmail(email());
    expect(reconcileCampaign).toHaveBeenCalledWith(51, 9);
  });
  it('uses verified campaign delivery only when the campaign runtime explicitly authorizes auto-send', async () => {
    generate.mockResolvedValueOnce({
      body: 'Finance assessment reply',
      context,
      subject: 'Re: Finance assessment',
      autoSend: true,
    });
    await processInboundEmail(email());
    expect(send).toHaveBeenCalledWith(91, undefined, 9);
    expect(support).not.toHaveBeenCalled();
  });
  it('never falls back to hotel support if the campaign source or generator is unavailable', async () => {
    generate.mockRejectedValueOnce(new Error('source missing'));
    expect(await processInboundEmail(email())).toMatchObject({ success: true });
    expect(support).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('does not treat a lead or ordinary personal meeting thread as support authorization', async () => {
    campaignReply = false;
    await processInboundEmail({
      ...email(),
      subject: 'Our meeting',
      body: 'I cannot attend our meeting.',
    });
    expect(generate).not.toHaveBeenCalled();
    expect(support).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const receipt = txExecute.mock.calls
      .map(([query]) => parse(query))
      .find((query) => query.sql.includes('INSERT INTO sent_messages'))!;
    expect(
      receipt.params.some(
        (value) =>
          typeof value === 'string' && value.includes('"kind":"unresolved"'),
      ),
    ).toBe(true);
  });
  it.each<Partial<InboundEmailData>>([
    { subject: 'Cancelled: Meeting with Shiv Das' },
    { containsCalendarEvent: true },
    { rawHeaders: { 'Content-Type': 'text/calendar; method=CANCEL' } },
    { rawHeaders: { 'Auto-Submitted': 'auto-generated' } },
    { senderEmail: 'tipalti_reg_no_reply@rws.com' },
    { senderEmail: 'billing-noreply@example.com' },
    { senderEmail: 'do.not.reply@example.com' },
    { body: 'BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR' },
    {
      attachments: [
        {
          filename: 'cancel.ics',
          contentType: 'application/octet-stream',
          data: Buffer.from('METHOD:CANCEL'),
          size: 13,
        },
      ],
    },
  ])(
    'suppresses calendar/automatic email before thread or lead lookup, including threaded messages: %j',
    async (notification) => {
      expect(
        automatedEmailSuppressionReason({ ...email(), ...notification }),
      ).toBeTruthy();
      expect(
        await processInboundEmail({ ...email(), ...notification }),
      ).toMatchObject({ success: true, skipped: true });
      expect(execute).not.toHaveBeenCalled();
      expect(txExecute).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(support).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each(['replyto@example.com', 'noreen@example.com', 'snoreply-team@example.com', 'automation.lead@example.com'])(
    'keeps real people whose address only resembles a no-reply marker: %s',
    (senderEmail) => {
      expect(automatedEmailSuppressionReason({ ...email(), senderEmail })).toBeNull();
    },
  );
});
