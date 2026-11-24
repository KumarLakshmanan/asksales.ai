import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PerformanceMarketingTab from '@/components/tabs/PerformanceMarketingTab';
import PerformanceMarketingDashboard from '@/components/PerformanceMarketingDashboard';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ campaigns: [{ id: 31, platform: 'google', campaign_type: 'search', budget: 1000, currency: 'USD', status: 'draft', created_at: '2026-10-27T00:00:00Z' }] });
  mocks.post.mockResolvedValue({ optimization: { recommendations: [] } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Performance Marketing campaign context', () => {
  it('shows loading instead of creation guidance or stale planning data while context is pending', () => {
    render(<PerformanceMarketingTab icpId={99} icpStatus="loading" onSendMessage={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading campaign context…');
    expect(screen.queryByRole('button', { name: 'Create an ICP' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Budget Plan' })).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('opens planning once the selected ICP finishes loading without requesting creation', async () => {
    const create = vi.fn();
    const view = render(<PerformanceMarketingTab icpStatus="loading" onSendMessage={create} />);
    view.rerender(<PerformanceMarketingTab icpId={71} icpStatus="ready" onSendMessage={create} />);
    expect(screen.getByRole('tab', { name: 'Budget Plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create an ICP' })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/campaigns/performance/campaigns?icp_id=71'));
    expect(create).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('keeps setup guidance for a successfully checked campaign with no ICP', async () => {
    const create = vi.fn();
    render(<PerformanceMarketingTab icpStatus="ready" onSendMessage={create} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create an ICP' }));
    expect(create).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('offers a context retry rather than duplicate setup after a failed read', async () => {
    const retry = vi.fn(), create = vi.fn();
    render(<PerformanceMarketingTab icpStatus="error" onRetryIcp={retry} onSendMessage={create} />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByRole('button', { name: 'Create an ICP' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry campaign context' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

async function openOptimization() {
  render(<PerformanceMarketingDashboard icpId={71} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Optimize' }));
  await user.click(screen.getByRole('combobox', { name: 'Select Campaign' }));
  await user.click(await screen.findByRole('option', { name: /google - search/ }));
  return user;
}

describe('Optimization metric fields', () => {
  it('uses labeled numeric metrics and preserves the existing numeric API payload', async () => {
    const user = await openOptimization();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
    const entries = { Impressions: '50000', Clicks: '1500', Conversions: '75', 'Amount spent (USD)': '5000', 'Click-through rate (%)': '3', 'Cost per acquisition (USD)': '66.67', 'Return on ad spend (×)': '3' };
    for (const [label, value] of Object.entries(entries)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(mocks.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Generate Optimization Recommendations' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/campaigns/performance/optimize', {
      campaign_id: 31, current_metrics: { impressions: 50000, clicks: 1500, conversions: 75, spend: 5000, ctr: 3, cpa: 66.67, roas: 3 },
    }));
  });
  it('requires at least one metric before requesting recommendations', async () => {
    const user = await openOptimization();
    await user.click(screen.getByRole('button', { name: 'Generate Optimization Recommendations' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter at least one current metric.');
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([
    ['Impressions', '1.5', 'Enter a whole number of zero or more.'],
    ['Clicks', '-1', 'Enter a number of zero or more.'],
    ['Amount spent (USD)', '-0.01', 'Enter a number of zero or more.'],
    ['Click-through rate (%)', '101', 'Enter a percentage between 0 and 100.'],
  ])('rejects an invalid %s without a request and retains the draft', async (label, value, error) => {
    const user = await openOptimization();
    const field = screen.getByLabelText(label);
    fireEvent.change(field, { target: { value } });
    await user.click(screen.getByRole('button', { name: 'Generate Optimization Recommendations' }));
    expect(screen.getByRole('alert')).toHaveTextContent(error);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveValue(Number(value));
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('preserves a measured zero and omits unknown metrics', async () => {
    const user = await openOptimization();
    fireEvent.change(screen.getByLabelText('Amount spent (USD)'), { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: 'Generate Optimization Recommendations' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/campaigns/performance/optimize', { campaign_id: 31, current_metrics: { spend: 0 } }));
  });
});
