import { expect, it } from 'vitest';
import { managedCampaignHref, paidAdsReturnHref, paidAdsWorkspaceHref, withPaidAdsContext } from '@/components/performance-marketing/campaignRoutes';
it('preserves selected account and filters through a campaign and back', () => {
  const href = withPaidAdsContext(managedCampaignHref(8, 'delivery'), 'tab=campaigns&account=123&period=7d&status=paused&search=resort');
  const detail = new URL(href, 'https://asksales.local');
  expect(detail.searchParams.get('tab')).toBe('delivery');
  expect(detail.searchParams.get('account')).toBe('123');
  expect(detail.searchParams.get('period')).toBe('7d');
  const back = new URL(paidAdsReturnHref(detail.searchParams.get('returnTo')), 'https://asksales.local');
  expect(back.searchParams.get('search')).toBe('resort');
  expect(back.searchParams.get('status')).toBe('paused');
});
it('rejects external destinations and unrelated routes', () => {
  for (const value of ['https://evil.example/dashboard/ads', '//evil.example/dashboard/ads', '/api/delete', 'javascript:alert(1)']) expect(paidAdsReturnHref(value)).toBe('/dashboard/ads?tab=campaigns');
  expect(paidAdsReturnHref('/dashboard/ads?tab=overview&token=private')).toBe('/dashboard/ads?tab=overview');
});

it('does not treat all accounts as a provider credential selection', () => {
  expect(new URL(withPaidAdsContext(managedCampaignHref(8), 'account=all'), 'https://asksales.local').searchParams.has('account')).toBe(false);
});

it('keeps the same account and reporting filters when opening another workspace section', () => {
  for (const tab of ['campaigns', 'recommendations', 'automation'] as const) {
    const href = new URL(paidAdsWorkspaceHref(tab, 'tab=overview&account=2&period=7d&platform=meta&objective=awareness&status=active&search=Oro&research=1&campaign=42&token=discard'), 'https://asksales.local');
    expect(href.searchParams.get('tab')).toBe(tab);
    for (const [key, value] of [['account', '2'], ['period', '7d'], ['platform', 'meta'], ['objective', 'awareness'], ['status', 'active'], ['search', 'Oro']]) expect(href.searchParams.get(key)).toBe(value);
    for (const key of ['research', 'campaign', 'token']) expect(href.searchParams.has(key)).toBe(false);
  }
});
