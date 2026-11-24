import type { BusinessProfileSummary } from '@/hooks/use-business-profiles';
import type { PlatformAccessResponse, PlatformModuleKey } from '@/lib/platform-access';

export const ACCOUNT_SETTINGS_HREF = '/dashboard/settings';
export const WORKSPACE_SETTINGS_HREF = '/dashboard/settings/workspace';

type WorkspaceRole = NonNullable<BusinessProfileSummary['role']>;
type SettingsGroup = 'workspace' | 'sales' | 'support' | 'connections';

export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  workspace: 'Business & access',
  sales: 'Sales & marketing',
  support: 'Customer support',
  connections: 'Connections',
};

export interface WorkspaceSettingsDestination {
  id: string;
  label: string;
  href: string;
  group: SettingsGroup;
  scope: string;
  description: string;
  module?: PlatformModuleKey;
  roles: readonly WorkspaceRole[];
  editRoles?: readonly WorkspaceRole[];
}

const allRoles = ['owner', 'billing_admin', 'member'] as const;

// Navigation metadata only. The linked pages and APIs remain the authority for
// access and writes. Assistants use support_ai despite their legacy URL.
export const WORKSPACE_SETTINGS_DESTINATIONS: readonly WorkspaceSettingsDestination[] = [
  { id: 'profile', label: 'Business profile', href: '/dashboard/business-profiles/:profileId', group: 'workspace', scope: 'Workspace', description: 'Business details for the selected workspace.', roles: ['owner'] },
  { id: 'staff', label: 'Staff', href: '/dashboard/settings/team', group: 'workspace', scope: 'Workspace', description: 'Workspace members, invitations and roles.', roles: allRoles, editRoles: ['owner'] },
  { id: 'integrations', label: 'Integrations', href: '/dashboard/integrations', group: 'connections', scope: 'Workspace · connected account / channel', description: 'Connected channels and provider accounts.', module: 'integrations', roles: ['owner', 'billing_admin'] },
  { id: 'crm', label: 'CRM configuration', href: '/dashboard/crm/configuration', group: 'sales', scope: 'Workspace', description: 'Contact stages and default pipeline reporting preferences.', module: 'crm', roles: allRoles },
  { id: 'proposals', label: 'Proposal settings', href: '/dashboard/proposals/settings', group: 'sales', scope: 'Workspace', description: 'Human review and approval policy for proposals in this workspace.', module: 'proposals', roles: allRoles },
  { id: 'follow-ups', label: 'Follow-up settings', href: '/dashboard/outreach/follow-ups', group: 'sales', scope: 'Workspace · channel', description: 'Outbound follow-up timing and message templates.', module: 'outreach', roles: allRoles },
  { id: 'leads', label: 'Lead Settings', href: '/dashboard/settings/leads', group: 'sales', scope: 'Workspace', description: 'Fallback discovery sources for lead workflows.', module: 'lead_generation', roles: allRoles },
  { id: 'ads', label: 'Ad Settings', href: '/dashboard/settings/ads', group: 'sales', scope: 'Workspace', description: 'Campaign defaults, AI permissions and connection readiness.', module: 'performance_marketing', roles: allRoles },
  { id: 'assistants', label: 'Assistants', href: '/dashboard/settings/outreach', group: 'support', scope: 'Workspace · receiving account / channel', description: 'Reply behavior and resources; assignments affect the chosen receiving account and message surface.', module: 'support_ai', roles: allRoles, editRoles: ['owner'] },
  { id: 'widget', label: 'Widget settings', href: '/dashboard/support-ai/widget-settings', group: 'support', scope: 'Workspace · support team · website channel', description: 'Website chat appearance and greeting for the support team selected on the widget page.', module: 'support_ai', roles: allRoles },
  { id: 'support-teams', label: 'Support teams', href: '/dashboard/support/teams', group: 'support', scope: 'Workspace · support team', description: 'Support teams, their members and handoff configuration.', module: 'support', roles: ['owner'] },
  { id: 'support-notifications', label: 'Support notifications', href: '/dashboard/support/notifications', group: 'support', scope: 'Workspace · all support teams', description: 'Email and WhatsApp ticket-assignment alerts for support members.', module: 'support', roles: ['owner'] },
];

export function workspaceSettingsDestinations(profile: BusinessProfileSummary, access: PlatformAccessResponse) {
  if (!profile.role || access.maintenance.enabled || access.subscription?.allowed === false) return [];
  const role = profile.role;
  return WORKSPACE_SETTINGS_DESTINATIONS.filter(destination => {
    if (!destination.roles.includes(role)) return false;
    if (!destination.module) return true;
    const moduleAccess = access.modules.find(item => item.key === destination.module);
    return moduleAccess?.enabled === true && moduleAccess.status === 'available' && moduleAccess.mode !== 'disabled';
  }).map(destination => ({
    ...destination,
    href: destination.href.replace(':profileId', String(profile.id)),
    readOnly: Boolean(destination.editRoles && (!destination.editRoles.includes(role) || (destination.id === 'staff' && profile.canManageTeam === false))),
  }));
}
