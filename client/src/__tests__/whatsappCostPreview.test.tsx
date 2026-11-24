import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppCostPreview } from '@/components/outreach/create/WhatsAppCostPreview';

const state = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { post: state.post } }));

const quote = {
  platformBilled: true, messages: 3, messageCredits: 16.15, platformFeeCredits: 6, totalCredits: 22.15,
  byCategory: { utility: { messages: 2, credits: 16.15 }, service: { messages: 1, credits: 0 } },
  estimatedRecipients: 0, missingRates: [], walletBalance: 100, sufficient: true,
};
const items = [{ recipient: '919876543210', templateName: 'order_update', templateLanguage: 'en' }];
function mount(props = { items, phoneNumberId: 'phone-1' }) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <dl><WhatsAppCostPreview {...props} /></dl>
  </QueryClientProvider>);
}
beforeEach(() => state.post.mockReset());
afterEach(cleanup);

describe('WhatsApp cost in the outreach summary', () => {
  it('shows the total, the Meta and fee split, and the messages by category', async () => {
    state.post.mockResolvedValue(quote);
    mount();
    expect(await screen.findByText('About 22.15 credits')).toBeInTheDocument();
    expect(screen.getByText(/16\.15 Meta \+ 6 fee/)).toBeInTheDocument();
    expect(screen.getByText(/2 utility · 1 replies/)).toBeInTheDocument();
    expect(state.post).toHaveBeenCalledWith('/api/whatsapp/billing/quote', { phoneNumberId: 'phone-1', items });
  });

  it('warns when the wallet is short or a rate is missing', async () => {
    state.post.mockResolvedValue({ ...quote, walletBalance: 10, sufficient: false });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your wallet has 10 credits. Recharge before launching.');
    cleanup();
    state.post.mockResolvedValue({ ...quote, missingRates: ['marketing / Brazil'], sufficient: false });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('No price yet for marketing / Brazil');
  });

  it('shows nothing for accounts that pay Meta themselves, or with no recipients', async () => {
    state.post.mockResolvedValue({ ...quote, platformBilled: false });
    const { container } = mount();
    await vi.waitFor(() => expect(state.post).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector('dt')).toBeNull());
    cleanup();
    state.post.mockClear();
    mount({ items: [], phoneNumberId: 'phone-1' });
    expect(state.post).not.toHaveBeenCalled();
  });
});
