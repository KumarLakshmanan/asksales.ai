import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response as ExpressResponse } from 'express';

const findByUserAndPlatform = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const upsert = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateAccount = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const remove = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({
  ChannelCredentialModel: {
    findByUserAndPlatform,
    upsert,
    updateAccount,
    delete: remove,
  },
}));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({
  decryptChannelCredentialSecret: (value: unknown) => typeof value === 'string' ? value.replace(/^sealed:/, '') : '',
  decryptChannelCredentialSession: (value: unknown) =>
    value && typeof value === 'object' && 'sealed' in value
      ? (value as { sealed: unknown }).sealed
      : value,
  encryptChannelCredentialSecret: (value: string) => `sealed:${value}`,
  encryptChannelCredentialSession: (value: unknown) => ({ sealed: value }),
  getChannelCredentialEncryptionKeyId: () => 'qa-key-id',
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  getMsg91Settings,
  saveMsg91Settings,
  testMsg91Connection_handler,
  disconnectMsg91,
} = await import('../controllers/msg91SettingsController.js');

function response() {
  const json = jest.fn<(body: unknown) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return { res: { json, status } as unknown as ExpressResponse, json, status };
}

const settings = { senderId: 'ABCDEF', flowId: 'FLOW-42', messageVariable: 'proposal_message' };
const saved = () => ({
  id: 31, isActive: true, credentialType: 'api_key', accountIdentifier: 'ABCDEF', apiSecret: 'sealed:provider-secret',
  sessionData: { sealed: settings }, providerVerifiedAt: new Date('2026-09-29T06:00:00Z'),
  encryptionVersion: 'v1', encryptionKeyId: 'qa-key-id', encryptedAt: new Date(),
});
const templateResponse = (templateId = 'FLOW-42', variable = 'proposal_message') => Response.json({
  status: 'success', hasError: false, errors: [], data: [{
    template_id: templateId, sender_id: 'ABCDEF', active_status: '1', status: '1',
    reject_reason: '', template_data: `Your message: ##${variable}##`, template_name: 'Customer message',
  }],
});

describe('MSG91 settings credential handling', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    findByUserAndPlatform.mockReset();
    upsert.mockReset().mockResolvedValue({});
    updateAccount.mockReset().mockResolvedValue({});
    remove.mockReset().mockResolvedValue(undefined);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(templateResponse());
  });

  it('encrypts new Auth Keys and records envelope metadata before persistence', async () => {
    const { res, json } = response();
    await saveMsg91Settings({
      user: { id: 9 },
      body: { authKey: ' provider-secret ', senderId: 'ABCDEF', flowId: 'FLOW-42', messageVariable: 'proposal_message' },
    } as unknown as Request, res);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9,
      platform: 'msg91_sms',
      accountIdentifier: 'ABCDEF',
      apiSecret: 'sealed:provider-secret',
      sessionData: { sealed: { ...settings, templateName: 'Customer message' } },
      encryptionVersion: 'v1',
      encryptionKeyId: 'qa-key-id',
      encryptedAt: expect.any(Date),
      providerVerifiedAt: expect.any(Date),
      readinessErrorCode: null,
    }));
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('decrypts settings server-side and never returns the Auth Key', async () => {
    findByUserAndPlatform.mockResolvedValue(saved());
    const { res, json } = response();
    await getMsg91Settings({ user: { id: 9 } } as unknown as Request, res);

    const result = json.mock.calls[0][0] as Record<string, unknown>;
    expect(result).toEqual({
      success: true,
      configured: true,
      connected: true,
      settings: {
        senderId: 'ABCDEF',
        flowId: 'FLOW-42',
        dltTemplateId: 'FLOW-42',
        messageVariable: 'proposal_message',
        hasAuthKey: true,
        lastUsedAt: null,
        lastVerifiedAt: '2026-09-29T06:00:00.000Z',
        connectionStatus: 'ready',
        readinessErrorCode: null,
        readinessMessage: null,
        templateName: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });

  it('preserves the encrypted Auth Key when editing non-secret flow settings', async () => {
    findByUserAndPlatform.mockResolvedValue({ id: 31, apiSecret: 'sealed:provider-secret' });
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(templateResponse('FLOW-43', 'message'));
    const { res, json } = response();
    await saveMsg91Settings({
      user: { id: 9 },
      body: { authKey: '', senderId: 'ABCDEF', flowId: 'FLOW-43', messageVariable: 'message' },
    } as unknown as Request, res);

    expect(globalThis.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ authkey: 'provider-secret' }),
    }));
    expect(updateAccount).toHaveBeenCalledWith(9, 'msg91_sms', 31, expect.objectContaining({ apiSecret: 'sealed:provider-secret' }));
    expect(upsert).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('rejects header injection before calling MSG91 or storing credentials', async () => {
    const { res, status } = response();
    await saveMsg91Settings({
      user: { id: 9 },
      body: { authKey: 'secret\r\ninjected: value', senderId: 'ABCDEF' },
    } as unknown as Request, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('tests an already-saved encrypted Auth Key without returning it to the browser', async () => {
    findByUserAndPlatform.mockResolvedValue(saved());
    const { res, json } = response();

    await testMsg91Connection_handler({
      user: { id: 9 },
      body: { authKey: '', senderId: 'ABCDEF' },
    } as unknown as Request, res);

    expect(globalThis.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ authkey: 'provider-secret' }),
    }));
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(JSON.stringify(json.mock.calls)).not.toContain('provider-secret');
    expect(updateAccount).toHaveBeenCalledWith(9, 'msg91_sms', 31, expect.objectContaining({ providerVerifiedAt: expect.any(Date), readinessErrorCode: null }));
  });

  it('keeps legacy credentials disconnected until their sender and template are verified and saved securely', async () => {
    findByUserAndPlatform.mockResolvedValue({ ...saved(), providerVerifiedAt: null, encryptionVersion: null });
    const { res, json } = response();
    await getMsg91Settings({ user: { id: 9 } } as unknown as Request, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ configured: true, connected: false, settings: expect.objectContaining({ connectionStatus: 'action_required' }) }));
  });

  it('rejects provider errors returned with HTTP 200 and preserves the existing connection', async () => {
    findByUserAndPlatform.mockResolvedValue(saved());
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ status: 'error', hasError: true, data: [], errors: 'Invalid auth key' }));
    const { res, json, status } = response();
    await saveMsg91Settings({ user: { id: 9 }, body: { ...settings, authKey: 'invalid-key' } } as unknown as Request, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'MSG91_TEMPLATE_UNAVAILABLE' }));
    expect(upsert).not.toHaveBeenCalled();
    expect(updateAccount).not.toHaveBeenCalled();
  });

  it('does not change saved readiness when testing a different draft', async () => {
    findByUserAndPlatform.mockResolvedValue(saved());
    const { res } = response();
    await testMsg91Connection_handler({ user: { id: 9 }, body: { ...settings, authKey: 'new-key' } } as unknown as Request, res);
    expect(updateAccount).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('marks rejected saved credentials as requiring reconnection', async () => {
    findByUserAndPlatform.mockResolvedValue(saved());
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const { res, json } = response();
    await testMsg91Connection_handler({ user: { id: 9 }, body: {} } as unknown as Request, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'MSG91_AUTH_FAILED' }));
    expect(updateAccount).toHaveBeenCalledWith(9, 'msg91_sms', 31, expect.objectContaining({ providerVerifiedAt: null, readinessErrorCode: 'MSG91_AUTH_FAILED' }));
  });

  it('disconnects only the current owner’s SMS credentials', async () => {
    const { res } = response();
    await disconnectMsg91({ user: { id: 9 } } as unknown as Request, res);
    expect(remove).toHaveBeenCalledWith(9, 'msg91_sms');
  });

  it.each([getMsg91Settings, saveMsg91Settings, testMsg91Connection_handler, disconnectMsg91])('requires authentication before reading or changing credentials', async handler => {
    const { res, status } = response();
    await handler({ body: settings } as unknown as Request, res);
    expect(status).toHaveBeenCalledWith(401);
    expect(findByUserAndPlatform).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
