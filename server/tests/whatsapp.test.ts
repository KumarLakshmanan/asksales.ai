/**
 * WhatsApp Controller Tests
 * Tests: getWhatsAppConfig, saveWhatsAppConfig, deleteWhatsAppConfig,
 *        verifyWebhook, handleWebhook, testWhatsAppConnection,
 *        sendWhatsAppText
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────
const persistEcho = jest.fn<any>().mockResolvedValue(1);
const registerTurn = jest.fn<any>().mockResolvedValue(undefined);
jest.unstable_mockModule('../services/SocialMessagePersistence.js', () => ({
  persistNativeSocialMessage: persistEcho, lockSocialProviderMessage: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportConversationTurn.js', () => ({ registerSupportTurnInput: registerTurn }));
jest.unstable_mockModule('../services/InboundContactResolver.js', () => ({ inboundContactResolver: { reconcile: jest.fn<any>().mockResolvedValue(null) } }));
jest.unstable_mockModule('../services/OutreachAttachmentService.js', () => ({ outreachAttachmentService: {} }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
  whatsappDisplayText: (text: string) => text,
  privacyVaultService: { protectInbound: jest.fn<any>().mockImplementation(async ({ rawText }: { rawText: string }) => ({ redactedText: rawText, vaultId: 1 })) },
}));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ cancelSocialFollowUpsForConversation: jest.fn<any>().mockResolvedValue(undefined) }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../services/credentialService', () => ({
  getCredential: jest.fn(),
  saveCredential: jest.fn(),
  deleteCredential: jest.fn(),
  CredentialService: {
    getCredential: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveCredential: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteCredential: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('../services/whatsappApiService.js', () => ({
  whatsappApiService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveCreds: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordReadiness: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendText: jest.fn<any>().mockResolvedValue({ success: true, wamid: 'wamid.test123' }),
  },
}));

jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: jest.fn<any>().mockResolvedValue({ rows: [] }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: jest.fn<any>().mockReturnValue({
      from: jest.fn<any>().mockReturnValue({
        where: jest.fn<any>().mockImplementation(() => Object.assign(Promise.resolve([]), {
          limit: jest.fn<any>().mockResolvedValue([]),
        })),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: jest.fn<any>().mockImplementation(async (callback: any) => callback({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: jest.fn<any>().mockResolvedValue({ rows: [] }),
    })),
  },
}));

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  decryptAdminCredential: jest.fn((value) => value),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getActiveAdminCredential: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminCredentialsByPlatform: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllActiveAdminCredentials: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNextActiveAdminCredential: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  markAdminCredentialInactive: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateAdminCredentialLastUsed: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminCredentialById: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminCredentialForActor: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createAdminCredential: jest.fn<any>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateAdminCredential: jest.fn<any>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteAdminCredential: jest.fn<any>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toggleAdminCredential: jest.fn<any>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recordAdminCredentialAudit: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateAdminCredentialValidation: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listAdminCredentialAudit: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllAdminCredentials: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAdminCredentialStats: jest.fn<any>().mockResolvedValue({}),
}));

jest.unstable_mockModule('../utils/metaWebhookValidator.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WhatsAppMessagePayloadSchema: { safeParse: jest.fn<any>().mockReturnValue({ success: false, error: {} }) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyMetaSignature: jest.fn<any>().mockReturnValue(true),
}));

jest.unstable_mockModule('../queues/JobDispatcher.js', () => ({
  jobDispatcher: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatch: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('../utils/webhookLogger.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logWebhookEvent: jest.fn<any>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../utils/secureCompare.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  timingSafeEqual: jest.fn<any>().mockReturnValue(true),
}));

jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOAuthBaseUrl: jest.fn<any>().mockReturnValue('https://www.facebook.com/v25.0'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraphApiVersion: jest.fn<any>().mockReturnValue('v25.0'),
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
  gte: jest.fn<any>().mockReturnValue({}),
  lte: jest.fn<any>().mockReturnValue({}),
  gt: jest.fn<any>().mockReturnValue({}),
  ne: jest.fn<any>().mockReturnValue({}),
  not: jest.fn<any>().mockReturnValue({}),
  isNotNull: jest.fn<any>().mockReturnValue({}),
  asc: jest.fn<any>().mockReturnValue({}),
  desc: jest.fn<any>().mockReturnValue({}),
  count: jest.fn<any>().mockReturnValue({}),
  or: jest.fn<any>().mockReturnValue({}),
}));

jest.unstable_mockModule('../models/outreachConversations/schema.js', () => ({
  outreachConversationsTable: {},
  outreachMessagesTable: {},
  outreachMessageAttachmentsTable: {},
}));

jest.unstable_mockModule('../models/channelCredentials/schema.js', () => ({
  channelCredentialsTable: {},
}));

jest.unstable_mockModule('../models/leads/schema.js', () => ({
  leadsTable: {},
}));

jest.unstable_mockModule('ioredis', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: jest.fn<any>().mockImplementation(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set: jest.fn<any>().mockResolvedValue('OK'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    del: jest.fn<any>().mockResolvedValue(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quit: jest.fn<any>().mockResolvedValue(undefined),
  })),
}));

// ── Import ─────────────────────────────────────────────────────────────
const { mockRequest, mockResponse, mockAuthRequest } = await import('./helpers/mockHelpers');

const {
  getWhatsAppConfig,
  saveWhatsAppConfig,
  deleteWhatsAppConfig,
  verifyWebhook,
  handleWebhook,
  testWhatsAppConnection,
  sendWhatsAppText,
  selectWhatsAppOAuthAccount,
  buildWhatsAppEmbeddedSignupUrl,
  getWhatsAppConnectionStatus,
  whatsappOAuthVerificationAllowsConnection,
} = await import('../controllers/whatsappController');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { CredentialService } = await import('../services/credentialService') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { whatsappApiService } = await import('../services/whatsappApiService.js') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions.js') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { timingSafeEqual } = await import('../utils/secureCompare.js') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { WhatsAppMessagePayloadSchema } = await import('../utils/metaWebhookValidator.js') as any;

// ── Tests ──────────────────────────────────────────────────────────────
describe('WhatsApp Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('selectWhatsAppOAuthAccount', () => {
    const candidates = [
      { wabaId: 'wrong-waba', phones: [{ id: 'wrong-phone', verified_name: 'Other Business' }] },
      { wabaId: 'oro-waba', phones: [{ id: 'oro-phone', verified_name: 'Oro Circle' }] },
    ];

    it('preserves the existing phone when Meta returns multiple WABAs', () => {
      expect(selectWhatsAppOAuthAccount(candidates, {
        wabaId: 'oro-waba',
        phoneNumberId: 'oro-phone',
      })).toEqual({
        wabaId: 'oro-waba',
        phone: { id: 'oro-phone', verified_name: 'Oro Circle' },
      });
    });

    it('does not silently select the first account when no workspace binding matches', () => {
      expect(() => selectWhatsAppOAuthAccount(candidates, {})).toThrow(
        'Multiple WhatsApp Business phone numbers are available',
      );
    });

    it('accepts a directly validated preserved phone on an unambiguous WABA', () => {
      const preserved = [{
        wabaId: 'oro-waba',
        phones: [{ id: 'oro-phone', verified_name: 'Oro Circle' }],
      }];
      expect(selectWhatsAppOAuthAccount(preserved, { phoneNumberId: 'oro-phone' })).toEqual({
        wabaId: 'oro-waba',
        phone: { id: 'oro-phone', verified_name: 'Oro Circle' },
      });
    });
  });

  describe('buildWhatsAppEmbeddedSignupUrl', () => {
    it('launches the configured Facebook Login for Business flow instead of generic scope OAuth', () => {
      const authUrl = new URL(buildWhatsAppEmbeddedSignupUrl({
        appId: 'app-123',
        apiVersion: 'v25.0',
        redirectUri: 'https://asksales.ai/api/whatsapp/oauth/callback',
        state: 'signed-state',
        configId: '1020946633779906',
      }));

      expect(authUrl.searchParams.get('config_id')).toBe('1020946633779906');
      expect(authUrl.searchParams.get('response_type')).toBe('code');
      expect(authUrl.searchParams.get('override_default_response_type')).toBe('true');
      expect(authUrl.searchParams.get('auth_type')).toBe('rerequest');
      expect(authUrl.searchParams.has('scope')).toBe(false);
    });
  });

  describe('limited WhatsApp readiness', () => {
    it('keeps customer replies connected when Meta limits proactive sending', () => {
      expect(getWhatsAppConnectionStatus('WABA_HEALTH')).toBe('limited');
      expect(whatsappOAuthVerificationAllowsConnection({
        status: 'failing',
        errorCode: 'WABA_HEALTH',
      })).toBe(true);
    });

    it('still requires reconnect for invalid authorization', () => {
      expect(getWhatsAppConnectionStatus('PROVIDER_TOKEN')).toBe('reauth_required');
      expect(getWhatsAppConnectionStatus('meta_190_0')).toBe('reauth_required');
      expect(whatsappOAuthVerificationAllowsConnection({
        status: 'failing',
        errorCode: 'PROVIDER_TOKEN',
      })).toBe(false);
    });
  });

  // ── getWhatsAppConfig ────────────────────────────────────────────────
  describe('getWhatsAppConfig', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await getWhatsAppConfig(req, res);
      expect(res._status).toBe(401);
    });

    it('should return configured: false when no credentials', async () => {
      whatsappApiService.resolveCreds.mockResolvedValue(null);
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await getWhatsAppConfig(req, res);
      expect(res._status).toBe(200);
      expect(res._json.configured).toBe(false);
    });

    it('should return masked config when credentials exist', async () => {
      whatsappApiService.resolveCreds.mockResolvedValue({
        phoneNumberId: '1095711443622725',
        businessAccountId: 'biz123',
        accessToken: 'EAAfJwODu4nYBRTPtest1234567890abc123456789',
        apiVersion: 'v25.0',
        source: 'manual',
        isManual: true,
        sessionData: {
          webhookVerifyToken: 'verify_token_here',
          displayPhoneNumber: '+91 99874 99179',
          verifiedName: 'Test Business',
          wabaName: 'Test WABA',
          qualityRating: 'GREEN',
          connectedViaManual: true,
        },
      });
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await getWhatsAppConfig(req, res);
      expect(res._status).toBe(200);
      expect(res._json.configured).toBe(true);
      expect(res._json.config.phoneNumberId).toBe('1095711443622725');
      // Token should be masked
      expect(res._json.config.accessToken).not.toContain('EAAfJwODu4nY');
      expect(res._json.config.hasAccessToken).toBe(true);
      // Capability rendering reuses this setup read instead of fetching it again.
      expect(getActiveAdminCredential).toHaveBeenCalledTimes(1);
    });
  });

  // ── saveWhatsAppConfig ───────────────────────────────────────────────
  describe('saveWhatsAppConfig', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { phoneNumberId: '123' } });
      const res = mockResponse();
      await saveWhatsAppConfig(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if phoneNumberId is missing', async () => {
      const req = mockAuthRequest(1, { body: { accessToken: 'EAAtest' } });
      const res = mockResponse();
      await saveWhatsAppConfig(req, res);
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/Phone Number ID/i);
    });

    it('should save config and return success', async () => {
      CredentialService.getCredential.mockResolvedValue(null);
      CredentialService.saveCredential.mockResolvedValue(undefined);
      const req = mockAuthRequest(1, {
        body: {
          phoneNumberId: '1095711443622725',
          businessAccountId: 'biz123',
          accessToken: 'EAAtest',
          webhookVerifyToken: 'token',
          apiVersion: 'v25.0',
        },
      });
      const res = mockResponse();
      await saveWhatsAppConfig(req, res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
      // The token is retained in the encrypted config; api_credentials.api_key
      // is intentionally blank so it cannot leak a WhatsApp bearer token.
      expect(CredentialService.saveCredential).toHaveBeenCalledWith(1, 'whatsapp', '', '', expect.objectContaining({ accessToken: 'EAAtest' }));
    });
  });

  // ── deleteWhatsAppConfig ─────────────────────────────────────────────
  describe('deleteWhatsAppConfig', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await deleteWhatsAppConfig(req, res);
      expect(res._status).toBe(401);
    });

    it('should retire credentials and return success without deleting audit history', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { db } = await import('../models/db.js') as any;
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await deleteWhatsAppConfig(req, res);
      expect(res._status).toBe(200);
      expect(res._json.success).toBe(true);
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── testWhatsAppConnection ───────────────────────────────────────────
  describe('testWhatsAppConnection', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await testWhatsAppConnection(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if no credentials configured', async () => {
      whatsappApiService.resolveCreds.mockResolvedValue(null);
      const req = mockAuthRequest(1, { body: {} });
      const res = mockResponse();
      await testWhatsAppConnection(req, res);
      expect(res._status).toBe(400);
    });

    it('should require reconnection and persist Meta authentication failures', async () => {
      const resolved = {
        source: 'channel_credentials',
        credId: 13,
        accessToken: 'encrypted-at-rest-token',
        phoneNumberId: '1095711443622725',
        apiVersion: 'v25.0',
      };
      whatsappApiService.resolveCreds.mockResolvedValue(resolved);
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 190, error_subcode: 460, message: 'Invalidated session' },
        }),
      } as unknown as Response);
      const req = mockAuthRequest(1, { body: {} });
      const res = mockResponse();

      await testWhatsAppConnection(req, res);

      expect(res._status).toBe(424);
      expect(res._json).toMatchObject({
        success: false,
        reconnectRequired: true,
        code: 'WHATSAPP_REAUTH_REQUIRED',
      });
      expect(whatsappApiService.recordReadiness).toHaveBeenCalledWith(
        resolved,
        { ok: false, code: 190, subcode: 460 },
      );
      fetchSpy.mockRestore();
    });
  });

  // ── verifyWebhook ────────────────────────────────────────────────────
  describe('verifyWebhook', () => {
    it('should return 403 if mode is not subscribe', async () => {
      const req = mockRequest({ query: { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'tok', 'hub.challenge': '123' } });
      const res = mockResponse();
      await verifyWebhook(req, res);
      expect(res._status).toBe(403);
    });

    it('should return challenge for valid subscribe with matching token', async () => {
      getActiveAdminCredential.mockResolvedValue({ config: { webhookVerifyToken: 'valid_token' } });
      timingSafeEqual.mockReturnValue(true);
      const req = mockRequest({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'valid_token', 'hub.challenge': 'challenge123' } });
      const res = mockResponse();
      await verifyWebhook(req, res);
      expect(res._status).toBe(200);
      expect(res._sent).toBe('challenge123');
    });

    it('should return 403 for token mismatch', async () => {
      getActiveAdminCredential.mockResolvedValue({ config: { webhookVerifyToken: 'correct_token' } });
      timingSafeEqual.mockReturnValue(false);
      const req = mockRequest({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong_token', 'hub.challenge': 'ch' } });
      const res = mockResponse();
      await verifyWebhook(req, res);
      expect(res._status).toBe(403);
    });
  });

  // ── handleWebhook ────────────────────────────────────────────────────
  describe('handleWebhook', () => {
    it('returns a retryable failure when native echo persistence fails', async () => {
      const { db } = await import('../models/db.js') as any;
      db.select.mockReturnValue({from:()=>({where:async()=>[{userId:9,businessProfileId:91,accountIdentifier:'phone'}]})});
      const payload={object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'smb_message_echoes',value:{metadata:{phone_number_id:'phone'},
        message_echoes:[{id:'echo',to:'919999999999',from:'business',timestamp:'1715600000',type:'text',text:{body:'Native'}}]}}]}]};
      WhatsAppMessagePayloadSchema.safeParse.mockReturnValue({success:true,data:payload});
      persistEcho.mockRejectedValueOnce(new Error('Storage unavailable'));
      const req=mockRequest({body:payload,_legacyTokenAuth:true});
      const failed=mockResponse(); await handleWebhook(req,failed);
      expect(failed._status).toBe(500);
      const retried=mockResponse(); await handleWebhook(req,retried);
      expect(retried._status).toBe(200);
      expect(persistEcho).toHaveBeenCalledTimes(2);
      expect(registerTurn).not.toHaveBeenCalled();
    });

    it('resumes dispatch for a persisted inbound message after a queue failure', async () => {
      const { db } = await import('../models/db.js') as any;
      const { jobDispatcher } = await import('../queues/JobDispatcher.js') as any;
      db.select.mockReturnValue({from:()=>({where:async()=>[{userId:9,businessProfileId:91,accountIdentifier:'phone'}]})});
      db.execute.mockResolvedValue({rows:[{id:58,conversation_id:20}]});
      const tx={execute:jest.fn<any>().mockResolvedValue({rows:[{id:58,conversation_id:20}]}),insert:jest.fn()};
      db.transaction.mockImplementation(async (work: (executor: unknown)=>unknown)=>work(tx));
      const payload={object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'messages',value:{metadata:{phone_number_id:'phone'},
        messages:[{id:'inbound',from:'919999999999',timestamp:'1715600000',type:'text',text:{body:'Help'}}]}}]}]};
      WhatsAppMessagePayloadSchema.safeParse.mockReturnValue({success:true,data:payload});
      jobDispatcher.dispatch.mockRejectedValueOnce(new Error('Queue unavailable'));
      const req=mockRequest({body:payload,_legacyTokenAuth:true});
      const failed=mockResponse(); await handleWebhook(req,failed); expect(failed._status).toBe(500);
      const retried=mockResponse(); await handleWebhook(req,retried); expect(retried._status).toBe(200);
      expect(tx.insert).not.toHaveBeenCalled();
      expect(jobDispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(jobDispatcher.dispatch).toHaveBeenLastCalledWith('process_whatsapp_webhook',expect.objectContaining({conversationId:20,inboundMessageId:58}));
    });

    it('should return 200 immediately for delivery receipts (non-message events)', async () => {
      // Payload with delivery/read status only — Zod parse fails → 200 (non-message event)
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.abc', status: 'delivered' }] } }] }],
      };
      WhatsAppMessagePayloadSchema.safeParse.mockReturnValue({ success: false, error: { issues: [] } });
      const req = mockRequest({
        body: payload,
        headers: { 'x-hub-signature-256': 'sha256=abc' },
        rawBody: Buffer.from(JSON.stringify(payload)),
        _legacyTokenAuth: true, // bypass signature check
      });
      const res = mockResponse();
      await handleWebhook(req, res);
      expect(res._status).toBe(200);
    });

    it('should return 200 for well-formed inbound message and dispatch job', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
      const { jobDispatcher } = await import('../queues/JobDispatcher.js') as any;
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'waba_id',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1234567890', phone_number_id: '1095711443622725' },
              messages: [{
                from: '919987499179',
                id: 'wamid.test',
                timestamp: '1715600000',
                text: { body: 'hello' },
                type: 'text',
              }],
              contacts: [{ profile: { name: 'Mahesh' }, wa_id: '919987499179' }],
            },
            field: 'messages',
          }],
        }],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { db } = await import('../models/db.js') as any;
      db.execute.mockResolvedValue({ rows: [{ id: 58, user_id: 9, lead_id: 163 }] });
      db.select.mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        from: jest.fn<any>().mockReturnValue({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          where: jest.fn<any>().mockResolvedValue([{ userId: 9, platform: 'whatsapp', accountIdentifier: '1095711443622725' }]),
        }),
      });
      WhatsAppMessagePayloadSchema.safeParse.mockReturnValue({ success: true, data: payload });
      const req = mockRequest({
        body: payload,
        headers: { 'x-hub-signature-256': 'sha256=abc' },
        rawBody: Buffer.from(JSON.stringify(payload)),
        _legacyTokenAuth: true, // bypass signature check
      });
      const res = mockResponse();
      await handleWebhook(req, res);
      expect(res._status).toBe(200);
    });
  });

  // ── sendWhatsAppText ─────────────────────────────────────────────────
  describe('sendWhatsAppText', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { to: '919987499179', text: 'hello' } });
      const res = mockResponse();
      await sendWhatsAppText(req, res);
      expect(res._status).toBe(401);
    });

    it('should return 400 if to or text is missing', async () => {
      const req = mockAuthRequest(1, { body: { text: 'hello' } });
      const res = mockResponse();
      await sendWhatsAppText(req, res);
      expect(res._status).toBe(400);
    });
  });
});
