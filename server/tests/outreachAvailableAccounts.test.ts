import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

type Sender = { id: number; email: string; type: string; isVerified: boolean; credentialId?: number; isDefault?: boolean };
let senders: Sender[] = [];
const where = jest.fn<() => Promise<unknown[]>>();
const provider = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const assistant = jest.fn(async () => ({ ready: false, error: 'Assign an assistant first', setupUrl: '/dashboard/settings/outreach' }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => ({ from: () => ({ where }) }) } }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({
  listByUser: async () => senders,
  getById: async (_user: number, id: number) => senders.find(sender => sender.id === id),
  getDefault: async () => senders.find(sender => sender.isDefault),
}));
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({ resolveOfficialProviderBinding: provider }));
jest.unstable_mockModule('../services/assistants/CustomerDeliveryGate.js', () => ({
  assertCustomerDeliveryRuntime: () => undefined, customerDeliveryReadiness: assistant, deliverySetupFailure: () => undefined,
}));
jest.unstable_mockModule('../services/whatsappServiceWindow.js', () => ({ hasActiveWhatsAppWindow: jest.fn(), activeWhatsAppWindows: jest.fn() }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ parseUtcDatabaseTimestamp: (value: string) => new Date(value) }));
jest.unstable_mockModule('../services/outreach/RecipientSuppressionService.js', () => ({ getSuppressedRecipients: jest.fn(), normalizeOutreachDestination: jest.fn() }));
const { getCreationOptions, resolveCreationAccount } = await import('../services/outreach/CreationService.js');
const owner = <T>(work: () => T) => withBusinessScope({ userId: 41, businessProfileId: 42 }, work);

beforeEach(() => { jest.clearAllMocks(); senders = []; where.mockResolvedValue([]); provider.mockResolvedValue(null); });

describe('connected sending account inventory', () => {
  it.each(['whatsapp', 'instagram', 'facebook'] as const)('starts independent provider and assistant checks together for %s', async channel => {
    let resolveProvider!: (value: unknown) => void;
    let resolveAssistant!: (value: Awaited<ReturnType<typeof assistant>>) => void;
    provider.mockImplementationOnce(() => new Promise(resolve => { resolveProvider = resolve; }));
    assistant.mockImplementationOnce(() => new Promise(resolve => { resolveAssistant = resolve; }));
    const pending = owner(() => resolveCreationAccount(41, channel, { providerAccountId: 'selected-account' }));
    expect(provider).toHaveBeenCalled();
    expect(assistant).toHaveBeenCalled();
    resolveProvider({ providerAccountId: 'selected-account', credentialId: 1 });
    resolveAssistant({ ready: false, error: 'Assign an assistant first', setupUrl: '/dashboard/settings/outreach' });
    const result = await pending;
    expect(result.account.ready).toBe(false);
    expect(result.binding?.providerAccountId).toBe('selected-account');
  });
  it('hides disconnected and unverified email senders but retains connected senders awaiting assistant setup', async () => {
    senders = [
      { id: 1, type: 'gmail', email: 'connected@example.test', credentialId: 10, isVerified: true },
      { id: 2, type: 'gmail', email: 'old@example.test', credentialId: 20, isVerified: true, isDefault: true },
      { id: 3, type: 'resend', email: 'unverified@example.test', isVerified: false },
      { id: 4, type: 'resend', email: 'connected@resend.test', isVerified: true },
      { id: 5, type: 'resend', email: 'revoked@old-domain.test', isVerified: true },
    ];
    provider.mockImplementation(async (_user, _channel, options) => {
      const selected = options as { credentialId?: number; providerAccountId?: string };
      return selected.credentialId === 10 || selected.providerAccountId === 'resend.test'
        ? { providerAccountId: 'connected', credentialId: 10 } : null;
    });
    const options = await owner(() => getCreationOptions(41, 'email'));
    expect(options.accounts.map(account => account.senderId)).toEqual([1, 4]);
    expect(options.accounts.every(account => !account.ready)).toBe(true);
    expect(options.accounts[0].assistant?.error).toBe('Assign an assistant first');
  });

  it.each(['facebook', 'instagram', 'whatsapp'] as const)('excludes unavailable %s identities independently of assistant readiness', async channel => {
    where.mockResolvedValue([
      { id: 'connected-account', name: 'Connected account', selected: false },
      { id: 'old-account', name: 'Old account', selected: true },
    ]);
    provider.mockImplementation(async (_user, _channel, options) =>
      (options as { providerAccountId: string }).providerAccountId === 'connected-account'
        ? { providerAccountId: 'connected-account', credentialId: 10 } : null);
    const options = await owner(() => getCreationOptions(41, channel));
    expect(options.accounts).toEqual([expect.objectContaining({ id: 'connected-account', label: 'Connected account', ready: false })]);
    expect(provider).toHaveBeenCalledWith(41, channel, { providerAccountId: 'old-account' });
  });
});
