import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const providerGet = jest.fn<(messageId: string) => Promise<{ data: { id: string; last_event: string } | null; error: { message: string } | null }>>();
const resendConstructor = jest.fn<(apiKey: string) => {
  emails: { get: typeof providerGet };
}>().mockImplementation(() => ({ emails: { get: providerGet } }));
const credentialLimit = jest.fn<() => Promise<Array<{ id: number; apiKey: string }>>>();
const credentialWhere = jest.fn(() => ({ limit: credentialLimit }));
const credentialFrom = jest.fn(() => ({ where: credentialWhere }));
const credentialSelect = jest.fn(() => ({ from: credentialFrom }));
const decryptAdminCredential = jest.fn<(credential: { id: number; apiKey: string }) => { apiKey: string }>();
const getActiveAdminCredential = jest.fn<(platform: string) => Promise<{ apiKey: string } | null>>();

jest.unstable_mockModule('resend', () => ({ Resend: resendConstructor }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: credentialSelect } }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  decryptAdminCredential,
  getActiveAdminCredential,
}));

const { getEmail } = await import('../services/resendService.js');

describe('Resend receipt credential binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    credentialLimit.mockResolvedValue([{ id: 77, apiKey: 'encrypted-material' }]);
    decryptAdminCredential.mockReturnValue({ apiKey: 'exact-decrypted-key' });
    getActiveAdminCredential.mockResolvedValue({ apiKey: 'newest-default-key' });
    providerGet.mockResolvedValue({ data: { id: 'email-1', last_event: 'delivered' }, error: null });
  });

  it('retrieves a receipt with the exact frozen credential', async () => {
    await expect(getEmail('email-1', 77)).resolves.toEqual({ id: 'email-1', last_event: 'delivered' });
    expect(decryptAdminCredential).toHaveBeenCalledWith(expect.objectContaining({ id: 77 }));
    expect(getActiveAdminCredential).not.toHaveBeenCalled();
    expect(resendConstructor).toHaveBeenCalledWith('exact-decrypted-key');
    expect(providerGet).toHaveBeenCalledWith('email-1');
  });

  it('does not fall back when the frozen credential is missing', async () => {
    credentialLimit.mockResolvedValueOnce([]);
    await expect(getEmail('email-1', 404)).rejects.toThrow('Resend API key not configured');
    expect(getActiveAdminCredential).not.toHaveBeenCalled();
    expect(resendConstructor).not.toHaveBeenCalled();
    expect(providerGet).not.toHaveBeenCalled();
  });

  it('retains default credential resolution for unbound admin operations', async () => {
    await expect(getEmail('email-1')).resolves.toEqual({ id: 'email-1', last_event: 'delivered' });
    expect(credentialSelect).not.toHaveBeenCalled();
    expect(getActiveAdminCredential).toHaveBeenCalledWith('resend');
    expect(resendConstructor).toHaveBeenCalledWith('newest-default-key');
  });
});
