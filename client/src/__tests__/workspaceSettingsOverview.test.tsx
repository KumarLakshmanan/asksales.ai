import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSettingsOverview } from '@/components/settings/WorkspaceSettingsOverview';
import { WorkspaceSettingsScope } from '@/components/settings/WorkspaceSettingsScope';
import SettingsPage from '@/app/dashboard/(main)/settings/page';
import ProposalSettingsPage from '@/app/dashboard/(main)/proposals/settings/page';
import type { PlatformAccessResponse, PlatformModuleKey } from '@/lib/platform-access';
import { workspaceSettingsDestinations } from '@/lib/settings-navigation';
import type { BusinessProfileSummary } from '@/hooks/use-business-profiles';

const mocks = vi.hoisted(() => ({
  profile: { id: 11, companyName: 'North workspace', role: 'owner' } as BusinessProfileSummary | null,
  profilesLoading: false, profilesError: false, accessLoading: false, accessError: false,
  access: null as PlatformAccessResponse | null,
  profilesRefetch: vi.fn(), accessRefetch: vi.fn(), get: vi.fn(), put: vi.fn(), post: vi.fn(),
  push: vi.fn(), logout: vi.fn(), toast: vi.fn(),
}));
vi.mock('@/hooks/use-business-profiles', () => ({
  useBusinessProfiles: () => ({ activeProfile: mocks.profile, isLoading: mocks.profilesLoading, isError: mocks.profilesError, refetch: mocks.profilesRefetch }),
  businessProfileName: (profile: BusinessProfileSummary) => profile.companyName,
}));
vi.mock('@/hooks/use-platform-access', () => ({ usePlatformAccess: () => ({ data: mocks.access, isLoading: mocks.accessLoading, isError: mocks.accessError, refetch: mocks.accessRefetch }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, email: 'fixture@example.test', workspaceRole: 'owner' }, isLoading: false, logout: mocks.logout }) }));
vi.mock('@/lib/api', () => ({ default: mocks, api: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), usePathname: () => '/dashboard/settings', useSearchParams: () => new URLSearchParams('tab=support') }));

const moduleKeys: PlatformModuleKey[] = ['crm', 'proposals', 'integrations', 'support_ai', 'support'];
function available(): PlatformAccessResponse {
  return { maintenance: { enabled: false, message: '' }, modules: moduleKeys.map(key => ({ key, name: key, description: '', enabled: true, mode: 'inherit', status: 'available', message: null })) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profile = { id: 11, companyName: 'North workspace', role: 'owner' };
  mocks.profilesLoading = mocks.profilesError = mocks.accessLoading = mocks.accessError = false;
  mocks.access = available();
  mocks.get.mockImplementation(async (url: string) => url.endsWith('/review-policy') ? { policy: { enabled: false, requireReviewBeforeAiSend: true }, reviewers: [] } : url.endsWith('notification-preferences') ? { leadAlerts: true, campaignUpdates: true } : { name: 'Fixture', email: 'fixture@example.test' });
});
afterEach(cleanup);

