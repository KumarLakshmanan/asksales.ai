import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CampaignChatHeader from '@/components/CampaignChatHeader';

describe('CampaignChatHeader', () => {
  it('names the workspace view picker accurately and preserves mouse and keyboard activation', async () => {
    const onSearch = vi.fn();
    const user = userEvent.setup();
    render(<CampaignChatHeader threadId={42} onSearch={onSearch} />);

    const search = screen.getByRole('button', { name: 'Search workspace views' });
    expect(search).toHaveAttribute('title', 'Search workspace views');
    await user.click(search);
    expect(onSearch).toHaveBeenCalledTimes(1);
    await user.keyboard('{Enter}');
    expect(onSearch).toHaveBeenCalledTimes(2);
  });

  it('labels an unsaved campaign without fabricated historical dates', () => {
    render(<CampaignChatHeader />);
    expect(screen.getByRole('heading', { name: 'New campaign' })).toBeInTheDocument();
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
    expect(screen.queryByText(/2023|30 days/)).not.toBeInTheDocument();
  });

  it('does not invent timestamps for a saved campaign with no activity', () => {
    render(<CampaignChatHeader threadId={42} />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });

  it('renders immediate activity without a duplicated ago suffix', async () => {
    render(<CampaignChatHeader lastMessageAt={Date.now()} />);

    expect(await screen.findByText(/just now/)).toBeInTheDocument();
    expect(screen.queryByText(/just now ago/)).not.toBeInTheDocument();
  });
});
