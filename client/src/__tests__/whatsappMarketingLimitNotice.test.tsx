import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppMarketingLimitNotice } from '@/components/outreach/create/WhatsAppMarketingLimitNotice';

const state = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { post: state.post } }));

function mount(props: Partial<React.ComponentProps<typeof WhatsAppMarketingLimitNotice>> = {}) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <dl><WhatsAppMarketingLimitNotice leadIds={[142, 144]} phoneNumberId="phone-1" templateName="2nightstay" templateLanguage="en" {...props} /></dl>
  </QueryClientProvider>);
}
beforeEach(() => state.post.mockReset());
afterEach(cleanup);

describe('WhatsApp marketing limit in the outreach summary', () => {
  it('names how many recipients Meta recently held marketing messages back from', async () => {
    state.post.mockResolvedValue({ marketing: true, leadIds: [142] });
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent(
      "1 recipient has reached WhatsApp's marketing message limit in the last 24 hours.",
    );
    expect(state.post).toHaveBeenCalledWith('/api/whatsapp/marketing-limit', {
      phoneNumberId: 'phone-1', templateName: '2nightstay', templateLanguage: 'en', leadIds: [142, 144],
    });
  });

  it('stays quiet for utility templates, clear recipients, failures and free-form messages', async () => {
    state.post.mockResolvedValue({ marketing: false, leadIds: [] });
    mount();
    await waitFor(() => expect(state.post).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    cleanup();
    state.post.mockRejectedValue(new Error('offline'));
    mount();
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    cleanup();
    state.post.mockReset();
    mount({ templateName: undefined });
    expect(state.post).not.toHaveBeenCalled();
  });
});
