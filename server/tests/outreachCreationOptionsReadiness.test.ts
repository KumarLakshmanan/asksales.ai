import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
const provider = jest.fn();
const listSenders = jest.fn<() => Promise<unknown[]>>();
const where = jest.fn<() => Promise<unknown[]>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, select: () => ({ from: () => ({ where }) }) } }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({ listByUser: listSenders, getById: jest.fn(), getDefault: jest.fn() }));
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({ resolveOfficialProviderBinding: provider }));
jest.unstable_mockModule('../services/whatsappServiceWindow.js', () => ({ hasActiveWhatsAppWindow: jest.fn(), activeWhatsAppWindows: jest.fn() }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ parseUtcDatabaseTimestamp: (value: string) => new Date(value) }));
jest.unstable_mockModule('../services/outreach/RecipientSuppressionService.js', () => ({ getSuppressedRecipients: jest.fn(), normalizeOutreachDestination: jest.fn() }));
const { getCreationOptions } = await import('../services/outreach/CreationService.js');
const oldRuntime = process.env.SUPPORT_ASSISTANTS_ENABLED;
const oldProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
const scope = <T>(work: () => T) => withBusinessScope({ userId: 1, businessProfileId: 10 }, work);
beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
  delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
  where.mockResolvedValue([]);
  listSenders.mockResolvedValue([]);
});
afterEach(() => {
  if (oldRuntime === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = oldRuntime;
  if (oldProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES; else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = oldProfiles;
});

describe('Outreach channel readiness without sending accounts', () => {
  it.each(['email', 'whatsapp', 'facebook', 'instagram'] as const)('exposes the existing runtime block for empty %s accounts', async channel => {
    const options = await scope(() => getCreationOptions(1, channel));
    expect(options).toMatchObject({ channel, accounts: [], deliveryBlock: {
      ready: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', accountId: '', channel, setupUrl: '/dashboard/settings/outreach',
    } });
    expect(options.deliveryBlock?.error).toContain('assistant runtime is disabled');
    expect(provider).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['false', 'true'])('keeps unsupported SMS binding ahead of runtime state %s', async enabled => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = enabled;
    const options = await scope(() => getCreationOptions(1, 'sms'));
    expect(options).toMatchObject({ channel: 'sms', accounts: [], deliveryBlock: { ready: false, reason: 'unsupported_channel', channel: 'sms' } });
    expect(options.deliveryBlock?.error).toContain('requires a supported assistant account assignment');
    expect(provider).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not fabricate assignment readiness when a supported runtime is enabled but no account exists', async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'true';
    expect(await scope(() => getCreationOptions(1, 'whatsapp'))).toEqual({ channel: 'whatsapp', accounts: [] });
    expect(provider).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
