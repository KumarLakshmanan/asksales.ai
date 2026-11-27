import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const adminForActor = jest.fn<(actorId: string) => Promise<unknown>>();
const userKey = jest.fn<(userId: number) => Promise<unknown>>();
const legacyKey = jest.fn<(userId: number) => Promise<unknown>>();

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getAdminCredentialForActor: adminForActor }));
jest.unstable_mockModule('../services/apiKeyFallbackService.js', () => ({ apifyApiKeys: { getWithTracking: userKey } }));
jest.unstable_mockModule('../controllers/apifyController.js', () => ({ getActiveApifyToken: legacyKey }));

const { resolveApifyCredential, findLeadActorsWithoutKey, LEAD_PROVIDER_UNAVAILABLE_MESSAGE } = await import('../services/apifyCredentialResolver.js');

describe('lead search data provider pre-check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminForActor.mockResolvedValue(null);
    userKey.mockResolvedValue(null);
    legacyKey.mockResolvedValue(null);
  });

  it('uses the admin key for the actor first, like a real run', async () => {
    adminForActor.mockResolvedValue({ id: 27, apiKey: 'admin-key', isActive: true });
    userKey.mockResolvedValue({ apiKey: 'user-key', credentialId: 5, platform: 'apify' });
    await expect(resolveApifyCredential(1, 'harvestapi/linkedin-company-search')).resolves.toMatchObject({ source: 'admin', apiKey: 'admin-key' });
  });

  it("falls back to the user's own key when every admin key is switched off", async () => {
    adminForActor.mockResolvedValue({ id: 27, apiKey: 'admin-key', isActive: false });
    userKey.mockResolvedValue({ apiKey: 'user-key', credentialId: 5, platform: 'apify' });
    await expect(resolveApifyCredential(1, 'a')).resolves.toMatchObject({ source: 'user' });
    await expect(findLeadActorsWithoutKey(1, ['a'])).resolves.toEqual(new Set());
  });

  it('falls back to the user key when the admin lookup fails', async () => {
    adminForActor.mockRejectedValue(new Error('db down'));
    legacyKey.mockResolvedValue('legacy-key');
    await expect(resolveApifyCredential(1, 'a')).resolves.toMatchObject({ source: 'legacy' });
  });

  it('reports every actor with no key at all', async () => {
    await expect(findLeadActorsWithoutKey(1, ['a', 'b', '', 'a'])).resolves.toEqual(new Set(['a', 'b']));
  });

  it('never blocks a search when the check itself fails', async () => {
    userKey.mockRejectedValue(new Error('db down'));
    await expect(findLeadActorsWithoutKey(1, ['a'])).resolves.toEqual(new Set());
  });

  it('explains the problem in plain words', () => {
    expect(LEAD_PROVIDER_UNAVAILABLE_MESSAGE).not.toMatch(/apify|api key|harvestapi|_/i);
    expect(LEAD_PROVIDER_UNAVAILABLE_MESSAGE).toContain('Nothing was run or charged');
  });
});
