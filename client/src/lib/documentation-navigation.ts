import { isHiddenDashboardPath, moduleForDashboardPath, type PlatformModuleKey } from './platform-access';

export const DOCUMENTATION_ROOT = '/documentation';

// Keep context matching lightweight: importing this in the shell must not bundle
// the full guide or a diagram renderer onto ordinary dashboard pages.
const contexts: readonly [string, string][] = [
  ['/dashboard/settings/outreach', 'assistants'],
  ['/dashboard/settings/workspace', 'settings-and-security'],
  ['/dashboard/settings/company', 'business-and-brands'],
  ['/dashboard/business-profiles', 'business-and-brands'],
  ['/dashboard/brand-toolkit', 'business-and-brands'],
  ['/dashboard/knowledge-base', 'knowledge-and-privacy'],
  ['/dashboard/proposals', 'proposals'],
  ['/dashboard/crm/import', 'imports-and-exports'],
  ['/dashboard/crm/automations', 'automations'],
  ['/dashboard/crm', 'crm'],
  ['/dashboard/outreach/follow-ups', 'manual-follow-ups'],
  ['/dashboard/outreach', 'campaigns-and-outreach'],
  ['/dashboard/outreach-analytics', 'campaigns-and-outreach'],
  ['/dashboard/campaigns', 'campaigns-and-outreach'],
  ['/dashboard/conversations', 'campaigns-and-outreach'],
  ['/dashboard/chats', 'campaigns-and-outreach'],
  ['/dashboard/chat', 'campaigns-and-outreach'],
  ['/dashboard/leads', 'leads'],
  ['/dashboard/enrichment', 'leads'],
  ['/dashboard/settings/leads', 'leads'],
  ['/dashboard/saved-templates/email', 'email-and-templates'],
  ['/dashboard/saved-templates', 'content'],
  ['/dashboard/content-calendar', 'content'],
  ['/dashboard/content', 'content'],
  ['/dashboard/marketing/analytics', 'social-insights'],
  ['/dashboard/marketing', 'paid-marketing'],
  ['/dashboard/ads', 'paid-marketing'],
  ['/dashboard/ads-campaigns', 'paid-marketing'],
  ['/dashboard/ads-analytics', 'paid-marketing'],
  ['/dashboard/settings/ads', 'paid-marketing'],
  ['/dashboard/ai-visibility', 'ai-visibility'],
  ['/dashboard/support-ai', 'support'],
  ['/dashboard/support', 'support'],
  ['/dashboard/storage', 'storage'],
  ['/dashboard/billing', 'billing'],
  ['/dashboard/integrations', 'integrations'],
  ['/dashboard/settings/integrations', 'integrations'],
  ['/dashboard/settings', 'settings-and-security'],
  ['/dashboard/notifications', 'settings-and-security'],
  ['/dashboard/insights', 'settings-and-security'],
  ['/dashboard/home', 'getting-started'],
];

export function documentationHrefForPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const slug = contexts.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1];
  return slug ? `${DOCUMENTATION_ROOT}/${slug}` : null;
}

export interface DocumentationAccess {
  verified: boolean;
  modules: readonly PlatformModuleKey[];
  role?: 'owner' | 'billing_admin' | 'member';
}

/** Navigation only: the target's own route/API authorization is authoritative. */
export function canOpenDocumentationDestination(href: string, access: DocumentationAccess): boolean {
  if (!access.verified || !access.role || !href.startsWith('/dashboard/') || href.includes('\\')) return false;
  const path = href.split(/[?#]/)[0];
  if (isHiddenDashboardPath(path)) return false;
  const module = path.startsWith('/dashboard/settings/outreach') ? 'support_ai' : moduleForDashboardPath(path);
  if (module && !access.modules.includes(module)) return false;
  if (/^\/dashboard\/(?:integrations|settings\/integrations|billing)(\/|$)/.test(path) && access.role === 'member') return false;
  if (/^\/dashboard\/(?:business-profiles|settings\/company|support\/(?:teams|notifications))(\/|$)/.test(path) && access.role !== 'owner') return false;
  return true;
}
