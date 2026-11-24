import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LeadDetailSheet } from '@/components/LeadDetailSheet';
import type { Lead } from '@/models/lead';
import { isLeadOutreachLocked } from '@/lib/leadReviewGate';
import { api } from '@/lib/api';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const lead = {
  id: 101,
  name: 'Nandi Hills Retreat',
  company: 'Nandi Hills Retreat',
  email: 'hello@example.test',
  source: 'google_maps',
  platformType: 'google_maps',
  status: 'new',
};

describe('lead detail review gate', () => {
  it('does not reuse an Instagram username for a fabricated Twitter link', () => {
    render(<LeadDetailSheet lead={{ ...lead, source: 'instagram_post_authors', platformType: 'instagram_post_authors', instagramHandle: 'rioboutiquegoa', twitterHandle: 'rioboutiquegoa' } as Lead} open onOpenChange={vi.fn()} outreachLocked />);
    expect(screen.queryByRole('link', { name: /Twitter/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Instagram/ })).toHaveAttribute('href', 'https://www.instagram.com/rioboutiquegoa');
  }, 15_000);
  it('hides historical mislabeled Facebook links while preserving real profiles', () => {
    const { rerender } = render(<LeadDetailSheet lead={{ ...lead, facebookUrl: 'https://maps.google.com/place/123' } as Lead} open onOpenChange={vi.fn()} outreachLocked />);
    expect(screen.queryByRole('link', { name: 'Facebook' })).not.toBeInTheDocument();
    rerender(<LeadDetailSheet lead={{ ...lead, facebookUrl: 'https://www.facebook.com/hotel' } as Lead} open onOpenChange={vi.fn()} outreachLocked />);
    expect(screen.getByRole('link', { name: 'Facebook' })).toHaveAttribute('href', 'https://www.facebook.com/hotel');
  }, 15_000);

  it('fails closed while campaign review state is loading or unavailable', () => {
    expect(isLeadOutreachLocked(77, {
      workflowExecuted: false,
      approved: false,
      loading: true,
      error: false,
    })).toBe(true);
    expect(isLeadOutreachLocked(77, {
      workflowExecuted: false,
      approved: false,
      loading: false,
      error: true,
    })).toBe(true);
    expect(isLeadOutreachLocked(77, {
      workflowExecuted: true,
      approved: false,
      loading: false,
      error: false,
    })).toBe(true);
    expect(isLeadOutreachLocked(77, {
      workflowExecuted: true,
      approved: true,
      loading: false,
      error: false,
    })).toBe(false);
  });

  it('keeps outreach disabled until the generated lead set is approved', () => {
    const { rerender } = render(
      <LeadDetailSheet
        lead={lead as Lead}
        open
        onOpenChange={vi.fn()}
        threadId={77}
        outreachLocked
      />,
    );

    expect(screen.getByRole('button', { name: 'Approve leads first' })).toBeDisabled();

    rerender(
      <LeadDetailSheet
        lead={lead as Lead}
        open
        onOpenChange={vi.fn()}
        threadId={77}
        outreachLocked={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Start Outreach' })).toBeEnabled();
  }, 15_000);

  it('opens the reviewed composer for an email lead', async () => {
    vi.mocked(api.get).mockResolvedValue([{ id: 1 }] as never);
    render(<LeadDetailSheet lead={lead as Lead} open onOpenChange={vi.fn()} outreachLocked={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Outreach' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/outreach/create?channel=email&leadId=101'));
  });
});
