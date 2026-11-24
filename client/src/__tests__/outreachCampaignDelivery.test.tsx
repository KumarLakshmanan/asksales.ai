import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutreachPage from '@/app/dashboard/(main)/outreach/activity/page';
import { api } from '@/lib/api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe('outreach campaign delivery truthfulness', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/outreach/stats') return { totalSent: 2, byChannel: { email: { sent: 2, delivered: 0 } }, byStatus: { sent: 2, pending: 1, failed: 0 } } as never;
      if (url === '/api/outreach/messages') return [] as never;
      return { campaigns: [{
        id: 7, campaign_name: 'Reviewed recipients', campaign_type: 'email', status: 'queued_partial',
        job_count: 3, sent_count: 2, delivered_count: 0, pending_count: 1, failed_count: 0,
        failed_before_enqueue_count: 1,
      }] } as never;
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('separates sent from delivered and retains pre-queue failures in the displayed total', async () => {
    render(<OutreachPage />);
    expect(await screen.findByText('Reviewed recipients')).toBeInTheDocument();
    expect(screen.getByText('2 sent · 0 delivered · 1 queued · 1 failed · 4 total steps')).toBeInTheDocument();
    expect(screen.getByText('Partially queued')).toBeInTheDocument();
    expect(screen.getByText(/1 could not be queued/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // An enqueue failure does not have a saved delivery job to blindly retry.
    expect(screen.queryByRole('button', { name: 'Retry failed' })).not.toBeInTheDocument();
  });

  it('makes an uncertain provider outcome visible without offering an automatic resend', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/outreach/stats') return { totalSent: 0, byChannel: {}, byStatus: { sent: 0, pending: 0, failed: 0 } } as never;
      if (url === '/api/outreach/messages') return [] as never;
      return { campaigns: [{
        id: 7, campaign_name: 'Needs receipt check', campaign_type: 'email', status: 'needs_attention',
        job_count: 1, sent_count: 0, delivered_count: 0, pending_count: 0, failed_count: 1, manual_review_count: 1,
      }] } as never;
    });
    render(<OutreachPage />);
    expect(await screen.findByText('Needs receipt check')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('1 pending confirmation')).toBeInTheDocument();
    expect(screen.getByText('0 sent · 0 delivered · 0 queued · 0 failed · 1 total steps')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry failed' })).not.toBeInTheDocument();
  });

  it('warns that existing jobs may send when queue confirmation is incomplete', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/outreach/stats') return { totalSent: 0, byChannel: {}, byStatus: { sent: 0, pending: 1, failed: 0 } } as never;
      if (url === '/api/outreach/messages') return [] as never;
      return { campaigns: [{ id: 8, campaign_name: 'Lost acknowledgement', campaign_type: 'email', status: 'needs_attention',
        job_count: 1, pending_count: 1, queue_issue: 'queue_receipt_conflict' }] } as never;
    });
    render(<OutreachPage />);
    expect(await screen.findByText(/Saved jobs may still send/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry failed' })).not.toBeInTheDocument();
  });

  it('links saved drafts to the canonical delivery review', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/outreach/stats') return { totalSent: 0, byChannel: {}, byStatus: { sent: 0, pending: 0, failed: 0 } } as never;
      if (url === '/api/outreach/messages') return [] as never;
      return { campaigns: [{ id: 24, campaign_name: 'Draft for review', campaign_type: 'email', status: 'draft' }] } as never;
    });
    render(<OutreachPage />);
    expect(await screen.findByRole('link', { name: 'Review delivery' })).toHaveAttribute('href', '/dashboard/outreach/campaigns/24/review');
  });

  it('keeps historical paused campaigns visible without offering old job retries', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/outreach/stats') return { totalSent: 0, byChannel: {}, byStatus: { sent: 0, pending: 0, failed: 0 } } as never;
      if (url === '/api/outreach/messages') return [] as never;
      return { campaigns: [{ id: 25, campaign_name: 'Historical campaign', campaign_type: 'sms', status: 'paused', failed_count: 2, settings: { accountReviewRequired: true } }] } as never;
    });
    render(<OutreachPage />);
    expect(await screen.findByText('Historical campaign')).toBeInTheDocument();
    expect(screen.getByText(/Historical deliveries remain paused/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry failed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review delivery' })).not.toBeInTheDocument();
  });

  it('distinguishes sent follow-ups from seed progress and the stop sentinel', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/outreach/stats') return { totalSent: 5, byChannel: {}, byStatus: { sent: 5, pending: 0, failed: 0 } } as never;
      if (url === '/api/outreach/messages') return [
        { id: 1, channel: 'gmail', leadName: 'Seed progress', message: 'Original outreach', status: 'sent', isReply: false, followUpStep: 1 },
        { id: 2, channel: 'gmail', leadName: 'Stopped seed', message: 'Original before reply', status: 'sent', isReply: false, followUpStep: 9999 },
        { id: 3, channel: 'gmail', leadName: 'Actual follow-up', message: 'Checking in', status: 'sent', isReply: true, followUpStep: 2 },
        { id: 4, channel: 'gmail', leadName: 'Manual reply', message: 'Manual response', status: 'sent', isReply: true, followUpStep: null },
        { id: 5, channel: 'gmail', leadName: 'Unclassified historical row', message: 'No reply classification', status: 'sent', followUpStep: 3 },
      ] as never;
      return { campaigns: [] } as never;
    });
    render(<OutreachPage />);
    await screen.findByText('Actual follow-up');
    expect(screen.getByText('Follow-up 2')).toBeInTheDocument();
    expect(screen.getByText('Follow-ups stopped')).toBeInTheDocument();
    expect(screen.queryByText('Follow-up 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Follow-up 3')).not.toBeInTheDocument();
    expect(screen.queryByText(/Follow-up 9999/)).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each(['Hi {{first Name}}, historical message', 'Hi &#123;&#123;first_name&#125;&#125;, historical message'])('flags recorded unresolved variables without replacing or resending the historical body: %s', async message => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/outreach/stats') return { totalSent: 1, byChannel: {}, byStatus: { sent: 1, pending: 0, failed: 0 } } as never;
      if (url === '/api/outreach/messages') return [{ id: 1, channel: 'gmail', leadName: 'Historical recipient', message, status: 'sent', isReply: true, followUpStep: 1 }] as never;
      return { campaigns: [] } as never;
    });
    render(<OutreachPage />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('Unresolved variables')).toHaveAttribute('title', 'Recorded message contains unresolved template variables. Review the original sent email.');
    expect(screen.getByText('Follow-up 1')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