describe('workspace settings discovery permissions and scope', () => {
  it('associates each category tab with its result panel', () => {
    render(<WorkspaceSettingsOverview />);
    for (const tab of screen.getAllByRole('tab')) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') || '');
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    }
  });
  it('includes lead, ad and follow-up settings only when their modules are available', () => {
    mocks.access!.modules.push(...(['lead_generation', 'performance_marketing', 'outreach'] as const).map(key => ({ key, name: key, description: '', enabled: true, mode: 'inherit' as const, status: 'available' as const, message: null })));
    const view = render(<WorkspaceSettingsOverview />);
    expect(screen.getByRole('link', { name: /^Lead Settings/ })).toHaveAttribute('href', '/dashboard/settings/leads');
    expect(screen.getByRole('link', { name: /^Ad Settings/ })).toHaveAttribute('href', '/dashboard/settings/ads');
    expect(screen.getByRole('link', { name: /^Follow-up settings/ })).toHaveAttribute('href', '/dashboard/outreach/follow-ups');
    mocks.access!.modules = mocks.access!.modules.filter(item => !['lead_generation', 'performance_marketing', 'outreach'].includes(item.key));
    view.rerender(<WorkspaceSettingsOverview />);
    expect(screen.queryByRole('link', { name: /^Lead Settings|^Ad Settings|^Follow-up settings/ })).toBeNull();
  });
  it('links owners to existing canonical pages without adding forms or writes', () => {
    render(<WorkspaceSettingsOverview />);
    expect(screen.getByText('Workspace: North workspace')).toBeVisible();
    expect(screen.getByRole('link', { name: /Business profile/ })).toHaveAttribute('href', '/dashboard/business-profiles/11');
    expect(screen.getByRole('link', { name: /^Assistants/ })).toHaveAttribute('href', '/dashboard/settings/outreach');
    expect(screen.getByRole('link', { name: /Widget settings/ })).toHaveAttribute('href', '/dashboard/support-ai/widget-settings');
    expect(document.querySelector('form')).toBeNull();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each(['member', 'billing_admin'] as const)('uses the selected workspace %s role instead of the account owner role', role => {
    mocks.profile!.role = role;
    render(<WorkspaceSettingsOverview />);
    expect(screen.queryByRole('link', { name: /Business profile|Support teams|Support notifications/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Staff/ })).toHaveTextContent('View only');
    expect(screen.getByRole('link', { name: /^Assistants/ })).toHaveTextContent('View only');
    expect(screen.getByRole('link', { name: /CRM configuration/ })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Integrations/ }) !== null).toBe(role === 'billing_admin');
  });
  it('marks staff view only if team management has been denied to an owner', () => {
    mocks.profile!.canManageTeam = false;
    render(<WorkspaceSettingsOverview />);
    expect(screen.getByRole('link', { name: /^Staff/ })).toHaveTextContent('View only');
  });
  it.each(['missing', 'disabled', 'maintenance', 'mode-disabled'] as const)('hides unavailable %s modules including the legacy Assistants route', state => {
    mocks.access!.modules = state === 'missing' ? [] : mocks.access!.modules.map(item => ({ ...item, enabled: state === 'mode-disabled', mode: state === 'mode-disabled' ? 'disabled' : item.mode, status: state === 'maintenance' ? 'maintenance' : state === 'disabled' ? 'disabled' : item.status }));
    render(<WorkspaceSettingsOverview />);
    expect(screen.queryByRole('link', { name: /CRM configuration|Proposal settings|Assistants|Widget settings|Integrations|Support notifications|Support teams/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sales & marketing' })).not.toBeInTheDocument();
  });
  it.each(['profile', 'access'] as const)('withholds links on failed %s refresh even if stale data exists and offers retry', failure => {
    mocks.profilesError = failure === 'profile';
    mocks.accessError = failure === 'access';
    render(<WorkspaceSettingsOverview />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be verified');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.profilesRefetch).toHaveBeenCalledOnce();
    expect(mocks.accessRefetch).toHaveBeenCalledOnce();
  });
  it('withholds links while selection resolves, then recomputes scope, routes and role on a workspace switch', () => {
    const view = render(<WorkspaceSettingsOverview />);
    mocks.profilesLoading = true;
    view.rerender(<WorkspaceSettingsOverview />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    mocks.profile = { id: 22, companyName: 'South workspace', role: 'member' };
    mocks.profilesLoading = false;
    view.rerender(<WorkspaceSettingsOverview />);
    expect(screen.queryByText('Workspace: North workspace')).not.toBeInTheDocument();
    expect(screen.getByText('Workspace: South workspace')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Business profile|Integrations|Support notifications/ })).not.toBeInTheDocument();
  });
  it('provides an empty state and a workspace chooser without guessing a profile', () => {
    mocks.profile = null;
    render(<WorkspaceSettingsOverview />);
    expect(screen.getByRole('link', { name: 'Choose a workspace' })).toHaveAttribute('href', '/dashboard/select-profile');
    expect(screen.queryByRole('link', { name: /Widget settings/ })).not.toBeInTheDocument();
  });
  it('does not offer links when the role is unverified or global access is denied', () => {
    const profile = mocks.profile!;
    expect(workspaceSettingsDestinations({ ...profile, role: undefined }, mocks.access!)).toEqual([]);
    mocks.access!.maintenance.enabled = true;
    expect(workspaceSettingsDestinations(profile, mocks.access!)).toEqual([]);
    render(<WorkspaceSettingsOverview />);
    expect(screen.getByRole('status')).toHaveTextContent('No configuration links');
  });
  it('keeps the legacy support tab but clearly scopes it and hides owner actions for staff', async () => {
    mocks.profile!.role = 'member';
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: 'Account settings' })).toBeVisible();
    expect(screen.getByText('Account: fixture@example.test')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace support' })).toBeVisible());
    expect(screen.queryByRole('link', { name: /Support notifications/ })).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('identifies the selected workspace and team/channel on contextual settings surfaces', () => {
    render(<WorkspaceSettingsScope detail="Website channel · support team: North help" />);
    const scope = screen.getByRole('region', { name: 'Setting scope' });
    expect(within(scope).getByText('Workspace: North workspace')).toBeVisible();
    expect(within(scope).getByText('Website channel · support team: North help')).toBeVisible();
    expect(within(scope).getByRole('link', { name: 'Workspace configuration' })).toHaveAttribute('href', '/dashboard/settings/workspace');
  });
  it('reloads proposal policy on an in-place workspace switch without a save', async () => {
    const view = render(<ProposalSettingsPage />);
    await screen.findByRole('radio', { name: /Save AI proposals for human review/ });
    mocks.profile = { id: 22, companyName: 'South workspace', role: 'member' };
    mocks.get.mockResolvedValue({ policy: { enabled: false, requireReviewBeforeAiSend: false }, reviewers: [] });
    view.rerender(<ProposalSettingsPage />);
    expect(await screen.findByRole('radio', { name: /Save AI proposals for human review/ })).not.toBeChecked();
    expect(mocks.get.mock.calls.filter(([url]) => url === '/api/proposals/review-policy')).toHaveLength(2);
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
