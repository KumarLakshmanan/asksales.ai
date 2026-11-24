import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { withBusinessScope } from "../tenancy/businessContext.js";

jest.unstable_mockModule('../services/outreach/CampaignManualFollowUpService.js',()=>({assertManualEnrollment:async()=>{}}));
const getMessage = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getConversation = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const assertTemplate = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../services/content/ApprovedTemplateResolver.js', () => ({
  assertApprovedTemplateDelivery: assertTemplate,
  templateRecipientFromLead: () => ({ first_name: 'Ada' }),
}));
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: { findByIdForUser: async () => ({ id: 3 }) } }));
const createMessage = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const dispatch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const recipients = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const templates = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const templateHash = jest.fn<(...args: unknown[]) => string>();
const configuredSocialFollowUps = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({
  activateSocialFollowUpForAnchor: configuredSocialFollowUps,
  parseUtcDatabaseTimestamp: (value: Date | string) => value instanceof Date ? value : new Date(value),
}));
jest.unstable_mockModule("../models/db.js", () => ({ db: { execute } }));
jest.unstable_mockModule(
  "../models/outreachConversations/functions.js",
  () => ({
    getOutreachMessageById: getMessage,
    getOutreachConversationById: getConversation,
    createOutreachMessage: createMessage,
  }),
);
jest.unstable_mockModule("../queues/JobDispatcher.js", () => ({
  jobDispatcher: { dispatch },
}));
jest.unstable_mockModule("../services/outreach/CreationService.js", () => ({
  getCreationRecipients: recipients,
  getCreationTemplates: templates,
  creationTemplateHash: templateHash,
  validateCreationTemplate: () => "Hello Ada",
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { warn: jest.fn() },
}));
const { activateCreationFollowUps, checkCreationDelivery, recoverCreationFollowUps } =
  await import("../services/outreach/CreationFollowUpService.js");
const scope = <T>(work: () => T) =>
  withBusinessScope({ userId: 1, businessProfileId: 10 }, work);
const delivery = {
  userId: 1,
  channel: "email",
  leadId: 3,
  conversationId: 9,
  message: "Hello Ada",
  subject: "Hello",
  recipientEmail: "ada@example.com",
  senderId: 7,
};
let origin: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  origin = {
    id: 11,
    conversationId: 9,
    userId: 1,
    content: "Hello Ada",
    direction: "outbound",
    messageKind: "outreach",
    status: "sent",
    sentAt: new Date(),
    providerAccountId: "account-1",
    confirmedAt: new Date(),
    metadata: {
      outreachCreation: {
        version: 1,
        delivery,
        followUps: [
          { delayMinutes: 60, message: "Checking in" },
          { delayMinutes: 1440, message: "Still need help?" },
        ],
      },
    },
  };
  getMessage.mockImplementation(async () => origin);
  createMessage.mockImplementation(async (...args) => ({
    ...(args[0] as object),
    id: 20,
    sendIntentId: "intent-20",
  }));
  dispatch.mockResolvedValue({});
  execute.mockResolvedValue({ rows: [] });
  recipients.mockResolvedValue({
    recipients: [{ id: 3, eligible: true, recipient: "ada@example.com" }],
  });
  templates.mockResolvedValue([
    { id: "t", name: "welcome", language: "en_US", body: "Hello Ada" },
  ]);
  templateHash.mockReturnValue("reviewed-snapshot");
  configuredSocialFollowUps.mockResolvedValue(true);
  getConversation.mockResolvedValue({ id: 9, userId: 1, leadId: 3, channel: 'email' });
  assertTemplate.mockResolvedValue(undefined);
});

