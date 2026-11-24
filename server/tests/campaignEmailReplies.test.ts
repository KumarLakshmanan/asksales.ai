import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { createHash } from 'node:crypto';
import {
  currentAssistant,
  withAssistantContext,
  type ResolvedAssistant,
} from '../services/assistants/AssistantContext.js';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const generate = jest.fn<(...args: any[]) => Promise<any>>();
const claim = jest.fn<(...args: any[]) => Promise<any>>();
const send = jest.fn<(...args: any[]) => Promise<any>>();
const complete = jest.fn<(...args: any[]) => Promise<any>>();
const markFailed = jest.fn<(...args: any[]) => Promise<any>>();
// Recipient policy has dedicated PostgreSQL acceptance coverage; this suite isolates the adapter/context contract.
jest.unstable_mockModule('../services/outreach/RecipientSuppressionService.js',()=>({assertRecipientNotSuppressed:async()=>{}}));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: {
    createProviderForUser: async () => ({
      defaultModel: 'test-model',
      createChatCompletion: generate,
    }),
  },
}));
jest.unstable_mockModule(
  '../services/agents/orchestration/PrivacyVaultService.js',
  () => ({
    redactPiiWithStableTokens: (text: string) => ({
      redactedText: text.replace(/uma@example.test/g, '[EMAIL_1]'),
    }),
  }),
);
jest.unstable_mockModule(
  '../services/agents/orchestration/DeliveryOutboxService.js',
  () => ({
    deliveryOutboxService: {
      claim,
      completeClaimedAction: complete,
      markFailed,
    },
  }),
);
jest.unstable_mockModule('../services/emailService.js', () => ({
  emailService: { sendEmailWithUserCredentials: send },
}));
jest.unstable_mockModule(
  '../services/outreach/ProviderBindingService.js',
  () => ({
    resolveOfficialProviderBinding: async () => ({
      credentialId: 8,
      providerAccountId: 'sender@example.test',
      platform: 'gmail_api',
    }),
  }),
);
const {
  generateCampaignEmailReply,
  loadCampaignEmailReplyContext,
  conversationCampaignReplyContext,
} = await import('../services/outreach/CampaignEmailReplyService.js');
const { sendCampaignEmailReply } =
  await import('../services/outreach/CampaignEmailReplyDelivery.js');
const parse = (query: SQL) => new PgDialect().sqlToQuery(query);
const context = {
  kind: 'campaign' as const,
  campaignId: 51,
  conversationId: 68,
  source: { table: 'sent_messages' as const, id: 41 },
  senderId: 3,
  accountId: 'sender@example.test',
  recipientEmail: 'uma@example.test',
};
const campaign = () => ({
  subject: 'Practical AI in finance',
  content: 'Would you like a Finance AI Automation Assessment?',
  campaign_name: 'Finance AI Assessment',
  settings: {},
  lead_id: 12,
  external_thread_id: 'thread-finance',
  automation_mode: 'ai_active',
  conversation_status: 'replied',
  account_id: context.accountId,
  sender_type: 'gmail',
  credential_id: 8,
});
const body =
  'Thanks for your interest in the Finance AI Assessment. What time would suit a brief conversation?';
const scoped = <T>(work: () => T) =>
  withBusinessScope({ userId: 9, businessProfileId: 7 }, work);
const generateReply = () =>
  scoped(() =>
    generateCampaignEmailReply({
      userId: 9,
      context,
      inboundText:
        "I'm ready for a brief conversation about the Finance AI Automation Assessment. Contact uma@example.test.",
    }),
  );
beforeEach(() => {
  jest.clearAllMocks();
  execute.mockReset().mockResolvedValue({ rows: [campaign()] });
  generate
    .mockReset()
    .mockResolvedValue({
      success: true,
      content: JSON.stringify({
        body,
        sentiment: 'positive',
        requiresReview: false,
      }),
    });
  send
    .mockReset()
    .mockResolvedValue({ success: true, providerMessageId: 'sent-campaign' });
  claim.mockReset().mockImplementation(async (identity, payload) => ({
    state: 'claimed',
    action: {
      id: 201,
      userId: 9,
      conversationId: identity.conversationId,
      payload,
    },
  }));
  complete.mockReset().mockResolvedValue(undefined);
  markFailed.mockReset().mockResolvedValue(undefined);
});

