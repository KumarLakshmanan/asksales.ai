import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({
    replace: vi.fn(),
  }),
}));
vi.mock('@/lib/performanceMarketingAnalytics', () => ({ trackPerformanceMarketingEvent: vi.fn() }));
vi.mock('@/components/performance-marketing/WorkspacePrimitives', async () => {
  const actual = await vi.importActual<typeof import('@/components/performance-marketing/WorkspacePrimitives')>('@/components/performance-marketing/WorkspacePrimitives');
  return actual;
});
vi.mock('@/app/dashboard/(main)/ads-campaigns/page', async () => {
  const { usePaidAdsAdvancedView, usePaidAdsNavigation } = await import('@/components/performance-marketing/PaidAdsSectionContext');
  function MockCampaignInventory() {
    const navigation = usePaidAdsNavigation();
    const advanced = usePaidAdsAdvancedView();
    return <div>Campaign inventory mounted<span>Campaign view: {advanced ? 'Advanced' : 'Standard'}</span><button onClick={() => navigation.navigate('overview', { provider: 'meta', providerCampaign: 'provider-7', detail: 'units', unit: 'adset-9' })}>Open provider detail</button></div>;
  }
  return { default: MockCampaignInventory };
});
vi.mock('@/app/dashboard/(main)/ads-analytics/page', async () => {
  const { useSearchParams } = await import('next/navigation');
  const { usePaidAdsAdvancedView } = await import('@/components/performance-marketing/PaidAdsSectionContext');
  function MockPerformanceWorkspace() {
    const advanced = usePaidAdsAdvancedView();
    const searchParams = useSearchParams();
    return <div>Performance workspace mounted<span>Performance view: {advanced ? 'Advanced' : 'Standard'}</span><span>Provider detail: {searchParams.get('providerCampaign') || 'none'}</span></div>;
  }
  return { default: MockPerformanceWorkspace };
});

import PaidAdsPage from '@/app/dashboard/(main)/ads/page';
import { integrationDefinition } from '@/lib/integrations';

describe('Paid Ads workspace tab navigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/dashboard/ads?tab=recommendations&campaign=42');
  });

  it('switches controlled content immediately and closes stale detail parameters', () => {
    render(<PaidAdsPage/>);
    expect(screen.getByText('Performance workspace mounted')).toBeInTheDocument();

    const campaignsTab = screen.getByRole('tab', { name: 'Campaigns' });
    fireEvent.mouseDown(campaignsTab, { button: 0, ctrlKey: false });
    fireEvent.click(campaignsTab);

    expect(campaignsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Campaign inventory mounted')).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/dashboard/ads?tab=campaigns');

    fireEvent.click(screen.getByRole('button', { name: 'Open provider detail' }));
    expect(screen.getByText('Performance workspace mounted')).toBeInTheDocument();
    expect(screen.getByText('Provider detail: provider-7')).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/dashboard/ads?tab=overview&provider=meta&providerCampaign=provider-7&detail=units&unit=adset-9');

    fireEvent.mouseDown(campaignsTab, { button: 0, ctrlKey: false });
    fireEvent.click(campaignsTab);
    expect(screen.getByText('Campaign inventory mounted')).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/dashboard/ads?tab=campaigns');

    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    fireEvent.mouseDown(overviewTab, { button: 0, ctrlKey: false });
    fireEvent.click(overviewTab);
    expect(screen.getByText('Performance workspace mounted')).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/dashboard/ads?tab=overview');
  }, 15_000);

  it('keeps Paid Ads in one business view and removes the global mode switch', () => {
    render(<PaidAdsPage/>);
    expect(screen.getByText('Performance view: Standard')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Advanced view' })).not.toBeInTheDocument();

    const campaignsTab = screen.getByRole('tab', { name: 'Campaigns' });
    fireEvent.mouseDown(campaignsTab, { button: 0, ctrlKey: false });
    fireEvent.click(campaignsTab);
    expect(screen.getByText('Campaign view: Standard')).toBeInTheDocument();
  });

  it('ignores legacy view parameters without changing Paid Ads visibility', () => {
    const { rerender } = render(<PaidAdsPage/>);
    expect(screen.getByText('Performance view: Standard')).toBeInTheDocument();

    window.history.replaceState(null, '', '/dashboard/ads?tab=recommendations&view=advanced');
    rerender(<PaidAdsPage/>);
    expect(screen.getByText('Performance view: Standard')).toBeInTheDocument();

    window.history.replaceState(null, '', '/dashboard/ads?tab=recommendations&view=standard');
    rerender(<PaidAdsPage/>);
    expect(screen.getByText('Performance view: Standard')).toBeInTheDocument();
  });

  it.each(['meta', 'google-ads'] as const)('opens %s campaign and performance features in their matching tabs', provider => {
    const features = integrationDefinition(provider).features;
    const campaigns = features.find(feature => feature.name === 'Paid campaigns')!;
    const performance = features.find(feature => feature.name === 'Ad performance')!;
    window.history.replaceState(null, '', campaigns.href);
    const { rerender } = render(<PaidAdsPage/>);
    expect(screen.getByRole('tab', { name: 'Campaigns' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Campaign inventory mounted')).toBeInTheDocument();

    window.history.replaceState(null, '', performance.href);
    rerender(<PaidAdsPage/>);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Performance workspace mounted')).toBeInTheDocument();
    expect(screen.queryByText('Campaign inventory mounted')).not.toBeInTheDocument();
  });

  it.each(['/dashboard/ads', '/dashboard/ads?tab=analytics'])('retains the performance overview at the legacy entry %s', href => {
    window.history.replaceState(null, '', href);
    render(<PaidAdsPage/>);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Performance workspace mounted')).toBeInTheDocument();
  });
});