describe("reviewed outreach follow-ups", () => {
  it.each(['email', 'sms', 'whatsapp', 'instagram', 'facebook'])('schedules %s local steps from the delivered origin without consulting channel defaults', async channel => {
    const creation = (origin.metadata as any).outreachCreation;
    creation.followUpSource = 'outreach'; creation.delivery = { ...delivery, channel };
    await scope(() => activateCreationFollowUps(1, 11));
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[0][0]).toMatchObject({ followUpOriginMessageId: 11, content: 'Checking in', metadata: { outreachCreation: { followUpSource: 'outreach', followUps: [] } } });
    expect(dispatch.mock.calls[0][2]).toMatchObject({ delay: expect.any(Number) });
    expect((dispatch.mock.calls[0][2] as { delay: number }).delay).toBeGreaterThan(3590000);
    expect(configuredSocialFollowUps).not.toHaveBeenCalled();
  });
  it('keeps an explicitly disabled local outreach out of both schedulers', async () => {
    (origin.metadata as any).outreachCreation.followUpSource = 'outreach';
    (origin.metadata as any).outreachCreation.followUps = [];
    await scope(() => activateCreationFollowUps(1, 11));
    expect(createMessage).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    expect(configuredSocialFollowUps).not.toHaveBeenCalled();
  });
  it('keeps later follow-ups out of the campaign card initial-delivery receipt', async () => {
    const creation = (origin.metadata as any).outreachCreation;
    creation.followUpSource = 'outreach';
    creation.delivery = { ...delivery, widgetId: 44, threadId: 22, expectedWidgetJobCount: 1 };
    await scope(() => activateCreationFollowUps(1, 11));
    expect(dispatch.mock.calls[0][1]).toMatchObject({ threadId: 22, message: 'Checking in' });
    expect(dispatch.mock.calls[0][1]).not.toHaveProperty('widgetId');
    expect(dispatch.mock.calls[0][1]).not.toHaveProperty('expectedWidgetJobCount');
  });
  it.each(['unchanged', 'message', 'account', 'reply'])('checks an outreach-only queued step against its immutable origin: %s', async change => {
    (origin.metadata as any).outreachCreation.followUpSource = 'outreach';
    const stepDelivery = { ...delivery, message: 'Checking in' };
    const child = { ...origin, id: 20, subject: 'Hello', content: change === 'message' ? 'Unreviewed replacement' : 'Checking in', messageKind: 'follow_up', followUpOriginMessageId: 11, followUpStep: 1,
      providerAccountId: change === 'account' ? 'other-account' : origin.providerAccountId,
      metadata: { outreachCreation: { version: 1, delivery: stepDelivery, followUpSource: 'outreach', followUps: [] } } };
    getMessage.mockImplementation(async id => id === 11 ? origin : child);
    execute.mockResolvedValue({ rows: [{ has_reply: change === 'reply', automation_mode: 'ai_active' }] });
    const result = await scope(() => checkCreationDelivery(1, 20, stepDelivery));
    if (change === 'unchanged') expect(result).toBeNull();
    else if (change === 'reply') expect(result).toMatchObject({ cancelled: true });
    else expect(result).toMatchObject({ error: expect.stringContaining('reviewed outreach') });
  });
  it('holds legacy inline manual sequences without minting a new assistant or queue receipt',async()=>{
    await scope(()=>activateCreationFollowUps(1,11));
    expect(createMessage).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['message', 'subject', 'recipientEmail', 'leadId', 'senderId', 'channel'])('rejects changed %s in non-creation approved-template jobs', async field => {
    origin.subject = 'Hello';
    origin.metadata = { sourceTemplateId: 17, sourceTemplateVersion: 4, templateDelivery: delivery };
    expect(await scope(() => checkCreationDelivery(1, 11, { ...delivery, [field]: 'changed' })))
      .toMatchObject({ error: expect.stringContaining('queued message or recipient') });
    expect(assertTemplate).not.toHaveBeenCalled();
  });
  it('verifies the saved HTML and approved version for a matching non-creation template job', async () => {
    origin.subject = 'Hello'; origin.htmlContent = '<p>Hello Ada</p>';
    origin.metadata = { sourceTemplateId: 17, sourceTemplateVersion: 4, templateDelivery: delivery };
    expect(await scope(() => checkCreationDelivery(1, 11, delivery))).toBeNull();
    expect(assertTemplate).toHaveBeenCalledWith(1, 'email', expect.objectContaining({ content: 'Hello Ada', htmlContent: '<p>Hello Ada</p>', sourceTemplateVersion: 4 }), expect.any(Object));
  });
  it('rejects an approved-template job without a reviewed delivery snapshot', async () => {
    origin.metadata = { sourceTemplateId: 17, sourceTemplateVersion: 4 };
    expect(await scope(() => checkCreationDelivery(1, 11, delivery))).toMatchObject({ error: expect.stringContaining('queued message or recipient') });
  });
  it.each([
    { name: 'allows the reviewed SMS phone number', phone: '919876543210', changed: false },
    { name: 'rejects an SMS contact whose phone changed after review', phone: '919999999999', changed: true },
  ])('$name', async ({ phone, changed }) => {
    const smsDelivery = { ...delivery, channel: 'sms', recipientEmail: undefined, senderId: undefined, phone: '919876543210' };
    origin.metadata = { outreachCreation: { version: 1, delivery: smsDelivery, followUpSource: 'channel_settings', followUps: [] } };
    recipients.mockResolvedValue({ recipients: [{ id: 3, eligible: true, recipient: phone }] });
    const result = await scope(() => checkCreationDelivery(1, 11, smsDelivery));
    if (changed) expect(result).toMatchObject({ error: expect.stringContaining('recipient changed') });
    else expect(result).toBeNull();
    expect(recipients).toHaveBeenCalledWith(1, 'sms', { providerAccountId: 'account-1', senderId: undefined }, { ids: [3] });
  });
  it.each(['email', 'sms'])('leaves %s follow-ups to the saved platform scheduler without creating duplicate jobs', async (channel) => {
    origin.metadata = { outreachCreation: { version: 1, delivery: { ...delivery, channel }, followUpSource: 'channel_settings', followUps: [] } };
    expect(await scope(() => activateCreationFollowUps(1, 11))).toBe(true);
    expect(createMessage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(configuredSocialFollowUps).not.toHaveBeenCalled();
  });
  it.each(['whatsapp', 'instagram', 'facebook'])('activates the existing %s conversation schedule and safely retries activation', async (channel) => {
    origin.metadata = { outreachCreation: { version: 1, delivery: { ...delivery, channel }, followUpSource: 'channel_settings', followUps: [] } };
    await scope(() => activateCreationFollowUps(1, 11));
    await scope(() => activateCreationFollowUps(1, 11));
    expect(configuredSocialFollowUps).toHaveBeenCalledWith(11);
    expect(configuredSocialFollowUps).toHaveBeenCalledTimes(2);
    expect(createMessage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not activate saved social follow-ups before delivery succeeds or after cancellation', async () => {
    origin.metadata = { outreachCreation: { version: 1, delivery: { ...delivery, channel: 'whatsapp' }, followUpSource: 'channel_settings', followUps: [] } };
    origin.status = 'pending';
    await scope(() => activateCreationFollowUps(1, 11));
    origin.status = 'sent'; origin.followUpCancelledAt = new Date();
    await scope(() => activateCreationFollowUps(1, 11));
    expect(configuredSocialFollowUps).not.toHaveBeenCalled();
  });
  it('recovers saved social scheduling after the provider send succeeded and activation failed', async () => {
    origin.metadata = { outreachCreation: { version: 1, delivery: { ...delivery, channel: 'whatsapp' }, followUpSource: 'channel_settings', followUps: [] } };
    configuredSocialFollowUps.mockRejectedValueOnce(new Error('Temporary schedule failure'));
    await expect(scope(() => activateCreationFollowUps(1, 11))).rejects.toThrow('Temporary schedule failure');
    execute.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({ rows: [{ id: 11, user_id: 1, business_profile_id: 10 }] });
    await recoverCreationFollowUps();
    expect(configuredSocialFollowUps).toHaveBeenCalledTimes(2);
    expect(createMessage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("creates durable messages and delayed jobs anchored to the actual successful send", async () => {
    (origin.metadata as any).outreachCreation.campaignManual = {reviewId:'reviewed-campaign',steps:(origin.metadata as any).outreachCreation.followUps};
    await scope(() => activateCreationFollowUps(1, 11));
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messageKind: "follow_up",
        followUpOriginMessageId: 11,
        followUpStep: 1,
        providerAccountId: "account-1",
        idempotencyKey: "outreach-creation-follow-up:1:11:1",
      }),
    );
    const jobs = dispatch.mock.calls;
    expect(jobs[0][1]).toMatchObject({
      recipientEmail: "ada@example.com",
      senderId: 7,
      message: "Checking in",
      messageId: 20,
    });
    expect(jobs[0][2]).toMatchObject({ jobId: "outreach-send-intent-20" });
    expect((jobs[0][2] as { delay: number }).delay).toBeGreaterThan(3590000);
    expect((jobs[1][2] as { delay: number }).delay).toBeGreaterThan(86390000);
  });
  it("does not schedule follow-ups before the original send succeeds or after a reply cancels the origin", async () => {
    origin.status = "pending";
    await scope(() => activateCreationFollowUps(1, 11));
    origin.status = "sent";
    origin.followUpCancelledAt = new Date();
    await scope(() => activateCreationFollowUps(1, 11));
    expect(createMessage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("reuses each step’s message key and BullMQ job ID when activation is retried", async () => {
    (origin.metadata as any).outreachCreation.campaignManual = {reviewId:'reviewed-campaign',steps:(origin.metadata as any).outreachCreation.followUps};
    await scope(() => activateCreationFollowUps(1, 11));
    await scope(() => activateCreationFollowUps(1, 11));
    expect(
      (createMessage.mock.calls[0][0] as { idempotencyKey: string })
        .idempotencyKey,
    ).toBe(
      (createMessage.mock.calls[2][0] as { idempotencyKey: string })
        .idempotencyKey,
    );
    expect(dispatch.mock.calls[0][2]).toMatchObject({
      jobId: (dispatch.mock.calls[2][2] as { jobId: string }).jobId,
    });
  });
  it("stops a queued follow-up before provider preparation when an inbound reply is present", async () => {
    origin.messageKind = "follow_up";
    origin.followUpOriginMessageId = 8;
    execute.mockResolvedValue({
      rows: [{ has_reply: true, automation_mode: "ai_active" }],
    });
    expect(
      await scope(() => checkCreationDelivery(1, 11, delivery)),
    ).toMatchObject({ cancelled: true });
    expect(recipients).not.toHaveBeenCalled();
  });
  it("rejects a queued recipient that differs from the reviewed recipient", async () => {
    expect(
      await scope(() =>
        checkCreationDelivery(1, 11, {
          ...delivery,
          recipientEmail: "someone-else@example.com",
        }),
      ),
    ).toMatchObject({ error: expect.stringContaining("reviewed send intent") });
    expect(recipients).not.toHaveBeenCalled();
  });
  it("rechecks the contact details and selected account at delivery time", async () => {
    recipients.mockResolvedValue({
      recipients: [{ id: 3, eligible: true, recipient: "new@example.com" }],
    });
    expect(
      await scope(() => checkCreationDelivery(1, 11, delivery)),
    ).toMatchObject({ error: expect.stringContaining("recipient changed") });
    expect(recipients).toHaveBeenCalledWith(
      1,
      "email",
      { providerAccountId: "account-1", senderId: 7 },
      { ids: [3] },
    );
  });
  it("blocks WhatsApp templates that changed after review, including buttons and media definitions", async () => {
    const whatsapp = {
      ...delivery,
      channel: "whatsapp",
      senderId: undefined,
      recipientEmail: undefined,
      phone: "919876543210",
      templateName: "welcome",
      templateLanguage: "en_US",
      templateComponents: [],
      templateDefinitionHash: "reviewed-snapshot",
    };
    origin.metadata = {
      outreachCreation: {
        version: 1,
        delivery: whatsapp,
        followUps: [],
        whatsappOptInConfirmed: true,
      },
    };
    recipients.mockResolvedValue({
      recipients: [
        {
          id: 3,
          eligible: true,
          recipient: "919876543210",
          requiresTemplate: true,
        },
      ],
    });
    templateHash.mockReturnValue("changed-snapshot");
    expect(
      await scope(() => checkCreationDelivery(1, 11, whatsapp)),
    ).toMatchObject({
      error: expect.stringContaining("template changed after review"),
    });
    expect(templates).toHaveBeenCalledWith(1, "account-1");
  });
});
