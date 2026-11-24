import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { SmsSendingEstimate } from '@/components/content-studio/SmsSendingEstimate';
const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ default: { get } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SmsSendingEstimate /></QueryClientProvider>); }
it('shows configured platform credits without pretending to quote carrier fees', async () => {
  get.mockResolvedValue({ sms: { creditsPerMessage: 3 } }); mount();
  expect(await screen.findByText(/AskSales outreach fee: 3 credits per message/)).toBeInTheDocument();
  expect(screen.getByText(/Carrier\/provider pricing is not quoted/)).toBeInTheDocument();
});
it('does not substitute a fake price when the estimate is unavailable', async () => {
  get.mockRejectedValue(new Error('offline')); mount();
  expect(await screen.findByText(/Configured outreach fee unavailable/)).toBeInTheDocument();
});
