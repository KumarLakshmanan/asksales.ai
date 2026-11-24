import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationCatalog } from '@/components/instagram-automations/AutomationCatalog';
import { AutomationDemo } from '@/components/instagram-automations/AutomationDemo';
import { instagramCardConnection, type InstagramAutomationOverview } from '@/lib/instagram-automations';

const readiness = { authorized: true, enabled: false, messages: false, comments: false, profile: false, richMessages: false, reasons: [], checks: [{ id: 'connection', title: 'Account authorization', ready: true, action: null }, { id: 'rollout', title: 'Live automation access', ready: false, action: 'administrator' as const }] };
afterEach(cleanup);
describe('Instagram card connection and examples', () => {
  it('shows a connected account on all five cards when live rollout is pending', () => {
    const data: InstagramAutomationOverview = { account: { id: '1001', username: 'lakshmanan_kumar' }, readiness, profiles: [], rules: [], stats: { triggers: 0, sent: 0, failed: 0, skipped: 0, pending: 0, uncertain: 0 } };
    render(<AutomationCatalog data={data} onNavigate={vi.fn()} />);
    expect(screen.getAllByText('Account connected')).toHaveLength(5);
    expect(screen.getAllByText(/Live automation access: administrator setup needed/)).toHaveLength(5);
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
  });
  it('does not infer disconnection from legacy permission or rollout blockers', () => {
    expect(instagramCardConnection({ ...readiness, authorized: undefined, checks: undefined }, 'menu').label).toBe('Connection status unavailable');
    expect(instagramCardConnection({ ...readiness, authorized: false }, 'menu').label).toBe('Reconnect Instagram');
    const commentsOnly = { ...readiness, enabled: true, comments: true };
    expect(instagramCardConnection(commentsOnly, 'comment_reply').ready).toBe(true);
    expect(instagramCardConnection(commentsOnly, 'comment_dm').ready).toBe(false);
  });
  it('shows the exact conversation starter selected and allows replay', async () => {
    render(<AutomationDemo kind="icebreakers" username="lakshmanan_kumar" />);
    await userEvent.click(screen.getByRole('button', { name: 'How can I book?' }));
    expect(screen.getByText('How can I book?')).toBeVisible();
    expect(screen.getByText(/ready for your assistant or team/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Replay Conversation starters example' }));
    expect(screen.getByText('Open DMs')).toBeVisible();
  });
  it('distinguishes a menu website link from a saved answer', async () => {
    render(<AutomationDemo kind="menu" username="lakshmanan_kumar" />);
    await userEvent.click(screen.getByRole('button', { name: 'Visit website · opens a link' }));
    expect(screen.getByText('Website preview · example only')).toBeVisible();
    expect(screen.queryByText(/Here’s our pricing guide/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous step in Main menu example' }));
    await userEvent.click(screen.getByRole('button', { name: 'Talk to us · saved answer' }));
    expect(screen.getByText(/Our team will follow up here/)).toBeVisible();
  });
  it('moves a keyword comment into a private reply without a public answer', async () => {
    render(<AutomationDemo kind="comment_dm" username="lakshmanan_kumar" />);
    await userEvent.click(screen.getByRole('button', { name: 'Try commenting GUIDE' }));
    expect(screen.getByText('GUIDE', { exact: true })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Next step in Comment to DM example' }));
    expect(screen.getByText('Private reply to your GUIDE comment')).toBeVisible();
    expect(screen.getByText(/may appear in message requests/)).toBeVisible();
  });
  it('keeps a public reply under its original comment', async () => {
    render(<AutomationDemo kind="comment_reply" username="lakshmanan_kumar" />);
    await userEvent.click(screen.getByRole('button', { name: 'Try commenting HOURS' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next step in Public comment reply example' }));
    const example = screen.getByRole('region', { name: 'Public comment reply example' });
    expect(within(example).getByText('Public reply')).toBeVisible();
    expect(within(example).getByText('What are your HOURS?')).toBeVisible();
    expect(within(example).queryByText('Direct')).not.toBeInTheDocument();
  });
  it('shows follow instructions, the visitor reply, verification and content in order', async () => {
    render(<AutomationDemo kind="follow" username="lakshmanan_kumar" />);
    const next = () => userEvent.click(screen.getByRole('button', { name: 'Next step in Follow to unlock example' }));
    await next();
    expect(screen.getByText('Follow @lakshmanan_kumar to unlock the guide, then reply DONE here.')).toBeVisible();
    expect(screen.queryByText('Follow verified')).not.toBeInTheDocument();
    await next();
    expect(screen.getByText('DONE', { exact: true })).toBeVisible();
    expect(screen.queryByText('Follow verified')).not.toBeInTheDocument();
    await next();
    expect(screen.getByText('Follow verified')).toBeVisible();
    expect(screen.getByText('Download your guide ↗')).toBeVisible();
    expect(screen.getByText(/Otherwise the visitor receives your retry instructions/)).toBeVisible();
  });
});
