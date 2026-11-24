import type { Page } from '@playwright/test';
import type { useSupportAuth } from '../../src/contexts/SupportAuthContext';
import type { SupportMemberTicket } from '../../src/lib/supportTicketWorkspace';
import { SUPPORT_QUEUE_PAGE_LIMIT, SUPPORT_QUEUE_SEARCH_LIMIT } from '../../src/lib/support-queue-query';

const supportMember = { id: 51, name: 'Synthetic Support', email: 'support@example.test', teamId: 1, teamName: 'Synthetic team', role: 'member', isActive: true } satisfies NonNullable<ReturnType<typeof useSupportAuth>['member']> & { role: 'member' | 'lead' | 'admin' };
const emptyTicketPage = { tickets: [] as SupportMemberTicket[], total: 0, totalPages: 1, page: 1 };

// Fully synthetic: no API call is forwarded to a backend.
export const lead = { id: 1490, name: 'Synthetic audit lead', company: 'Synthetic Company', email: 'audit@example.test', source: 'manual', score: 65, createdAt: '2026-10-01T00:00:00Z' };
type State = { public: boolean; supportAuthFail: boolean; ticketsFail: boolean; platformFail: boolean; slowPlatform: boolean; preferenceFail: boolean; theme: string; registerDelay: number; mutations: string[]; requests: string[]; external: string[]; errors: string[]; ticketQueries: string[] };

export async function fixtures(page: Page) {
  const state: State = { public: false, supportAuthFail: false, ticketsFail: false, platformFail: false, slowPlatform: false, preferenceFail: false, theme: 'light', registerDelay: 0, mutations: [], requests: [], external: [], errors: [], ticketQueries: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:3100') { state.external.push(url.origin + url.pathname); await route.abort('blockedbyclient'); return; }
    await route.fallback();
  });
  const shell = ['/api/platform/access', '/api/auth/me', '/api/settings/preferences', '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet', '/api/chat/threads', '/api/notifications/unread/count'];
  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url()); const p = url.pathname;
    state.requests.push(req.method() + ' ' + p + url.search);
    if (!['GET', 'HEAD'].includes(req.method())) state.mutations.push(req.method() + ' ' + p);
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (p === '/api/auth/me' && state.public) return json({ error: 'Synthetic unauthenticated visitor' }, 401);
    if (p === '/api/platform/access' && state.slowPlatform) await new Promise(resolve => setTimeout(resolve, 1500));
    if (p === '/api/platform/access' && state.platformFail) return json({ error: 'Synthetic platform outage' }, 503);
    if (p === '/api/settings/preferences') {
      if (req.method() === 'PUT') {
        if (state.preferenceFail) return json({ error: 'Synthetic preference save outage' }, 503);
        state.theme = req.postDataJSON().theme;
      }
      return json({ theme: state.theme, language: 'en', locale: 'en-US', timezone: 'UTC', currency: 'USD', dateFormat: 'MM/DD/YYYY', timeFormat: '12h' });
    }
    if (shell.includes(p)) return route.fallback();
    if (p === '/api/auth/register') {
      if (!req.postDataJSON().name?.trim()) return json({ error: 'Name is required' }, 400);
      if (state.registerDelay) await new Promise(resolve => setTimeout(resolve, state.registerDelay));
      return json({ verificationEmailSent: true });
    }
    if (p === '/api/auth/login') return json({ error: 'Synthetic invalid credentials' }, 401);
    if (p === '/api/auth/csrf-token') return json({ csrfToken: 'synthetic-csrf' });
    if (p === '/api/organizations') return json({ organizations: [], invitations: [] });
    if (p === '/api/settings/outreach/assistants/catalog') return json({ permissions: { canManage: true }, runtimeEnabled: true, accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [] });
    if (p === '/api/admin/me') return json({ admin: { id: 1, name: 'Synthetic Admin', email: 'admin@example.test', role: 'super_admin' } });
    if (p === '/api/admin/notifications') return json({ notifications: [], unreadCount: 0 });
    if (p === '/api/admin/users') return json([ { id: 1, name: 'Synthetic user', email: 'user@example.test', role: 'user', isVerified: true, isApproved: true, isSetupComplete: true, createdAt: lead.createdAt } ]);
    if (p === '/api/support-portal/me' && state.supportAuthFail) return json({ error: 'Synthetic session outage' }, 503);
    if (p === '/api/support-portal/me') return json(supportMember);
    if (p === '/api/support-portal/stats') return json({ open: 0, inProgress: 0, waitingOnCustomer: 0, resolved: 0, closed: 0, total: 0 });
    if (p === '/api/support-portal/notifications') return json({ items: [], notifications: [], unreadCount: 0 });
    if (p === '/api/support-portal/tickets') {
      state.ticketQueries.push(url.search);
      if ((url.searchParams.get('search') || '').length > SUPPORT_QUEUE_SEARCH_LIMIT) return json({ error: 'Search cannot exceed 200 characters' }, 400);
      if (Number(url.searchParams.get('page') || 1) > SUPPORT_QUEUE_PAGE_LIMIT) return json({ error: 'Invalid page number' }, 400);
      return state.ticketsFail ? json({ error: 'Synthetic ticket queue outage' }, 503) : json({ success: true, data: emptyTicketPage });
    }
    if (p === '/api/support-portal/availability') return json({ isOnCall: true, timezone: 'UTC', quietHours: { enabled: false, start: '22:00', end: '08:00' } });
    if (p === '/api/leads') return json({ data: [lead], total: 1, totalPages: 1, page: 1, pageSize: 15 });
    if (p === '/api/leads/1490') return json(lead);
    if (p === '/api/leads/stats') return json({ success: false });
    if (p === '/api/dashboard/stats') return json({ totalLeads: 1, newLeads: 1, activeCampaigns: 0, completedCampaigns: 0, totalSpent: 0, totalBudget: 0, messagesSent: 0, conversionRate: '0' });
    if (p === '/api/suggestions') return json({ success: true, suggestions: [], allSuggestions: [] });
    if (p === '/api/settings/leads') return json({ leadSources: ['linkedin', 'google', 'justdial', 'yelp', 'instagram', 'facebook', 'twitter'] });
    if (p === '/api/proposals/42') return json({ id: 42, title: 'Synthetic draft proposal', proposalNumber: 'P-42', status: 'draft', revision: 1, currency: 'INR', subtotal: '0', total: '0', taxRate: '0', discountValue: '0', lineItems: [], createdAt: lead.createdAt, updatedAt: lead.createdAt });
    if (p === '/api/proposals/brand') return json({ companyName: 'Synthetic Company' });
    if (p === '/api/proposals/sources') return json({ contacts: [], conversations: [], tickets: [] });
    if (p === '/api/proposals/onboarding-resources') return json({ teams: [], members: [] });
    if (p === '/api/proposals') return json({ proposals: [], total: 0, totalPages: 1 });
    if (p === '/api/proposals/analytics') return json({ total: 0, draft: 0, sent: 0, viewed: 0, accepted: 0, rejected: 0, expired: 0, delivery_unknown: 0, acceptanceRate: 0 });
    return json([]);
  });
  return state;
}
