import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrganicPublishingAccounts } from '@/hooks/useOrganicPublishingAccounts';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));

describe('useOrganicPublishingAccounts', () => {
  it('keeps refreshable YouTube connections but excludes reconnect-required accounts', async () => {
    mocks.get.mockResolvedValue({ accounts: [
      { credentialId: 10, platform: 'youtube', expired: true, readiness: 'ready' },
      { credentialId: 11, platform: 'youtube', expired: false, readiness: 'needs_reconnect' },
      { credentialId: 12, platform: 'youtube', expired: true },
    ] });
    const { result } = renderHook(() => useOrganicPublishingAccounts());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.accounts.map(account => account.credentialId)).toEqual([10]);
    expect(result.current.connectedPlatforms).toEqual(['youtube']);
  });
  beforeEach(() => vi.clearAllMocks());

  it('filters expired connections and prefers the integration-selected account', async () => {
    mocks.get.mockResolvedValue({ accounts: [
      { credentialId: 1, platform: 'instagram', accountName: 'Expired', providerAccountId: 'old', expired: true, expiresAt: null },
      { credentialId: 2, platform: 'instagram', accountName: 'Secondary', providerAccountId: 'ig-2', expired: false, expiresAt: null },
      { credentialId: 3, platform: 'instagram', accountName: 'Default', providerAccountId: 'ig-3', expired: false, expiresAt: null, isSelected: true },
    ] });
    const { result } = renderHook(() => useOrganicPublishingAccounts());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.accounts.map((account) => account.credentialId)).toEqual([2, 3]);
    expect(result.current.preferredForPlatform('instagram')?.credentialId).toBe(3);
    expect(result.current.connectedPlatforms).toEqual(['instagram']);
  });
});
