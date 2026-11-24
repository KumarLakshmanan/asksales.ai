import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceNextSteps } from '@/components/WorkspaceNextSteps';
import type { OnboardingStatus } from '@/lib/workspace-next-steps';

const fixture = vi.hoisted(() => ({
  data: { profile: {}, completedTasks: ['brand'], connectedChannels: [] } as OnboardingStatus,
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: fixture.data }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 } }) }));
vi.mock('@/hooks/use-platform-access', () => ({ usePlatformAccess: () => ({ data: { modules: ['content', 'lead_generation', 'integrations'].map(key => ({ key, enabled: true })) } }) }));
vi.mock('@/lib/setup-analytics', () => ({ trackSetupEvent: vi.fn() }));

beforeEach(() => { fixture.data = { profile: {}, completedTasks: ['brand'], connectedChannels: [] }; });
afterEach(cleanup);

describe('Home completed setup summary', () => {
  it('keeps completed steps behind a native review control', async () => {
    render(<WorkspaceNextSteps profile={{ id: 2, role: 'owner' }} />);
    expect(screen.getByText('Workspace setup complete')).toBeVisible();
    expect(screen.getByRole('link', { name: /Review your brand toolkit/ })).not.toBeVisible();
    const review = screen.getByText('Review setup').closest('summary')!;
    await userEvent.click(review);
    expect(screen.getByRole('link', { name: /Review your brand toolkit/ })).toBeVisible();
    expect(screen.getByText(/1 of 1 steps complete/)).toBeVisible();
    await userEvent.click(review);
    expect(screen.getByRole('link', { name: /Review your brand toolkit/ })).not.toBeVisible();
  });

  it('keeps unfinished tasks, first goal, and review links visible', () => {
    fixture.data = { profile: { applicationUses: ['sales_leads'], setupGoal: 'Meet our first customers' }, completedTasks: ['brand'], connectedChannels: [] };
    render(<WorkspaceNextSteps profile={{ id: 2, role: 'owner' }} />);
    expect(screen.queryByText('Workspace setup complete')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Put your workspace to work' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Add your first prospects.*Next step/ })).toHaveAttribute('href', '/dashboard/leads');
    expect(screen.getByText('Meet our first customers')).toBeVisible();
  });

  it('does not claim completion for an unverified preferred channel', () => {
    fixture.data = { profile: { preferredChannels: ['Email'] }, completedTasks: ['brand'], connectedChannels: ['Email'], connectionsAvailable: false };
    render(<WorkspaceNextSteps profile={{ id: 2, role: 'owner' }} />);
    expect(screen.queryByText('Workspace setup complete')).toBeNull();
    expect(screen.getByRole('link', { name: /Check Email connection.*Next step/ })).toBeVisible();
  });
});
