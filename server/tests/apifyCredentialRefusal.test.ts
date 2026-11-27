import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// When Apify refuses a run for an account-wide reason, the admin credential is
// switched off and the provider's own reason is kept for Admin Integrations.
const markInactive = jest.fn<(...args: unknown[]) => Promise<null>>();
const recordValidation = jest.fn<(...args: unknown[]) => Promise<void>>();
const nextForActor = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const actual = await import('../models/adminApiCredentials/functions');
jest.unstable_mockModule('../models/adminApiCredentials/functions', () => ({
  ...actual,
  markAdminCredentialInactive: markInactive,
  updateAdminCredentialValidation: recordValidation,
  getNextAdminCredentialForActor: nextForActor,
  getNextActiveAdminCredential: jest.fn(),
}));
const { WorkflowExecutorService } = await import('../services/WorkflowExecutorService');
const refuse = (context: unknown, error: Error) =>
  (WorkflowExecutorService as unknown as Record<string, (c: unknown, e: Error) => Promise<unknown>>)
    .handleAdminApifyCapacityAndGetNext(context, error);
const context = () => ({ apifyCredentialSource: 'admin', apifyActorId: 'harvestapi/linkedin-profile-search',
  apifyKeyInfo: { apiKey: 'k', credentialId: 27, platform: 'apify' } });

beforeEach(() => { jest.clearAllMocks(); nextForActor.mockResolvedValue(null); });

describe('admin Apify credential refusal', () => {
  it('deactivates the credential and records Apify\'s reason when billing blocks every run', async () => {
    expect(await refuse(context(), new Error('Actor execution failed: Too many outstanding invoices'))).toBeNull();
    expect(markInactive).toHaveBeenCalledWith(27, 'billing_or_account_capacity', expect.stringContaining('outstanding invoices'));
    expect(recordValidation).toHaveBeenCalledWith({ id: 27, platform: 'apify', status: 'invalid',
      message: expect.stringContaining('Apify refused a run: Too many outstanding invoices') });
  });

  it('leaves the credential alone for an actor-scoped plan limit', async () => {
    await refuse(context(), new Error('Free user run limit exceeded'));
    expect(markInactive).not.toHaveBeenCalled();
    expect(recordValidation).not.toHaveBeenCalled();
  });
});