describe('campaign-scoped email generation', () => {
  it('retains source verification when JSON storage reorders source keys', async () => {
    const generated = await generateReply();
    const storedContext = { ...generated.context, source: { id: context.source.id, table: context.source.table } };
    await expect(scoped(() => loadCampaignEmailReplyContext(9, storedContext))).resolves.toMatchObject({
      context: { sourceHash: generated.context.sourceHash },
    });
  });
  it('accepts a previously saved source hash after JSON key reordering but rejects changed content', async () => {
    const original = campaign();
    const oldHash = createHash('sha256').update(JSON.stringify([
      context.campaignId, context.source, context.senderId, context.accountId,
      context.recipientEmail, original.subject, original.content,
    ])).digest('hex');
    const saved = { ...context, source: { id: context.source.id, table: context.source.table }, sourceHash: oldHash };
    await expect(scoped(() => loadCampaignEmailReplyContext(9, saved))).resolves.toBeDefined();
    execute.mockResolvedValueOnce({ rows: [{ ...original, content: 'A changed offer' }] });
    await expect(scoped(() => loadCampaignEmailReplyContext(9, saved))).rejects.toThrow('original campaign email changed');
  });
  it.each(['{{first_name}}', '{{first Name}}'])('rejects model replies containing %s without expanding private lead fields', async token => {
    generate.mockResolvedValueOnce({ success: true, content: JSON.stringify({ body: `Hi ${token}, thanks for your interest.`, sentiment: 'positive', requiresReview: false }) });
    await expect(generateReply()).rejects.toThrow('Missing email personalization values');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it('cannot inherit an ambient Oro Circle support assistant or its provider settings', async () => {
    const hotel = {
      provenance: { assistantId: 'hotel-assistant' },
      configuration: { instructions: 'Oro Circle Reservations' },
    } as unknown as ResolvedAssistant;
    generate.mockImplementation(async () => {
      expect(currentAssistant()).toBeUndefined();
      return {
        success: true,
        content: JSON.stringify({
          body,
          sentiment: 'positive',
          requiresReview: false,
        }),
      };
    });
    await withAssistantContext(hotel, async () => {
      expect(await generateReply()).toMatchObject({ body });
      expect(currentAssistant()).toBe(hotel);
    });
  });
  it('grounds the Finance AI response in its delivered offer, redacts contact data, and defaults to review', async () => {
    expect(await generateReply()).toMatchObject({
      body,
      autoSend: false,
      context: { campaignId: 51, source: context.source },
    });
    const request = generate.mock.calls[0][0];
    const references = JSON.parse(request.messages[1].content);
    expect(references.originalEmail).toContain(
      'Finance AI Automation Assessment',
    );
    expect(references.customerMessage).toContain('[EMAIL_1]');
    expect(JSON.stringify(references)).not.toMatch(
      /Oro Circle|Reservations|uma@example.test/,
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('requires campaign opt-in and a separate positive verification before automatic delivery', async () => {
    execute.mockResolvedValue({
      rows: [{ ...campaign(), settings: { replyPolicy: { autoSend: true } } }],
    });
    generate
      .mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({
          body,
          sentiment: 'positive',
          requiresReview: false,
        }),
      })
      .mockResolvedValueOnce({ success: true, content: '{"valid":true}' });
    expect(await generateReply()).toMatchObject({
      autoSend: true,
      context: { autoSendVerified: true },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].messages[0].content).toMatch(/JSON/i);
    expect(generate.mock.calls[1][0].response_format).toEqual({ type: 'json_object' });
    expect(generate.mock.calls[1][0].max_tokens).toBe(800);
  });
  it.each(['false', '"true"'])(
    'holds an unrelated or invalidly verified response for review (%s)',
    async (valid) => {
      execute.mockResolvedValue({
        rows: [
          { ...campaign(), settings: { replyPolicy: { autoSend: true } } },
        ],
      });
      generate
        .mockResolvedValueOnce({
          success: true,
          content: JSON.stringify({
            body: 'Oro Circle Reservations welcomes you.',
            sentiment: 'positive',
            requiresReview: false,
          }),
        })
        .mockResolvedValueOnce({
          success: true,
          content: `{"valid":${valid}}`,
        });
      expect(await generateReply()).toMatchObject({ autoSend: false });
    },
  );
  it('never auto-replies to a human meeting cancellation, even if the campaign is opted in', async () => {
    execute.mockResolvedValue({
      rows: [{ ...campaign(), settings: { replyPolicy: { autoSend: true } } }],
    });
    expect(
      await scoped(() =>
        generateCampaignEmailReply({
          userId: 9,
          context,
          inboundText: 'I cancelled our meeting yesterday.',
        }),
      ),
    ).toMatchObject({ requiresReview: true, autoSend: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('never falls back to business support after missing campaign context or model failure', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(generateReply()).rejects.toThrow('cannot be verified');
    expect(generate).not.toHaveBeenCalled();
    generate.mockResolvedValueOnce({ success: false, error: 'unavailable' });
    await expect(generateReply()).rejects.toThrow('no fallback');
  });
  it('requires the exact business, account, campaign and lead relationship in the source query', async () => {
    await scoped(() => loadCampaignEmailReplyContext(9, context));
    const query = parse(execute.mock.calls[0][0]);
    expect(query.params).toEqual(
      expect.arrayContaining([7, 9, 51, 68, 41, 3, context.accountId]),
    );
    expect(query.sql).toContain('c.lead_id=source.lead_id');
    expect(query.sql).toContain('source.sender_id=sender.id');
    expect(query.sql).not.toContain('updated_at DESC');
    await expect(
      scoped(() => loadCampaignEmailReplyContext(10, context)),
    ).rejects.toThrow('unresolved');
  });
  it('rejects a changed source and ambiguous campaigns instead of choosing the newest', async () => {
    const loaded = await scoped(() =>
      loadCampaignEmailReplyContext(9, context),
    );
    execute.mockResolvedValueOnce({
      rows: [{ ...campaign(), content: 'Unrelated replacement offer' }],
    });
    await expect(
      scoped(() => loadCampaignEmailReplyContext(9, loaded.context)),
    ).rejects.toThrow('changed');
    execute.mockResolvedValueOnce({
      rows: [
        { id: 1, campaign_id: 51 },
        { id: 2, campaign_id: 99 },
      ],
    });
    await expect(conversationCampaignReplyContext(9, 68)).rejects.toThrow(
      'ambiguous',
    );
  });
});

describe('campaign reply delivery binding', () => {
  const receipt = () => ({
    id: 91,
    user_id: 9,
    lead_id: 12,
    lead_email: 'uma@example.test',
    smart_reply: body,
    reply_context: {
      ...context,
      draftHash: createHash('sha256').update(body).digest('hex'),
      autoSendVerified: true,
    },
    message_id: 'gmail-native-id',
    gmail_thread_id: 'thread-finance',
  });
  const ready = () =>
    execute.mockImplementation(async (query: SQL) =>
      parse(query).sql.includes('WITH source')
        ? {
            rows: [
              { ...campaign(), settings: { replyPolicy: { autoSend: true } } },
            ],
          }
        : {
            rows: [{ id: 701, rfc_message_id: '<finance-reply@example.test>' }],
          },
    );
  it('sends through the verified original account and exact thread with no hotel brand wrapper', async () => {
    ready();
    expect(await scoped(() => sendCampaignEmailReply(receipt()))).toEqual({
      success: true,
      mediaSent: 0,
    });
    expect(send).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        to: 'uma@example.test',
        text: body,
        threadId: 'thread-finance',
        inReplyTo: '<finance-reply@example.test>',
        skipConversationLog: true,
        preservePresentation: true,
      }),
      3,
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('does not let an old retry body masquerade as manual approval after campaign auto-send is disabled', async () => {
    expect(
      await scoped(() =>
        sendCampaignEmailReply(receipt(), 'Oro Circle Reservations', {
          actionId: 201,
          conversationId: 68,
        }),
      ),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('human approval'),
    });
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(
      await scoped(() =>
        sendCampaignEmailReply({
          ...receipt(),
          lead_email: 'changed@example.test',
        }),
      ),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('recipient changed'),
    });
  });
  it('rejects modified drafts, changed recipients and superseded inbound replies', async () => {
    ready();
    expect(
      await scoped(() =>
        sendCampaignEmailReply({
          ...receipt(),
          smart_reply: 'Oro Circle Reservations',
        }),
      ),
    ).toMatchObject({ success: false });
    expect(send).not.toHaveBeenCalled();
    execute.mockImplementation(async (query: SQL) =>
      parse(query).sql.includes('WITH source')
        ? {
            rows: [
              { ...campaign(), settings: { replyPolicy: { autoSend: true } } },
            ],
          }
        : { rows: [] },
    );
    expect(await scoped(() => sendCampaignEmailReply(receipt()))).toMatchObject(
      { success: false, error: expect.stringContaining('superseded') },
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('holds an uncertain provider attempt without automatically retrying it', async () => {
    ready();
    send.mockRejectedValueOnce(new Error('network outcome unknown'));
    expect(await scoped(() => sendCampaignEmailReply(receipt()))).toMatchObject(
      { success: false, error: expect.stringContaining('uncertain') },
    );
    expect(markFailed).toHaveBeenCalledWith(
      201,
      'network outcome unknown',
      true,
      false,
    );
  });
});
