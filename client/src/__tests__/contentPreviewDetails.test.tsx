import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EmailCard from '@/components/content-cards/EmailCard';
import SocialPostCard from '@/components/content-cards/SocialPostCard';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

describe('saved content preview details', () => {
  beforeEach(() => toast.mockClear());

  it('preserves a separately supplied email subject in fullscreen without invented addresses', () => {
    render(<EmailCard title="Internal draft title" subject="Actual subject" content="Email body" />);
    expect(screen.queryByText('marketing@yourcompany.com')).not.toBeInTheDocument();
    expect(screen.queryByText('recipient@example.com')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View fullscreen' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Subject: Actual subject')).toBeInTheDocument();
    expect(within(dialog).getByText('Email body')).toBeInTheDocument();
  });

  it('reports a denied clipboard write instead of claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    render(<EmailCard title="Draft" subject="Subject" content="Body" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not copy' })));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Copied' }));
  });

  it('does not repeat hashtags already included in a saved social caption', () => {
    render(<SocialPostCard title="Draft" content={JSON.stringify({ caption: 'Hello #QualityCheck', hashtags: ['QualityCheck', 'NewTag'] })} />);
    expect(screen.queryByText('#QualityCheck', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('Hello #QualityCheck')).toBeInTheDocument();
    expect(screen.getByText('#NewTag', { exact: true })).toBeInTheDocument();
  });
});
