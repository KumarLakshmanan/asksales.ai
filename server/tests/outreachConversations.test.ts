import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock, readyDeliveryReceipt } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
// Controller tests use explicitly ready assignments; real guards have dedicated boundary/SQL suites.
const attachEmailTracking = jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(async messages => messages);
jest.unstable_mockModule('../services/EmailOpenTrackingService.js', () => ({ attachEmailOpenTracking: attachEmailTracking }));
jest.unstable_mockModule('../services/EmailDesignService.js', () => ({ prepareDesignedEmail: async (_userId: number, body: string) => body }));
jest.unstable_mockModule('../services/assistants/ConversationDeliveryGate.js', () => ({ assertConversationDeliveryReady: async () => ({ ...readyDeliveryReceipt, businessProfileId: 11 }) }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({ withPublishedAssistant: async (receipt: unknown, work: () => unknown) => { if (!receipt) throw new Error('Published test receipt required'); return work(); } }));
/**
 * Outreach Conversations Controller Tests
 * Tests: getConversationsByChannel, getConversationWithMessages,
 *        sendMessage, createConversation, deleteConversation,
 *        getUnreadCounts, searchConversations, generateDraftReply
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

// ── Mocks ──────────────────────────────────────────────────────────────
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../services/IdempotencyService.js', () => ({
  idempotencyService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkAndStore: jest.fn<any>().mockResolvedValue({ status: 'fresh' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeResponse: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    forget: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('../models/sentMessages/functions.js', () => ({
  SentMessageModel: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: jest.fn<any>().mockResolvedValue({ id: 501 }),
  },
}));

jest.unstable_mockModule('../services/CRMService.js', () => ({
  crmService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoCreateContactOnOutreachSend: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

const mockConv = {
  id: 58,
  userId: 1,
  channel: 'whatsapp',
  status: 'active',
  leadId: 163,
  externalThreadId: '919987499179',
  metadata: { phoneNumber: '919987499179', phoneNumberId: '1095711443622725' },
  lastMessageAt: new Date().toISOString(),
};

const mockMessage = { id: 956, conversationId: 58, direction: 'inbound', content: 'hi', status: 'delivered' };
const mockInboxItem = jest.fn<any>();
jest.unstable_mockModule('../services/outreach/InboxService.js', () => ({ getInboxItem: mockInboxItem }));
const mockEmailDisplay = jest.fn<any>().mockResolvedValue(null);
const mockWhatsAppDisplay = jest.fn<any>().mockResolvedValue(null);
jest.unstable_mockModule('../services/outreach/InboxEmailPresentation.js', () => ({ inboxEmailDisplayText: mockEmailDisplay, inboxWhatsAppDisplayText: mockWhatsAppDisplay }));

jest.unstable_mockModule('../models/outreachConversations/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConversationsWithPreview: jest.fn<any>().mockResolvedValue([mockConv]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUnreadCountByChannel: jest.fn<any>().mockResolvedValue(2),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConversationWithMessages: jest.fn<any>().mockResolvedValue({ conversation: mockConv, messages: [mockMessage] }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  markMessagesAsRead: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOutreachConversationById: jest.fn<any>().mockResolvedValue(mockConv),
  // @ts-expect-error -- fixture intentionally combines partial message shapes
  createOutreachMessage: jest.fn<any>().mockResolvedValue({ id: 100, ...mockMessage, direction: 'outbound', status: 'pending' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateOutreachMessage: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateOutreachMessageStatus: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateOutreachConversation: jest.fn<any>().mockResolvedValue(undefined),
  // @ts-expect-error -- fixture intentionally combines partial conversation shapes
  createOutreachConversation: jest.fn<any>().mockResolvedValue({ id: 99, ...mockConv }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConversations: jest.fn<any>().mockResolvedValue([mockConv]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMessagesByConversationId: jest.fn<any>().mockResolvedValue([mockMessage]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteOutreachConversation: jest.fn<any>().mockResolvedValue(mockConv),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUnreadCounts: jest.fn<any>().mockResolvedValue({ email: 1, whatsapp: 2 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  searchConversations: jest.fn<any>().mockResolvedValue([mockConv]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteOutreachMessage: jest.fn<any>().mockResolvedValue({ id: 956 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOutreachMessageById: jest.fn<any>().mockResolvedValue({ ...mockMessage, conversationId: 58 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOutreachMessageByIdempotencyKey: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateConversationWithMessage: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConversationByLeadAndChannel: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOrCreateConversation: jest.fn<any>().mockResolvedValue({ created: false, conversation: mockConv }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLastMessageExternalId: jest.fn<any>().mockResolvedValue('<first@example.com>'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getFullReferenceChain: jest.fn<any>().mockResolvedValue('<first@example.com>'),
}));

jest.unstable_mockModule('../services/emailService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendEmailToLead: jest.fn<any>().mockResolvedValue({ success: true }),
}));

const mockGmailSend = jest.fn<any>().mockResolvedValue({
  success: true,
  messageId: '<second@example.com>',
  providerMessageId: '18fabc123',
  rfcMessageId: '<second@example.com>',
  threadId: 'gmail-thread-1',
});
jest.unstable_mockModule('../services/gmailApiService', () => ({
  gmailApiService: { sendEmail: mockGmailSend },
  GmailApiService: { getInstance: () => ({ sendEmail: mockGmailSend }) },
}));

jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reserveOutreachCredit: jest.fn<any>().mockResolvedValue({ success: true, transactionId: 1 }),
    refundDeduction: jest.fn<any>().mockResolvedValue({ success: true }),
  },
}));

jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({
  resolveOfficialProviderBinding: jest.fn<any>().mockResolvedValue({
    providerAccountId: 'test-provider-account',
  }),
  resolveOfficialSocialProviderBinding: jest.fn<any>().mockResolvedValue(null),
}));

jest.unstable_mockModule('../services/instagramService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendInstagramDM: jest.fn<any>().mockResolvedValue({ success: true, externalMessageId: 'ig_msg_123' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchInstagramMessages: jest.fn<any>().mockResolvedValue([]),
}));

jest.unstable_mockModule('../services/FacebookMessengerService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendFacebookDM: jest.fn<any>().mockResolvedValue({ success: true, externalMessageId: 'fb_msg_123' }),
}));

jest.unstable_mockModule('../services/TwitterApiService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendTwitterDM: jest.fn<any>().mockResolvedValue({ success: true, externalMessageId: 'tw_msg_123' }),
}));

jest.unstable_mockModule('../services/LinkedInApiService', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendLinkedInDM: jest.fn<any>().mockResolvedValue({ success: true, externalMessageId: 'li_msg_123' }),
}));

const mockSmsSend = jest.fn<any>().mockResolvedValue({ success: true, messageId: 'sms_msg_123' });
jest.unstable_mockModule('../services/smsService', () => ({ sendSMS: mockSmsSend }));

const smsCredential = () => ({
  id: 31, isActive: true, credentialType: 'api_key', accountIdentifier: 'ABCDEF',
  apiSecret: 'qa-sms-key', sessionData: { senderId: 'ABCDEF', flowId: 'template-42', messageVariable: 'message' },
  encryptionVersion: 'v1', encryptionKeyId: 'qa-key', encryptedAt: new Date(), providerVerifiedAt: new Date(),
});
const smsAccount = jest.fn<any>().mockImplementation(async (_userId: number, platform: string, accountId: string) =>
  platform === 'msg91_sms' && accountId === 'ABCDEF' ? smsCredential() : null);
jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({ ChannelCredentialModel: {
  findActiveAccountByIdentifier: smsAccount,
  findByUserAndPlatform: jest.fn<any>().mockImplementation(async (_userId: number, platform: string) => platform === 'msg91_sms' ? smsCredential() : null),
} }));

jest.unstable_mockModule('../models/leads/functions', () => ({
  LeadModel: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findById: jest.fn<any>().mockResolvedValue({ id: 163, name: 'Mahesh', company: 'OroCircle', email: 'mahesh@orocircle.com' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByIdForUser: jest.fn<any>().mockResolvedValue({ id: 163, name: 'Mahesh', company: 'OroCircle', email: 'mahesh@orocircle.com' }),
  },
}));

jest.unstable_mockModule('../services/KnowledgeBaseService', () => ({
  knowledgeBaseService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSemanticContext: jest.fn<any>().mockResolvedValue(''),
  },
}));

jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({
  LLMProviderFactory: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createProviderForUser: jest.fn<any>().mockResolvedValue({
      defaultModel: 'gpt-4o-mini',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createChatCompletion: jest.fn<any>().mockResolvedValue({ success: true, content: 'Hello! How can I help you?' }),
    }),
  },
}));

jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraphApiVersion: jest.fn<any>().mockReturnValue('v25.0'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOAuthBaseUrl: jest.fn<any>().mockReturnValue('https://www.facebook.com/v25.0'),
}));

jest.unstable_mockModule('../utils/rateLimitConstants.js', () => ({
  CHANNEL_THROTTLE_CONFIGS: {
    email: { minDelay: 0, maxDelay: 0, batchSize: 10, dailyLimit: 300 },
    whatsapp: { minDelay: 0, maxDelay: 0, batchSize: 10, dailyLimit: 100 },
    sms: { minDelay: 0, maxDelay: 0, batchSize: 10, dailyLimit: 100 },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbExecute = jest.fn<any>().mockResolvedValue({ rows: [], rowCount: 0 });

const manualEnrollment = jest.fn<any>();
const manualAdmission = jest.fn<any>();
class ManualReviewError extends Error {constructor(message:string,public status=409,public code='CAMPAIGN_SEQUENCE_CONFLICT'){super(message);}}
jest.unstable_mockModule('../services/outreach/CampaignManualFollowUpService.js',()=>({CampaignManualError:ManualReviewError,enrollManualReview:manualEnrollment,admitManualOrigin:manualAdmission}));
const creationAccount = jest.fn<any>();
const creationRecipients = jest.fn<any>();
const creationTemplates = jest.fn<any>();
const queuedCreation = jest.fn<any>().mockResolvedValue({ jobId: 'test-job' });
const copyCreationAttachments = jest.fn<any>().mockResolvedValue([{ mimeType: 'text/plain' }]);
const refreshCreationAttachments = jest.fn<any>().mockResolvedValue(undefined);
jest.unstable_mockModule('../services/outreach/CreationService.js', () => ({
  resolveCreationAccount: creationAccount,
  getCreationRecipients: creationRecipients,
  getCreationTemplates: creationTemplates,
  validateOutreachTiming: (date: unknown) => typeof date === 'string' ? new Date(date) : undefined,
  validateCreationTemplate: () => 'Hello Ada',
  creationTemplateHash: () => 'reviewed-template',
}));
jest.unstable_mockModule('../queues/JobDispatcher.js', () => ({ jobDispatcher: { dispatch: queuedCreation } }));
// Queued sends pin the business's billing organization; billing resolution
// has its own suites, so this one supplies a fixed payer.
jest.unstable_mockModule('../services/billing/organizations.js', () => {
  class BillingOrganizationError extends Error { constructor(message: string, readonly status = 403, readonly code = 'BILLING_ORGANIZATION_FORBIDDEN') { super(message); } }
  const unused = async () => { throw new Error('not used by this suite'); };
  return { BillingOrganizationError, resolveBillingOrganization: async () => 501,
    getBillingOrganization: unused, requireBillingRole: unused, listBillingOrganizations: unused, inviteOrganizationMember: unused,
    acceptOrganizationInvitation: unused, removeOrganizationMember: unused, assignBillingResources: unused };
});
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({
  getById: jest.fn<any>().mockResolvedValue({ id: 7, type: 'gmail', credentialId: 3, email: 'sales@example.com', isVerified: true }),
}));

jest.unstable_mockModule('../models/db', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { execute: mockDbExecute },
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue({}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: Object.assign(jest.fn<any>().mockReturnValue({}), { raw: jest.fn() }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue({}),
  inArray: jest.fn<any>().mockReturnValue({}),
  isNull: jest.fn<any>().mockReturnValue({}),
  lt: jest.fn<any>().mockReturnValue({}),
  desc: jest.fn<any>().mockReturnValue({}),
  count: jest.fn<any>().mockReturnValue({}),
  or: jest.fn<any>().mockReturnValue({}),
}));

jest.unstable_mockModule('../utils/personalization.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildLeadTokens: jest.fn<any>().mockReturnValue({}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyTokens: jest.fn<any>().mockImplementation((text: string) => ({ text, unresolvedTokens: [] })),
}));

jest.unstable_mockModule('../services/OutreachAttachmentService.js', () => ({
  ALLOWED_OUTREACH_ATTACHMENT_MIMES: new Set(['text/plain', 'application/pdf', 'image/png']),
  MAX_OUTREACH_ATTACHMENTS: 5,
  MAX_OUTREACH_ATTACHMENT_SIZE: 10 * 1024 * 1024,
  AttachmentValidationError: class AttachmentValidationError extends Error {},
  StorageLimitError: class StorageLimitError extends Error {},
  getChannelAttachmentCapability: jest.fn<() => { supported: boolean; mode: string }>().mockReturnValue({ supported: true, mode: 'email' }),
  outreachAttachmentService: {
    claimForMessage: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    copyForMessage: copyCreationAttachments,
    refreshMessageAttachmentCache: refreshCreationAttachments,
    listForMessage: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    listForMessages: jest.fn<() => Promise<Map<number, unknown[]>>>().mockResolvedValue(new Map()),
    listRecordsForMessage: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    listRecordsForMessages: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    getEmailAttachments: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    markDelivery: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    markAttachmentDelivery: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteFilesForMessages: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    deleteStaged: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    getGroundedContext: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    stageUpload: jest.fn(),
    download: jest.fn(),
  },
}));

jest.unstable_mockModule('multer', () => ({
  default: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      array: jest.fn<any>().mockReturnValue(jest.fn<any>()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      single: jest.fn<any>().mockReturnValue(jest.fn<any>()),
    }),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      memoryStorage: jest.fn<any>().mockReturnValue({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      diskStorage: jest.fn<any>().mockReturnValue({}),
    }
  ),
}));

jest.unstable_mockModule('../services/whatsappApiService.js', () => ({
  whatsappApiService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendText: jest.fn<any>().mockResolvedValue({ success: true, wamid: 'wamid.sent123' }),
    listApprovedTemplates: jest.fn<any>().mockResolvedValue([]),
    sendTemplate: jest.fn<any>().mockResolvedValue({ messages: [{ id: 'wamid.template' }] }),
  },
}));

// ── Import ─────────────────────────────────────────────────────────────
const draftAgent = jest.fn<any>().mockResolvedValue({ replyText: 'Your support request is still open. I do not have a confirmed response time yet.', deliveryOutcome: 'auto_sent', provenance: { assistant: readyDeliveryReceipt } });
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { handle: draftAgent } }));
jest.unstable_mockModule('../services/agents/SupportComposerPresentation.js', () => ({
  presentSupportComposerReply: async (input: { governedReply: string }) => input.governedReply,
}));
const { mockRequest, mockResponse, mockAuthRequest } = await import('./helpers/mockHelpers');

const {
  getConversationsByChannel,
  getConversationWithMessages,
  markConversationRead,
  sendMessage: sendMessageHandler,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createConversation,
  deleteConversation,
  getUnreadCounts,
  searchConversations,
  deleteOutreachMessageHandler,
  generateDraftReply,
  bulkCreateConversations,
} = await import('../controllers/outreachConversationsController');
const sendMessage: typeof sendMessageHandler = (req, res) => withBusinessScope(
  { userId: req.user?.id || 1, businessProfileId: 11 }, () => sendMessageHandler(req, res),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OutreachConversationModel = await import('../models/outreachConversations/functions') as any;

// Clear queued one-shot implementations as well as call history between cases.
const modelFixtureDefaults = Object.values(OutreachConversationModel).filter(jest.isMockFunction).map(mock => [mock, mock.getMockImplementation()] as const);
beforeEach(() => { for (const [mock, implementation] of modelFixtureDefaults) { mock.mockReset(); if (implementation) mock.mockImplementation(implementation); } });

const providerMocks = [await import('../services/IdempotencyService.js'), await import('../services/outreach/ProviderBindingService.js')];
const providerFixtureDefaults = providerMocks.flatMap(module => Object.values(module).flatMap(value => typeof value === 'object' && value !== null ? Object.values(value) : [value])).filter(jest.isMockFunction).map(mock => [mock, mock.getMockImplementation()] as const);
beforeEach(() => { for (const [mock, implementation] of providerFixtureDefaults) { mock.mockReset(); if (implementation) mock.mockImplementation(implementation); } });
describe('conversation-aware Support AI drafts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    draftAgent.mockResolvedValue({ replyText: 'I do not have a confirmed response time yet.', deliveryOutcome: 'auto_sent', provenance: { assistant: readyDeliveryReceipt } });
    OutreachConversationModel.getConversationWithMessages.mockResolvedValue({ conversation: mockConv, messages: [mockMessage] });
  });
  it.each(['instagram', 'facebook', 'whatsapp', 'sms', 'email', 'linkedin', 'twitter'])('uses actual chronological conversation on %s without sending or saving a composer suggestion', async channel => {
    const messages = Array.from({ length: 14 }, (_, i) => ({ ...mockMessage, id: i + 1, direction: i % 2 ? 'outbound' : 'inbound', status: 'delivered', content: `Turn ${i + 1}` }));
    messages.push({ ...mockMessage, id: 15, content: 'When will the support team respond?' });
    messages.push({ ...mockMessage, id: 16, direction: 'outbound', status: 'draft', content: 'Generic promotional pitch' });
    messages.push({ ...mockMessage, id: 17, direction: 'outbound', status: 'failed', content: 'Failed message' });
    OutreachConversationModel.getConversationWithMessages.mockResolvedValue({ conversation: { ...mockConv, channel }, messages });
    const res = mockResponse();
    await generateDraftReply(mockAuthRequest(1, { params: { channel, conversationId: '58' }, body: { composerOnly: true } }) as any, res);
    expect(draftAgent).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 58, channel, inboundText: messages[14].content,
      metadata: expect.objectContaining({ executionMode: 'advisory', dryRun: true, conversationKind: 'outreach_draft',
        conversationHistory: messages.slice(0,14).map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content })) }) }));
    expect(res._json.content).toContain('confirmed response time');
    expect(res._json.sourceMessageId).toBe(15);
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    expect(OutreachConversationModel.updateOutreachMessage).not.toHaveBeenCalled();
  });
  it.each(['Where are you located?', 'Can I book a spa slot?', 'Please share a corporate brochure.'])('passes each actual request to the shared agent: %s', async content => {
    OutreachConversationModel.getConversationWithMessages.mockResolvedValue({ conversation: mockConv, messages: [{ ...mockMessage, content }] });
    const res = mockResponse();
    await generateDraftReply(mockAuthRequest(1, { params: { channel: 'whatsapp', conversationId: '58' }, body: { composerOnly: true } }) as any, res);
    expect(draftAgent.mock.calls[0][0]).toEqual(expect.objectContaining({ inboundText: content }));
  });
  it('rejects wrong channel, foreign tenant, and empty history without calling the model', async () => {
    const req = (channel = 'instagram') => mockAuthRequest(1, { params: { channel, conversationId: '58' }, body: { composerOnly: true } }) as any;
    const mismatch = mockResponse(); await generateDraftReply(req(), mismatch); expect(mismatch._status).toBe(400);
    OutreachConversationModel.getConversationWithMessages.mockResolvedValue({ conversation: { ...mockConv, userId: 2 }, messages: [mockMessage] });
    const foreign = mockResponse(); await generateDraftReply(req(), foreign); expect(foreign._status).toBe(403);
    OutreachConversationModel.getConversationWithMessages.mockResolvedValue({ conversation: mockConv, messages: [] });
    const empty = mockResponse(); await generateDraftReply(req('whatsapp'), empty); expect(empty._status).toBe(400);
    expect(draftAgent).not.toHaveBeenCalled();
  });
  it('does not return a stale reply if the customer sends a newer message during generation', async () => {
    OutreachConversationModel.getConversationWithMessages.mockResolvedValueOnce({ conversation: mockConv, messages: [mockMessage] })
      .mockResolvedValueOnce({ conversation: mockConv, messages: [{ ...mockMessage, id: 999 }] });
    const res = mockResponse();
    await generateDraftReply(mockAuthRequest(1, { params: { channel: 'whatsapp', conversationId: '58' }, body: { composerOnly: true } }) as any, res);
    expect(res._status).toBe(409);
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
  });
  it('fails visibly without a marketing fallback when Support AI is unavailable', async () => {
    draftAgent.mockResolvedValue({ deliveryOutcome: 'no_op', replyText: '' });
    const res = mockResponse();
    await generateDraftReply(mockAuthRequest(1, { params: { channel: 'whatsapp', conversationId: '58' }, body: { composerOnly: true } }) as any, res);
    expect(res._status).toBe(409);
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
  });
});

// ── Tests ──────────────────────────────────────────────────────────────
describe('Outreach Conversations Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  // ── getConversationsByChannel ─────────────────────────────────────────
  describe('getConversationsByChannel', () => {
    it('uses a lookahead row to report older conversations without returning the extra row', async () => {
      OutreachConversationModel.getConversationsWithPreview.mockResolvedValue(Array.from({length:51},(_,id)=>({...mockConv,id})));
      const req=mockAuthRequest(1,{params:{channel:'whatsapp'},query:{limit:'50',offset:'50'}});
      const res=mockResponse();
      await getConversationsByChannel(req as any,res);
      expect(OutreachConversationModel.getConversationsWithPreview).toHaveBeenCalledWith(1,'whatsapp',51,50);
      expect(res._json.conversations).toHaveLength(50);
      expect(res._json.pagination).toEqual({limit:50,offset:50,hasMore:true});
    });

    it.each([{limit:'0'},{limit:'501'},{limit:'NaN'},{offset:'-1'},{offset:'1.5'},{limit:['50']}])('rejects invalid pagination %j', async query => {
      const res=mockResponse();
      await getConversationsByChannel(mockAuthRequest(1,{params:{channel:'whatsapp'},query}) as any,res);
      expect(res._status).toBe(400);
      expect(OutreachConversationModel.getConversationsWithPreview).not.toHaveBeenCalled();
    });

    it('passes status and UTC date bounds to the paginated query', async () => {
      const filters = { status: 'unread', dateFrom: '2026-09-22T18:30:00.000Z', dateTo: '2026-09-23T18:30:00.000Z' };
      const res = mockResponse();
      await getConversationsByChannel(mockAuthRequest(1, { params: { channel: 'email' }, query: { ...filters, limit: '50', offset: '0' } }) as any, res);
      expect(OutreachConversationModel.getConversationsWithPreview).toHaveBeenCalledWith(1, 'email', 51, 0, filters);
      expect(res._status).toBe(200);
    });

    it.each([{ status: 'invalid' }, { dateFrom: '2026-09-23' }, { dateTo: 'not-a-date' },
      { dateFrom: '2026-09-23T18:30:00.000Z', dateTo: '2026-09-22T18:30:00.000Z' }])('rejects invalid conversation filters %j', async query => {
      const res = mockResponse();
      await getConversationsByChannel(mockAuthRequest(1, { params: { channel: 'whatsapp' }, query }) as any, res);
      expect(res._status).toBe(400);
      expect(OutreachConversationModel.getConversationsWithPreview).not.toHaveBeenCalled();
    });

    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { channel: 'whatsapp' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getConversationsByChannel(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 for invalid channel', async () => {
      const req = mockAuthRequest(1, { params: { channel: 'telegram' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getConversationsByChannel(req as any, res);
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/Invalid channel/);
    });

    it('should return conversations for valid channel', async () => {
      OutreachConversationModel.getConversationsWithPreview.mockResolvedValue([mockConv]);
      OutreachConversationModel.getUnreadCountByChannel.mockResolvedValue(2);
      const req = mockAuthRequest(1, { params: { channel: 'whatsapp' }, query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getConversationsByChannel(req as any, res);
      expect(res._status).toBe(200);
      expect(res._json.conversations).toHaveLength(1);
      expect(res._json.unreadCount).toBe(2);
      expect(res._json.pagination).toBeDefined();
    });

    it('should accept all supported channels', async () => {
      const channels = ['email', 'instagram', 'sms', 'facebook', 'whatsapp', 'twitter', 'linkedin'];
      for (const channel of channels) {
        OutreachConversationModel.getConversationsWithPreview.mockResolvedValue([]);
        OutreachConversationModel.getUnreadCountByChannel.mockResolvedValue(0);
        const req = mockAuthRequest(1, { params: { channel }, query: {} });
        const res = mockResponse();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await getConversationsByChannel(req as any, res);
        expect(res._status).toBe(200);
      }
    });
  });

  // ── getConversationWithMessages ───────────────────────────────────────
  describe('getConversationWithMessages', () => {
    it('keeps the email conversation available when optional open tracking is unavailable', async () => {
      attachEmailTracking.mockRejectedValueOnce(new Error('Tracking store unavailable'));
      OutreachConversationModel.getConversationWithMessages.mockResolvedValueOnce({ conversation: { ...mockConv, channel: 'email' }, messages: [mockMessage] });
      const res = mockResponse();
      await getConversationWithMessages(mockAuthRequest(1, { params: { conversationId: '58' }, query: {} }) as any, res);
      expect(res._status).toBe(200);
      expect(res._json.messages[0].content).toBe(mockMessage.content);
    });
    it.each(['email', 'gmail'])('shows retained %s contact details while keeping the model copy masked', async channel => {
      const stored = { ...mockMessage, privacyVaultId: 73, content: "Yes, I'm [NAME_1] a conversation. Contact <[EMAIL_1]>", redactedContent: "Yes, I'm [NAME_1] a conversation. Contact <[EMAIL_1]>" };
      const display = "Yes, I'm interested in a conversation. Contact <sender@example.com>";
      OutreachConversationModel.getConversationWithMessages.mockResolvedValueOnce({ conversation: { ...mockConv, channel }, messages: [stored] });
      mockEmailDisplay.mockResolvedValueOnce(display);
      const res = mockResponse();
      const headers = jest.spyOn(res, 'setHeader');
      await getConversationWithMessages(mockAuthRequest(1, { params: { conversationId: '58' }, query: {} }) as any, res);
      expect(res._status).toBe(200);
      expect(res._json.messages[0]).toMatchObject({ content: display, htmlContent: null });
      expect(res._json.messages[0]).not.toHaveProperty('redactedContent');
      expect(stored.content).toContain('[NAME_1]');
      expect(mockEmailDisplay).toHaveBeenCalledWith(1, 1, 58, mockMessage.id);
      expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });

    it('shows WhatsApp contact details for older tokenised messages', async () => {
      const stored = { ...mockMessage, privacyVaultId: 73, content: 'Full name: [NAME_1]\nPhone: [PHONE_1]', redactedContent: 'Full name: [NAME_1]\nPhone: [PHONE_1]' };
      const plain = { ...mockMessage, id: 99, content: 'Full name: Priya Shah' };
      const display = 'Full name: Priya Shah\nPhone: +91 98765 43210';
      OutreachConversationModel.getConversationWithMessages.mockResolvedValueOnce({ conversation: { ...mockConv, channel: 'whatsapp' }, messages: [stored, plain] });
      mockWhatsAppDisplay.mockResolvedValueOnce(display);
      const res = mockResponse();
      await getConversationWithMessages(mockAuthRequest(1, { params: { conversationId: '58' }, query: {} }) as any, res);
      expect(res._status).toBe(200);
      expect(res._json.messages[0]).toMatchObject({ content: display });
      expect(res._json.messages[0]).not.toHaveProperty('redactedContent');
      expect(res._json.messages[1].content).toBe('Full name: Priya Shah');
      expect(mockWhatsAppDisplay).toHaveBeenCalledTimes(1);
      expect(mockWhatsAppDisplay).toHaveBeenCalledWith(1, 1, 58, mockMessage.id);
    });

    it('retains readable masked history when the original email is unavailable', async () => {
      const stored = { ...mockMessage, privacyVaultId: 73, content: 'Contact <[EMAIL_1]>' };
      OutreachConversationModel.getConversationWithMessages.mockResolvedValueOnce({ conversation: { ...mockConv, channel: 'email' }, messages: [stored] });
      mockEmailDisplay.mockResolvedValueOnce(null);
      const res = mockResponse();
      await getConversationWithMessages(mockAuthRequest(1, { params: { conversationId: '58' }, query: {} }) as any, res);
      expect(res._status).toBe(200);
      expect(res._json.messages[0].content).toBe(stored.content);
    });

    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { conversationId: '58' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getConversationWithMessages(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return 404 if conversation not found', async () => {
      OutreachConversationModel.getConversationWithMessages.mockResolvedValue({ conversation: null, messages: [] });
      const req = mockAuthRequest(1, { params: { conversationId: '9999' }, query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getConversationWithMessages(req as any, res);
      expect(res._status).toBe(404);
    });

    it('should return 403 if conversation belongs to another user', async () => {
      OutreachConversationModel.getConversationWithMessages.mockResolvedValue({
        conversation: { ...mockConv, userId: 99 },
        messages: [],
      });
      const req = mockAuthRequest(1, { params: { conversationId: '58' }, query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getConversationWithMessages(req as any, res);
      expect(res._status).toBe(403);
    });

    it('should return conversation with messages for owner', async () => {
      OutreachConversationModel.getConversationWithMessages.mockResolvedValue({
        conversation: { ...mockConv, userId: 1 },
        messages: [mockMessage],
      });
      OutreachConversationModel.markMessagesAsRead.mockResolvedValue(undefined);
      const req = mockAuthRequest(1, { params: { conversationId: '58' }, query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getConversationWithMessages(req as any, res);
      expect(res._status).toBe(200);
      expect(res._json.conversation).toBeDefined();
      expect(res._json.messages).toHaveLength(1);
      expect(OutreachConversationModel.markMessagesAsRead).toHaveBeenCalledWith(58);
    });

    it('keeps send bookkeeping and the masked model copy on the server', async () => {
      const internal = { aiPrompt: 'prompt', idempotencyKey: 'k', inboxSearchText: 's', privacyVaultId: 4, redactedContent: 'r',
        sendIntentId: 'i', sendClaimedAt: new Date(), sendAttemptCount: 2, providerCallState: 'confirmed',
        confirmationExpiresAt: new Date(), confirmedAt: new Date(), deliveryActionId: 9 };
      OutreachConversationModel.getConversationWithMessages.mockResolvedValueOnce({
        conversation: { ...mockConv, userId: 1 }, messages: [{ ...mockMessage, ...internal, metadata: { origin: 'ai' } }],
      });
      const res = mockResponse();
      await getConversationWithMessages(mockAuthRequest(1, { params: { conversationId: '58' }, query: {} }) as any, res);
      expect(res._status).toBe(200);
      for (const field of Object.keys(internal)) expect(res._json.messages[0]).not.toHaveProperty(field);
      expect(res._json.messages[0]).toMatchObject({ id: mockMessage.id, content: mockMessage.content, metadata: { origin: 'ai' } });
    });

    it('does not mark anything read when the reader opts out', async () => {
      OutreachConversationModel.getConversationWithMessages.mockResolvedValueOnce({ conversation: { ...mockConv, userId: 1 }, messages: [mockMessage] });
      OutreachConversationModel.markMessagesAsRead.mockClear();
      const res = mockResponse();
      await getConversationWithMessages(mockAuthRequest(1, { params: { conversationId: '58' }, query: { markRead: 'false' } }) as any, res);
      expect(res._status).toBe(200);
      expect(OutreachConversationModel.markMessagesAsRead).not.toHaveBeenCalled();
    });
  });

  describe('markConversationRead', () => {
    it("marks the owner's conversation read", async () => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv, userId: 1 });
      OutreachConversationModel.markMessagesAsRead.mockClear();
      const res = mockResponse();
      await markConversationRead(mockAuthRequest(1, { params: { conversationId: '58' } }) as any, res);
      expect(res._status).toBe(200);
      expect(OutreachConversationModel.markMessagesAsRead).toHaveBeenCalledWith(58);
    });

    it.each([
      ['another business', { ...mockConv, userId: 2 }, 403],
      ['a missing conversation', null, 404],
    ])('refuses %s', async (_label, conversation, status) => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce(conversation);
      OutreachConversationModel.markMessagesAsRead.mockClear();
      const res = mockResponse();
      await markConversationRead(mockAuthRequest(1, { params: { conversationId: '58' } }) as any, res);
      expect(res._status).toBe(status);
      expect(OutreachConversationModel.markMessagesAsRead).not.toHaveBeenCalled();
    });

    it('rejects an invalid conversation ID', async () => {
      const res = mockResponse();
      await markConversationRead(mockAuthRequest(1, { params: { conversationId: 'abc' } }) as any, res);
      expect(res._status).toBe(400);
    });
  });

  // ── sendMessage ───────────────────────────────────────────────────────
  describe('sendMessage', () => {
    it.each(['sent', 'delivered', 'read'])('returns later reconciled %s evidence instead of a cached unknown response without another send', async status => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv,
        userId: 1, channel: 'email', leadEmail: 'recipient@example.test', integrationProvider: 'gmail' });
      const { idempotencyService } = await import('../services/IdempotencyService.js');
      (idempotencyService.checkAndStore as any).mockResolvedValueOnce({ status: 'duplicate',
        previousResponse: JSON.stringify({ statusCode: 202, body: { success: false, manualReviewRequired: true } }) });
      OutreachConversationModel.getOutreachMessageByIdempotencyKey.mockResolvedValueOnce({ id: 100,
        status, providerCallState: 'confirmed', providerMessageId: 'reconciled-fixture', manualReviewRequired: false });
      const res = mockResponse();
      await sendMessage(mockAuthRequest(1, { params: { channel: 'email', conversationId: '58' },
        body: { content: 'Synthetic reconciled intent', idempotencyKey: 'same-reviewed-fixture' } }) as any, res);
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ success: true, inProgress: false, manualReviewRequired: false,
        message: { status, providerMessageId: 'reconciled-fixture' } });
      expect(mockGmailSend).not.toHaveBeenCalled();
      expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    });
    it.each([
      { outcome: 'accepted', result: { success: true, messageId: '<fixture@example.test>', providerMessageId: 'provider-fixture', outcomeUncertain: false }, status: 'sent', review: false, state: 'confirmed', http: 200 },
      { outcome: 'rejected', result: { success: false, error: 'Synthetic address rejected', deliveryAttempted: true, outcomeUncertain: false }, status: 'failed', review: false, state: 'rejected', http: 400 },
      { outcome: 'preflight failed', result: { success: false, error: 'Synthetic disconnected account', deliveryAttempted: false, outcomeUncertain: false }, status: 'failed', review: false, state: 'not_started', http: 400 },
      { outcome: 'timeout', result: { success: false, error: 'Synthetic timeout', deliveryAttempted: true, outcomeUncertain: true }, status: 'manual_review', review: true, state: 'unknown', http: 202 },
      { outcome: 'missing receipt', result: { success: true, rfcMessageId: '<local@example.test>' }, status: 'manual_review', review: true, state: 'unknown', http: 202 },
    ])('persists truthful Gmail $outcome evidence and retains its duplicate send intent', async fixture => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv,
        userId: 1, channel: 'email', leadEmail: 'recipient@example.test', integrationProvider: 'gmail', subject: 'Fixture' });
      OutreachConversationModel.createOutreachMessage.mockResolvedValueOnce({ id: 100, status: 'pending' });
      OutreachConversationModel.getMessagesByConversationId.mockResolvedValueOnce([]);
      mockGmailSend.mockResolvedValueOnce(fixture.result);
      const res = mockResponse();
      const req = mockAuthRequest(1, { params: { channel: 'email', conversationId: '58' },
        body: { content: 'Synthetic evidence fixture', idempotencyKey: 'synthetic-evidence-intent' } });
      await sendMessage(req as any, res);
      expect(res._status).toBe(fixture.http);
      expect(res._json.manualReviewRequired).toBe(fixture.review);
      expect(OutreachConversationModel.updateOutreachMessageStatus).toHaveBeenLastCalledWith(100, fixture.status,
        expect.objectContaining({ providerCallState: fixture.state, manualReviewRequired: fixture.review }));
      const { creditService } = await import('../services/CreditService.js');
      expect(creditService.refundDeduction).toHaveBeenCalledTimes(fixture.status === 'failed' ? 1 : 0);

      // Simulate cache replay: every outcome keeps the original key and cannot
      // cross the provider boundary again, even for an ambiguous response.
      const { idempotencyService } = await import('../services/IdempotencyService.js');
      (idempotencyService.checkAndStore as any).mockResolvedValueOnce({ status: 'duplicate',
        previousResponse: JSON.stringify({ statusCode: res._status, body: res._json }) });
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv,
        userId: 1, channel: 'email', leadEmail: 'recipient@example.test', integrationProvider: 'gmail' });
      await sendMessage(req as any, mockResponse());
      expect(mockGmailSend).toHaveBeenCalledTimes(1);
      expect(OutreachConversationModel.createOutreachMessage).toHaveBeenCalledTimes(1);
    });
    it.each(['es', 'missing'])('checks the Inbox WhatsApp template against its original account and %s language', async (language) => {
      const recipient = '919876543210';
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv, providerAccountId: 'original-account' });
      OutreachConversationModel.createOutreachMessage.mockResolvedValueOnce({ id: 100, status: 'pending' });
      mockInboxItem.mockResolvedValueOnce({ item: { recipient, reply: { canReply: true, providerAccountId: 'original-account' } } });
      const bindings = await import('../services/outreach/ProviderBindingService.js') as any;
      bindings.resolveOfficialProviderBinding.mockResolvedValueOnce({ providerAccountId: 'original-account', credentialId: 7 });
      const { whatsappApiService } = await import('../services/whatsappApiService.js') as any;
      whatsappApiService.listApprovedTemplates.mockResolvedValueOnce([{ name: 'proposal_update', language: 'es' }, { name: 'proposal_update', language: 'en_US' }]);
      const res = mockResponse();
      await sendMessage(mockAuthRequest(1, { params: { channel: 'whatsapp', conversationId: '58' }, body: {
        content: 'Hola', inboxContext: true, expectedProviderAccountId: 'original-account', expectedRecipient: recipient,
        templateName: 'proposal_update', templateLanguage: language, templateComponents: [], idempotencyKey: `template-${language}`,
        confirmation: { confirmed: true, conversationId: 58 },
      } }) as any, res);
      expect(whatsappApiService.listApprovedTemplates).toHaveBeenCalledWith(1, 'original-account');
      if (language === 'es') {
        expect(res._json.success).toBe(true);
        expect(whatsappApiService.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'original-account', language: 'es', templateName: 'proposal_update' }));
      } else {
        expect(res._json.success).toBe(false);
        expect(whatsappApiService.sendTemplate).not.toHaveBeenCalled();
      }
    });
    it('returns a provider failure that arrived before the Inbox send acknowledgement', async () => {
      const recipient = '919876543210';
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv, providerAccountId: 'original-account' });
      OutreachConversationModel.createOutreachMessage.mockResolvedValueOnce({ id: 100, status: 'pending' });
      OutreachConversationModel.updateOutreachMessageStatus.mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ id: 100, status: 'failed', errorMessage: 'Media upload error' });
      mockInboxItem.mockResolvedValueOnce({ item: { recipient, reply: { canReply: true, providerAccountId: 'original-account' } } });
      const bindings = await import('../services/outreach/ProviderBindingService.js') as any;
      bindings.resolveOfficialProviderBinding.mockResolvedValueOnce({ providerAccountId: 'original-account', credentialId: 7 });
      const { whatsappApiService } = await import('../services/whatsappApiService.js') as any;
      whatsappApiService.listApprovedTemplates.mockResolvedValueOnce([{ name: 'proposal_update', language: 'en' }]);
      const res = mockResponse();
      await sendMessage(mockAuthRequest(1, { params: { channel: 'whatsapp', conversationId: '58' }, body: {
        content: 'Template test', inboxContext: true, expectedProviderAccountId: 'original-account', expectedRecipient: recipient,
        templateName: 'proposal_update', templateLanguage: 'en', templateComponents: [], idempotencyKey: 'early-failure',
        confirmation: { confirmed: true, conversationId: 58 },
      } }) as any, res);
      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({ success: false, error: 'Media upload error', retryable: false });
      expect(whatsappApiService.sendTemplate).toHaveBeenCalledTimes(1);
    });
    it.each(['email', 'whatsapp', 'instagram', 'facebook', 'sms', 'linkedin', 'twitter'])(
      'dispatches an Inbox %s reply through its reviewed original account and recipient', async (channel) => {
        const accountId = channel === 'sms' ? 'ABCDEF' : 'original-account';
        const recipient = channel === 'email' ? 'original-recipient@example.test'
          : ['whatsapp', 'sms'].includes(channel) ? '919876543210' : 'original-recipient';
        OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({
          ...mockConv, channel, providerAccountId: accountId, externalThreadId: recipient,
          leadEmail: recipient, integrationProvider: channel === 'email' ? 'gmail' : null,
        });
        OutreachConversationModel.createOutreachMessage.mockResolvedValueOnce({ id: 100, status: 'pending' });
        OutreachConversationModel.getMessagesByConversationId.mockResolvedValueOnce([]);
        mockInboxItem.mockResolvedValueOnce({ item: {
          recipient, reply: { canReply: true, providerAccountId: accountId },
        } });
        const bindings = await import('../services/outreach/ProviderBindingService.js') as any;
        const binding = { providerAccountId: 'original-account', credentialId: 7 };
        if (['instagram', 'facebook', 'linkedin', 'twitter'].includes(channel)) {
          bindings.resolveOfficialSocialProviderBinding.mockResolvedValueOnce(binding);
        } else if (channel !== 'sms') {
          bindings.resolveOfficialProviderBinding.mockResolvedValueOnce(binding);
        }
        const { whatsappApiService } = await import('../services/whatsappApiService.js') as any;
        if (channel === 'whatsapp') {
          mockDbExecute.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 });
          whatsappApiService.sendText.mockResolvedValueOnce({ messages: [{ id: 'wamid.inbox' }] });
        }
        const req = mockAuthRequest(1, { params: { channel, conversationId: '58' }, body: {
          content: 'Reviewed Inbox reply', inboxContext: true, expectedProviderAccountId: accountId,
          expectedRecipient: recipient, idempotencyKey: `inbox-${channel}-dispatch`,
          confirmation: { confirmed: true, conversationId: 58 },
        } });
        const res = mockResponse();
        await sendMessage(req as any, res);
        expect({ status: res._status, success: res._json.success, error: res._json.error }).toEqual({ status: 200, success: true, error: undefined });
        if (channel === 'email') {
          expect(mockGmailSend).toHaveBeenCalledWith(1, expect.objectContaining({
            to: recipient, accountBinding: { credentialId: 7, accountIdentifier: 'original-account' }, skipConversationLog: true,
          }));
        } else if (channel === 'whatsapp') {
          expect(whatsappApiService.sendText).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'original-account', to: recipient }));
        } else if (channel === 'sms') {
          expect(mockSmsSend).toHaveBeenCalledWith(1, recipient, 'Reviewed Inbox reply', undefined, 'ABCDEF');
          expect(OutreachConversationModel.createOutreachMessage).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: 'ABCDEF', metadata: expect.objectContaining({ origin: 'inbox', smsRecipient: recipient }) }));
        } else {
          const adapter = channel === 'instagram' ? (await import('../services/instagramService')).sendInstagramDM
            : channel === 'facebook' ? (await import('../services/FacebookMessengerService')).sendFacebookDM
              : channel === 'linkedin' ? (await import('../services/LinkedInApiService')).sendLinkedInDM
                : (await import('../services/TwitterApiService')).sendTwitterDM;
          expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
            [channel === 'linkedin' ? 'recipientUrn' : 'recipientId']: recipient,
            providerAccountId: 'original-account', message: 'Reviewed Inbox reply',
          }));
        }
      },
    );

    it.each([
      { status: 'duplicate', previousResponse: null },
      { status: 'duplicate', previousResponse: JSON.stringify({ statusCode: 200, body: { success: true } }) },
    ])('does not dispatch a duplicate Inbox send (%j)', async (claim) => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv, channel: 'sms' });
      mockInboxItem.mockResolvedValueOnce({ item: { recipient: '919876543210', reply: { canReply: true, providerAccountId: 'ABCDEF' } } });
      const { idempotencyService } = await import('../services/IdempotencyService.js') as any;
      idempotencyService.checkAndStore.mockResolvedValueOnce(claim);
      const res = mockResponse();
      await sendMessage(mockAuthRequest(1, { params: { channel: 'sms', conversationId: '58' }, body: {
        content: 'Reviewed Inbox reply', inboxContext: true, expectedProviderAccountId: 'ABCDEF',
        expectedRecipient: '919876543210', idempotencyKey: 'inbox-duplicate-key',
      } }) as any, res);
      expect(res._status).toBe(claim.previousResponse ? 200 : 202);
      expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
      expect(mockSmsSend).not.toHaveBeenCalled();
      expect(idempotencyService.checkAndStore).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ failClosed: true }));
    });

    it.each([
      { canReply: false, reason: 'The lead opted out.', providerAccountId: 'account-a', recipient: 'recipient-a', expectedAccount: 'account-a', expectedRecipient: 'recipient-a' },
      { canReply: true, reason: null, providerAccountId: 'account-b', recipient: 'recipient-a', expectedAccount: 'account-a', expectedRecipient: 'recipient-a' },
      { canReply: true, reason: null, providerAccountId: 'account-a', recipient: 'changed-recipient', expectedAccount: 'account-a', expectedRecipient: 'recipient-a' },
    ])('blocks an unavailable or changed Inbox destination before creating a send intent (%j)', async (availability) => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValue(mockConv);
      mockInboxItem.mockResolvedValue({ item: { reply: availability, recipient: availability.recipient } });
      const req = mockAuthRequest(1, { params: { channel: 'whatsapp', conversationId: '58' }, body: {
        content: 'Reviewed message', inboxContext: true, expectedProviderAccountId: availability.expectedAccount, expectedRecipient: availability.expectedRecipient,
      } });
      const res = mockResponse();
      await sendMessage(req as any, res);
      expect(res._status).toBe(409);
      expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    });
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { conversationId: '58' }, body: { content: 'hello' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendMessage(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if content is missing', async () => {
      const req = mockAuthRequest(1, { params: { conversationId: '58' }, body: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendMessage(req as any, res);
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/content is required/i);
    });

    it('should return 404 if conversation not found', async () => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValue(null);
      const req = mockAuthRequest(1, { params: { conversationId: '9999' }, body: { content: 'hello' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendMessage(req as any, res);
      expect(res._status).toBe(404);
    });

    it('should return 403 if user does not own conversation', async () => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValue({ ...mockConv, userId: 99 });
      const req = mockAuthRequest(1, { params: { conversationId: '58' }, body: { content: 'hello' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendMessage(req as any, res);
      expect(res._status).toBe(403);
    });

    it('should send WhatsApp message and return 200', async () => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValue({ ...mockConv, userId: 1 });
      OutreachConversationModel.createOutreachMessage.mockResolvedValue({ id: 100, status: 'pending' });
      OutreachConversationModel.updateOutreachMessage.mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { whatsappApiService } = await import('../services/whatsappApiService.js') as any;
      const bindings = await import('../services/outreach/ProviderBindingService.js') as any;
      bindings.resolveOfficialProviderBinding.mockResolvedValueOnce({ providerAccountId: '1095711443622725' });
      whatsappApiService.sendText.mockResolvedValue({ messages: [{ id: 'wamid.sent123' }] });
      // A free-form WhatsApp reply is allowed only while the 24-hour inbound
      // conversation window is open.
      mockDbExecute.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 });
      const req = mockAuthRequest(1, {
        params: { conversationId: '58', channel: 'whatsapp' },
        body: { content: 'Hello Mahesh!' },
      });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendMessage(req as any, res);
      expect({ status: res._status, body: res._json }).toEqual({
        status: 200,
        body: expect.objectContaining({ success: true }),
      });
      expect(bindings.resolveOfficialProviderBinding).toHaveBeenCalledWith(1, 'whatsapp', {
        providerAccountId: '1095711443622725',
      });
      expect(whatsappApiService.sendText).toHaveBeenCalledWith(expect.objectContaining({
        phoneNumberId: '1095711443622725',
      }));
    });

    it('marks a WhatsApp disconnect detected before dispatch as failed, not uncertain', async () => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValue({ ...mockConv, userId: 1 });
      OutreachConversationModel.createOutreachMessage.mockResolvedValue({ id: 100, status: 'pending' });
      const { whatsappApiService } = await import('../services/whatsappApiService.js') as any;
      const bindings = await import('../services/outreach/ProviderBindingService.js') as any;
      const { creditService } = await import('../services/CreditService.js') as any;
      bindings.resolveOfficialProviderBinding.mockResolvedValueOnce({ providerAccountId: '1095711443622725' });
      whatsappApiService.sendText.mockRejectedValueOnce(Object.assign(
        new Error('WhatsApp not connected. Please configure WhatsApp integration first.'),
        { deliveryAttempted: false, outcomeUncertain: false, retryable: false },
      ));
      mockDbExecute.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 });

      const req = mockAuthRequest(1, {
        params: { conversationId: '58', channel: 'whatsapp' },
        body: { content: 'Hello again' },
      });
      const res = mockResponse();
      await sendMessage(req as any, res);

      expect(res._status).toBe(409);
      expect(res._json).toMatchObject({
        success: false,
        code: 'OUTREACH_PROVIDER_NOT_READY',
        manualReviewRequired: false,
      });
      expect(res._json.error).toContain('WhatsApp not connected');
      expect(OutreachConversationModel.updateOutreachMessageStatus).toHaveBeenLastCalledWith(
        100,
        'failed',
        expect.objectContaining({ providerCallState: 'not_started', manualReviewRequired: false }),
      );
      expect(creditService.refundDeduction).toHaveBeenCalled();
    });

    it('returns a timed Gmail rate limit as a rejected send and refunds its reserved credit', async () => {
      const retryAt = new Date(Date.now() + 7200_000).toISOString();
      OutreachConversationModel.getOutreachConversationById.mockResolvedValue({
        ...mockConv, channel: 'email', leadEmail: 'mahesh@orocircle.com', integrationProvider: 'gmail', subject: 'Hello',
      });
      OutreachConversationModel.createOutreachMessage.mockResolvedValue({ id: 101, status: 'pending' });
      mockGmailSend.mockResolvedValueOnce({ success: false, error: `User-rate limit exceeded. Retry after ${retryAt}`,
        deliveryAttempted: true, outcomeUncertain: false, retryable: true, retryAt });
      const req = mockAuthRequest(1, { params: { conversationId: '58', channel: 'email' }, body: { content: 'Following up' } });
      const res = mockResponse();
      const header = jest.spyOn(res, 'setHeader');
      await sendMessage(req as Parameters<typeof sendMessage>[0], res);
      expect(res._status).toBe(429);
      expect(res._json).toMatchObject({ code: 'EMAIL_RATE_LIMITED', retryable: true, retryAt, manualReviewRequired: false });
      expect(header).toHaveBeenCalledWith('Retry-After', expect.any(String));
      expect(OutreachConversationModel.updateOutreachMessageStatus).toHaveBeenCalledWith(101, 'failed',
        expect.objectContaining({ providerCallState: 'rejected', manualReviewRequired: false }));
      const { creditService } = await import('../services/CreditService.js');
      expect(creditService.refundDeduction).toHaveBeenCalled();
    });

    it('keeps a Gmail follow-up in the selected provider thread with exact RFC IDs', async () => {
      OutreachConversationModel.getOutreachConversationById.mockResolvedValue({
        ...mockConv,
        userId: 1,
        channel: 'email',
        leadEmail: 'mahesh@orocircle.com',
        integrationProvider: 'gmail',
        externalThreadId: 'gmail-thread-1',
        subject: 'Original subject',
      });
      OutreachConversationModel.createOutreachMessage.mockResolvedValue({ id: 101, status: 'pending' });
      OutreachConversationModel.getMessagesByConversationId.mockResolvedValue([
        {
          id: 90,
          direction: 'outbound',
          status: 'sent',
          subject: 'Original subject',
          rfcMessageId: '<first@example.com>',
        },
        { id: 101, direction: 'outbound', status: 'pending' },
      ]);
      mockGmailSend.mockClear();

      const req = mockAuthRequest(1, {
        params: { conversationId: '58', channel: 'email' },
        body: { content: 'Following up', subject: 'Changed subject' },
      });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendMessage(req as any, res);

      expect(mockGmailSend).toHaveBeenCalledWith(1, expect.objectContaining({
        subject: 'Original subject',
        threadId: 'gmail-thread-1',
        inReplyTo: '<first@example.com>',
        references: '<first@example.com>',
      }));
      expect(OutreachConversationModel.updateOutreachMessageStatus).toHaveBeenCalledWith(
        101,
        'sent',
        expect.objectContaining({
          providerMessageId: '18fabc123',
          rfcMessageId: '<second@example.com>',
        })
      );
      expect(res._status).toBe(200);
    });
  });

  describe('createConversation threading cardinality', () => {
    beforeEach(async () => {
      const binding = await import('../services/outreach/ProviderBindingService.js');
      (binding.resolveOfficialSocialProviderBinding as jest.Mock<any>).mockResolvedValue({ providerAccountId: 'account-a' });
    });
    it('creates separate email threads for repeated forceNew requests', async () => {
      OutreachConversationModel.createOutreachConversation
        .mockResolvedValueOnce({ ...mockConv, id: 201, channel: 'email', threadKey: 'thread-a' })
        .mockResolvedValueOnce({ ...mockConv, id: 202, channel: 'email', threadKey: 'thread-b' });

      for (const subject of ['Campaign A', 'Campaign B']) {
        const req = mockAuthRequest(1, {
          body: { leadId: 163, channel: 'email', forceNew: true, subject },
        });
        const res = mockResponse();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await createConversation(req as any, res);
        expect(res._status).toBe(200);
      }

      expect(OutreachConversationModel.createOutreachConversation).toHaveBeenCalledTimes(2);
      expect(OutreachConversationModel.getConversationByLeadAndChannel).not.toHaveBeenCalled();
    });

    it.each(['instagram', 'facebook', 'whatsapp'])(
      'reuses the canonical %s conversation even when forceNew is supplied',
      async (channel) => {
        OutreachConversationModel.getConversationByLeadAndChannel.mockResolvedValue({
          ...mockConv,
          channel,
        });
        const req = mockAuthRequest(1, {
          body: { leadId: 163, channel, forceNew: true, providerAccountId: 'account-a' },
        });
        const res = mockResponse();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await createConversation(req as any, res);

        expect(res._json.isExisting).toBe(true);
        if (['facebook', 'instagram'].includes(channel)) expect(OutreachConversationModel.getConversationByLeadAndChannel).toHaveBeenCalledWith(1, 163, channel, 'account-a');
        expect(OutreachConversationModel.createOutreachConversation).not.toHaveBeenCalled();
      }
    );

    it.each(['instagram', 'facebook', 'whatsapp'])(
      'uses race-safe get-or-create for the first %s conversation',
      async (channel) => {
        OutreachConversationModel.getConversationByLeadAndChannel.mockResolvedValue(null);
        OutreachConversationModel.getOrCreateConversation.mockResolvedValue({
          ...mockConv,
          channel,
        });
        const req = mockAuthRequest(1, {
          body: { leadId: 163, channel },
        });
        const res = mockResponse();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await createConversation(req as any, res);

        expect(OutreachConversationModel.getOrCreateConversation).toHaveBeenCalledTimes(1);
        expect(OutreachConversationModel.createOutreachConversation).not.toHaveBeenCalled();
        expect(res._status).toBe(200);
      }
    );
  });

  describe('Meta reply account boundary', () => {
    it.each(['facebook', 'instagram'] as const)('never substitutes a default account when the %s binding is unavailable', async channel => {
      const bindings = await import('../services/outreach/ProviderBindingService.js');
      (bindings.resolveOfficialSocialProviderBinding as jest.Mock<any>).mockResolvedValueOnce(null);
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv, channel, providerAccountId: 'account-b' });
      const req = mockAuthRequest(1, { params: { channel, conversationId: '58' }, body: { content: 'A reviewed reply', confirmation: { confirmed:true, conversationId:58 } } });
      const res = mockResponse(); await sendMessage(req as any, res);
      expect(bindings.resolveOfficialSocialProviderBinding).toHaveBeenCalledWith(1, channel, {providerAccountId:'account-b'});
      expect(res._status).toBe(409);
      expect(res._json.code).toBe('CONVERSATION_ACCOUNT_UNAVAILABLE');
      expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    });
  });

  describe('official social provider requirement', () => {
    it.each(['twitter', 'linkedin'] as const)('rejects %s sends without an official binding even when a browser session is claimed', async channel => {
      const bindings = await import('../services/outreach/ProviderBindingService.js');
      (bindings.resolveOfficialSocialProviderBinding as jest.Mock<any>).mockResolvedValueOnce(null);
      OutreachConversationModel.getOutreachConversationById.mockResolvedValueOnce({ ...mockConv, channel, providerAccountId: null });
      const req = mockAuthRequest(1, {
        params: { channel, conversationId: '58' },
        body: {
          content: 'A reviewed reply',
          confirmation: {
            confirmed: true,
            conversationId: 58,
            allowUserMediatedBrowserAssistance: true,
            sessionId: 'claimed-session',
          },
        },
      });
      const res = mockResponse();
      await sendMessage(req as any, res);
      expect(res._status).toBe(409);
      expect(res._json.code).toBe('OUTREACH_PROVIDER_NOT_READY');
      expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    });
  });

  // ── deleteConversation ────────────────────────────────────────────────
  describe('deleteConversation', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { conversationId: '58' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deleteConversation(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return 404 if conversation not found or access denied', async () => {
      OutreachConversationModel.deleteOutreachConversation.mockResolvedValue(null);
      const req = mockAuthRequest(1, { params: { conversationId: '58' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deleteConversation(req as any, res);
      expect(res._status).toBe(404);
    });

    it('should delete conversation and return 200', async () => {
      OutreachConversationModel.deleteOutreachConversation.mockResolvedValue(mockConv);
      const req = mockAuthRequest(1, { params: { conversationId: '58' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deleteConversation(req as any, res);
      expect(res._status).toBe(200);
    });
  });

  // ── getUnreadCounts ───────────────────────────────────────────────────
  describe('getUnreadCounts', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getUnreadCounts(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return unread counts for authenticated user', async () => {
      OutreachConversationModel.getUnreadCounts.mockResolvedValue({ email: 1, whatsapp: 2 });
      const req = mockAuthRequest(1);
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getUnreadCounts(req as any, res);
      expect(res._status).toBe(200);
      expect(OutreachConversationModel.getUnreadCountByChannel).not.toHaveBeenCalledWith(1, 'gmail');
    });
  });

  // ── searchConversations ───────────────────────────────────────────────
  describe('searchConversations', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: { q: 'mahesh' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await searchConversations(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if query is missing', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await searchConversations(req as any, res);
      expect(res._status).toBe(400);
    });

    it('should return search results', async () => {
      OutreachConversationModel.searchConversations.mockResolvedValue([mockConv]);
      const req = mockAuthRequest(1, { query: { q: 'mahesh' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await searchConversations(req as any, res);
      expect(res._status).toBe(200);
      expect(res._json.conversations).toBeDefined();
    });
  });

  // ── deleteOutreachMessageHandler ──────────────────────────────────────
  describe('deleteOutreachMessageHandler', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { messageId: '956' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deleteOutreachMessageHandler(req as any, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if messageId is not a valid number', async () => {
      const req = mockAuthRequest(1, { params: { messageId: 'abc' } });
      const res = mockResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deleteOutreachMessageHandler(req as any, res);
      expect(res._status).toBe(400);
    });
  });
});

describe('reviewed creation batches', () => {
  const attachmentId = 'a0000000-0000-4000-8000-000000000001';
  const binding = { providerAccountId: 'account-a' };
  const account = { senderId: 7, provider: 'gmail', providerAccountId: 'account-a', ready: true, reason: null };
  const body = () => ({ creationVersion: 1, channel: 'email', providerAccountId: 'account-a', idempotencyKey: 'reviewed-test-key', confirmation: { confirmed: true, channel: 'email', recipientCount: 1 }, messages: [{ leadId: 163, senderId: 7, expectedRecipient: 'ada@example.com', subject: 'Hello', message: 'Hello Ada', followUps: [] }] });
  async function run(payload: Record<string, unknown>) {
    const res = mockResponse();
    await withBusinessScope({ userId: 1, businessProfileId: 11 }, () => bulkCreateConversations(mockAuthRequest(1, { body: payload, get: () => undefined }) as any, res));
    return res;
  }
  beforeEach(async () => {
    jest.clearAllMocks();
    creationAccount.mockResolvedValue({ account, binding });
    creationRecipients.mockResolvedValue({ recipients: [{ id: 163, eligible: true, recipient: 'ada@example.com' }, { id: 164, eligible: true, recipient: 'grace@example.com' }] });
    creationTemplates.mockResolvedValue([{ id: 'welcome', name: 'welcome', language: 'en_US', body: 'Hello Ada' }]);
    mockDbExecute.mockResolvedValue({ rows: [], rowCount: 0 });
    const bindings = await import('../services/outreach/ProviderBindingService.js') as any;
    bindings.resolveOfficialProviderBinding.mockResolvedValue(binding);
    const idempotency = await import('../services/IdempotencyService.js') as any;
    idempotency.idempotencyService.checkAndStore.mockResolvedValue({ status: 'fresh' });
    OutreachConversationModel.createOutreachConversation.mockImplementation(async (input: any) => ({ ...input, id: 99 }));
    OutreachConversationModel.getOrCreateConversation.mockImplementation(async (input: any) => ({ ...input, id: 99 }));
    let messageId = 100;
    OutreachConversationModel.createOutreachMessage.mockImplementation(async (input: any) => ({ ...input, id: messageId++, sendIntentId: `intent-${messageId}` }));
  });
  it('rejects account substitution and missing review confirmation before creating messages', async () => {
    expect((await run({ ...body(), providerAccountId: 'different-account' }))._status).toBe(409);
    expect((await run({ ...body(), confirmation: undefined }))._status).toBe(409);
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    expect(queuedCreation).not.toHaveBeenCalled();
  });
  it('persists campaign manual review and frozen steps on each new origin without global settings fallback',async()=>{
    manualEnrollment.mockResolvedValue({version:1,campaign:{kind:'chat_thread',id:44},channel:'email',sequenceVersion:3,sequenceChecksum:'pinned',reviewId:'manual-review',userId:1,businessProfileId:11,leadId:163,recipient:'ada@example.com',steps:[{delayMinutes:60,message:'HR offer follow-up',sourceTemplateId:22,sourceTemplateVersion:4}]});
    manualAdmission.mockResolvedValue(undefined);
    const res=await run({...body(),campaignManualReviewId:'manual-review'});
    expect(res._json).toMatchObject({queued:1,errors:0});
    expect(manualEnrollment).toHaveBeenCalledWith(1,'email','manual-review',163,'ada@example.com');
    expect(manualAdmission).toHaveBeenCalledWith(1,100,expect.objectContaining({campaign:{kind:'chat_thread',id:44},sequenceVersion:3}));
    expect(OutreachConversationModel.createOutreachMessage).toHaveBeenCalledWith(expect.objectContaining({metadata:expect.objectContaining({outreachCreation:expect.objectContaining({followUpSource:'campaign_manual',campaignManual:expect.objectContaining({reviewId:'manual-review'}),followUps:[expect.objectContaining({message:'HR offer follow-up',sourceTemplateVersion:4})]})})}));
    expect(queuedCreation.mock.calls[0][1]).toMatchObject({campaignManualReviewId:'manual-review',conversationId:99});
  });
  it('rejects stale manual review and manual content lacking campaign before any origin is created',async()=>{
    manualEnrollment.mockRejectedValueOnce(new ManualReviewError('Review this campaign again.'));
    expect((await run({...body(),campaignManualReviewId:'stale-review'}))._status).toBe(409);
    const input=body();expect((await run({...input,messages:[{...input.messages[0],followUps:[{delayMinutes:60,message:'Unscoped manual'}]}]}))._status).toBe(409);
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();expect(queuedCreation).not.toHaveBeenCalled();
  });
  it('rejects global manual templates instead of enrolling CXO defaults into a different campaign',async()=>{
    mockDbExecute.mockResolvedValueOnce({rows:[{config:{enabled:true,followUps:[{enabled:true,templateId:88}]}}]});
    const res=await run({...body(),useSavedFollowUpSettings:true});expect(res._status).toBe(409);expect(res._json.code).toBe('CAMPAIGN_REQUIRED');
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();expect(queuedCreation).not.toHaveBeenCalled();
  });
  it('stores saved platform follow-ups as the single scheduling source', async () => {
    const res = await run({ ...body(), useSavedFollowUpSettings: true });
    expect(res._json).toMatchObject({ queued: 1, errors: 0 });
    expect(OutreachConversationModel.createOutreachMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ outreachCreation: expect.objectContaining({ followUpSource: 'channel_settings', followUps: [] }) }),
    }));
  });
  it('pins one outreach sequence on its origin without reading or modifying channel defaults', async () => {
    const input = body();
    const steps = [{ delayMinutes: 60, message: 'Only this outreach' }];
    const res = await run({ ...input, followUpSource: 'outreach', messages: [{ ...input.messages[0], followUps: steps }] });
    expect(res._json).toMatchObject({ queued: 1, errors: 0 });
    expect(OutreachConversationModel.createOutreachMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
      outreachCreation: expect.objectContaining({ followUpSource: 'outreach', followUps: steps }),
    }) }));
    expect(manualEnrollment).not.toHaveBeenCalled();
    const { sql } = await import('drizzle-orm');
    const statements = jest.mocked(sql).mock.calls.map(call => Array.isArray(call[0]) ? call[0].join('') : '').join('\n');
    // The daily sending limit still comes from outreach_settings; follow-up
    // configuration must neither be read nor written for an outreach-local batch.
    expect(statements).not.toMatch(/SELECT\s+config\s+FROM\s+outreach_settings|(?:UPDATE|INSERT INTO|DELETE FROM)\s+outreach_settings|channel_follow_ups/i);
  });
  it('rejects mixing outreach-only timing with defaults or a campaign sequence', async () => {
    expect((await run({ ...body(), followUpSource: 'outreach', useSavedFollowUpSettings: true }))._status).toBe(400);
    expect((await run({ ...body(), followUpSource: 'outreach', campaignManualReviewId: 'other' }))._status).toBe(400);
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
  });
  it('shares batch admission with the card and binds jobs to its trusted identity', async () => {
    const { executeOutreachBatch } = await import('../controllers/outreachConversationsController.js');
    const result = await withBusinessScope({ userId: 1, businessProfileId: 11 }, () => executeOutreachBatch(1, { ...body(), followUpSource: 'outreach' }, 'campaign-widget-44', { id: 44, threadId: 22 }));
    expect(result.body).toMatchObject({ queued: 1, errors: 0 });
    expect(queuedCreation.mock.calls[0][1]).toMatchObject({ widgetId: 44, threadId: 22, expectedWidgetJobCount: 1 });
    expect(OutreachConversationModel.createOutreachMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outreachCreation: expect.objectContaining({ followUpSource: 'outreach', followUps: [] }) }) }));
  });
  it('releases a card request key only when every recipient failed before a message was created', async () => {
    const { executeOutreachBatch } = await import('../controllers/outreachConversationsController.js');
    const { idempotencyService } = await import('../services/IdempotencyService.js');
    creationRecipients.mockResolvedValue({ recipients: [{ id: 163, eligible: false, reason: 'Fix this recipient', recipient: '' }] });
    const result = await withBusinessScope({ userId: 1, businessProfileId: 11 }, () => executeOutreachBatch(1, { ...body(), followUpSource: 'outreach' }, 'campaign-widget-44', { id: 44, threadId: 22 }));
    expect(result.body).toMatchObject({ queued: 0, errors: 1 });
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    expect(idempotencyService.forget).toHaveBeenCalledTimes(1);
  });
  it('rejects combining saved platform follow-ups with separate steps before queueing', async () => {
    const payload = body();
    const res = await run({ ...payload, useSavedFollowUpSettings: true, messages: [{ ...payload.messages[0], followUps: [{ delayMinutes: 60, message: 'Duplicate follow-up' }] }] });
    expect(res._status).toBe(400);
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    expect(queuedCreation).not.toHaveBeenCalled();
  });
  it('binds a reviewed SMS batch to its exact sender and persists its recipient for future delivery reports', async () => {
    const smsBinding = { providerAccountId: 'ABCDEF', credentialId: 31, platform: 'msg91_sms' };
    creationAccount.mockResolvedValue({ account: { providerAccountId: 'ABCDEF', ready: true }, binding: smsBinding });
    creationRecipients.mockResolvedValue({ recipients: [{ id: 163, eligible: true, recipient: '919876543210' }] });
    const bindings = await import('../services/outreach/ProviderBindingService.js') as any;
    bindings.resolveOfficialProviderBinding.mockResolvedValueOnce(smsBinding);
    OutreachConversationModel.getOrCreateConversation.mockResolvedValueOnce({ ...mockConv, id: 99, channel: 'sms', providerAccountId: 'OLDKEY' });
    const res = await run({
      ...body(), channel: 'sms', providerAccountId: 'ABCDEF',
      confirmation: { confirmed: true, channel: 'sms', recipientCount: 1 },
      messages: [{ leadId: 163, expectedRecipient: '919876543210', message: 'Hello Ada', followUps: [] }],
    });
    expect(res._json.results).toEqual([expect.objectContaining({ status: 'queued' })]);
    expect(res._json).toMatchObject({ queued: 1, errors: 0 });
    expect(OutreachConversationModel.updateOutreachConversation).toHaveBeenCalledWith(99, { providerAccountId: 'ABCDEF' });
    expect(OutreachConversationModel.createOutreachMessage).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: 'ABCDEF', metadata: expect.objectContaining({ smsRecipient: '919876543210' }),
    }));
    expect(queuedCreation.mock.calls[0][1]).toMatchObject({ channel: 'sms', phone: '919876543210' });
  });
  it('rejects an address changed after preview even if the lead is still eligible', async () => {
    const payload = body(); payload.messages[0].expectedRecipient = 'previous@example.com';
    const res = await run(payload);
    expect(res._json).toMatchObject({ queued: 0, errors: 1, results: [{ error: expect.stringContaining('recipient changed after review') }] });
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
    expect(queuedCreation).not.toHaveBeenCalled();
  });
  it('binds scheduled email delivery to canonical addresses and shares attachments across separate Inbox threads', async () => {
    const planned = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    const payload = { ...body(), scheduledAt: planned, attachments: [attachmentId], confirmation: { confirmed: true, channel: 'email', recipientCount: 2 }, messages: [...body().messages, { ...body().messages[0], leadId: 164, expectedRecipient: 'grace@example.com', recipientEmail: 'client-override@example.com' }] };
    const res = await run(payload);
    expect(res._json).toMatchObject({ queued: 2, errors: 0, attachmentSourceMessageId: 100 });
    const attachments = await import('../services/OutreachAttachmentService.js') as any;
    expect(attachments.outreachAttachmentService.claimForMessage).toHaveBeenCalledWith(1, 100, [attachmentId]);
    expect(copyCreationAttachments).toHaveBeenCalledWith(1, 100, 101, undefined);
    expect(OutreachConversationModel.createOutreachConversation.mock.calls[0][0]).toMatchObject({ providerAccountId: 'account-a', integrationProvider: 'gmail' });
    expect(OutreachConversationModel.createOutreachMessage.mock.calls[0][0]).toMatchObject({ providerAccountId: 'account-a', metadata: { scheduledAt: planned, outreachCreation: { version: 1, delivery: { senderId: 7, recipientEmail: 'ada@example.com' } } } });
    expect(queuedCreation.mock.calls[1][1]).toMatchObject({ recipientEmail: 'grace@example.com', senderId: 7, messageId: 101 });
    expect(queuedCreation.mock.calls[0][2]).toMatchObject({ jobId: expect.stringContaining('outreach-send-intent-'), delay: expect.any(Number) });
    expect((queuedCreation.mock.calls[0][2] as { delay: number }).delay).toBeGreaterThan(47 * 60 * 60_000);
  });
  it('keeps attachments and stable intent IDs while queue confirmation needs review', async () => {
    queuedCreation.mockRejectedValueOnce(new Error('Queue temporarily unavailable'));
    const res = await run({ ...body(), attachments: [attachmentId] });
    expect(res._json).toMatchObject({ queued:0, errors:0, uncertain:1, attachmentSourceMessageId:100, results:[{status:'uncertain',messageId:100}] });
    expect(OutreachConversationModel.updateOutreachMessageStatus).not.toHaveBeenCalledWith(100,'failed',expect.anything());
  });
  it('requires WhatsApp consent, verifies the template language and stores its current definition', async () => {
    creationAccount.mockResolvedValue({ account: { ...account, senderId: undefined }, binding });
    creationRecipients.mockResolvedValue({ recipients: [{ id: 163, eligible: true, recipient: '919876543210', requiresTemplate: true }] });
    const payload = { ...body(), channel: 'whatsapp', confirmation: { confirmed: true, channel: 'whatsapp', recipientCount: 1 }, messages: [{ leadId: 163, expectedRecipient: '919876543210', message: 'Hello Ada', templateName: 'welcome', templateLanguage: 'es', templateComponents: [] }] };
    expect((await run(payload))._status).toBe(400);
    expect((await run({ ...payload, whatsappOptInConfirmed: true }))._json.queued).toBe(0);
    payload.messages[0].templateLanguage = 'en_US';
    const res = await run({ ...payload, whatsappOptInConfirmed: true });
    expect(res._json.queued).toBe(1);
    expect(queuedCreation.mock.calls[0][1]).toMatchObject({ phone: '919876543210', templateLanguage: 'en_US', templateDefinitionHash: 'reviewed-template' });
  });
  it('returns a cached accepted batch without creating messages or queueing a second send', async () => {
    const idempotency = await import('../services/IdempotencyService.js') as any;
    const {followUpSettingsRevision}=await import('../utils/followUpSettingsRevision.js');
    const {idempotencyKey:_key,...reviewed}=body();
    idempotency.idempotencyService.checkAndStore.mockResolvedValue({status:'duplicate',previousResponse:JSON.stringify({requestHash:followUpSettingsRevision(reviewed),statusCode:200,body:{success:true,queued:1}})});
    const res = await run(body());
    expect(res._json).toEqual({ success: true, queued: 1 });
    expect(queuedCreation).not.toHaveBeenCalled();
    expect(OutreachConversationModel.createOutreachMessage).not.toHaveBeenCalled();
  });
});
