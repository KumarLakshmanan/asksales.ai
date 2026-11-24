/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let row: Record<string, unknown>;
let approved: Record<string, string>;
const select = jest.fn<any>();
const query: any = { from: () => query, where: () => query, orderBy: () => query, limit: async () => [row] };
jest.unstable_mockModule('../models/db.js', () => ({ db: { select } }));
jest.unstable_mockModule('../services/integrations/MetaCapabilityRegistry.js', () => ({ getMetaAppReviewPermissions: async () => approved }));
const { inspectOfficialProviderBinding } = await import('../services/outreach/ProviderBindingService.js');

beforeEach(() => {
  select.mockReturnValue(query);
  approved = { instagram_business_manage_messages: 'approved' };
  row = { id: 14, credentialType: 'oauth', usesInstagramLogin: true, hasCredentialMaterial: true,
    tokenExpiry: new Date('2099-01-01'), accountIdentifier: 'ig-user', accountName: 'orchid',
    encryptionVersion: 'v1', encryptionKeyId: 'key-1', encryptedAt: new Date(),
    grantedScopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    providerApprovalStatus: 'not_required', providerApiVersion: 'v25.0', providerVerifiedAt: new Date(), readinessErrorCode: null };
});

describe('Instagram Login delivery readiness', () => {
  it('accepts an approved direct account without any Facebook Page scopes', async () => {
    const result = await inspectOfficialProviderBinding(42, 'instagram', { credentialId: 14 });
    expect(result).toMatchObject({ ready: true, binding: { credentialId: 14, providerAccountId: 'ig-user' } });
    expect(select.mock.calls[0][0]).not.toHaveProperty('sessionData');
    expect(result).not.toHaveProperty('sessionData');
  });
  it('does not substitute an old Facebook Login permission approval for direct Instagram approval', async () => {
    approved = { instagram_manage_messages: 'approved' };
    expect(await inspectOfficialProviderBinding(42, 'instagram', { credentialId: 14 })).toMatchObject({ ready: false, missing: expect.arrayContaining(['provider_approval']) });
  });
  it('blocks delivery when Instagram messaging consent was declined', async () => {
    row.grantedScopes = ['instagram_business_basic'];
    expect(await inspectOfficialProviderBinding(42, 'instagram', { credentialId: 14 })).toMatchObject({ ready: false, missing: expect.arrayContaining(['required_scopes']) });
  });
});
