import type { Page } from '@playwright/test';
import { installAppShellMocks } from './app';
import type { AiVisibilityAudit, AiVisibilityProject } from '../../src/lib/ai-visibility';

export const landmarkProject: AiVisibilityProject = {
  id: 1, workspaceId: 1, name: 'Synthetic website', domain: 'https://fixture.example.test',
  category: 'software', brandAliases: [], scoringProfile: 'general', country: 'IN', locale: 'en-IN',
  targetGeography: null, businessProfileId: null, brandToolkitId: null, source: 'website_search',
  monitoringEnabled: false, monitoringCadence: 'weekly', monitoringEstimatedCredits: '20',
  nextMonitoringAt: null, createdAt: '2026-10-01', updatedAt: '2026-10-01', geoPrompts: [],
  workspace: { workspaceName: 'Synthetic workspace', workspaceKind: 'private', organizationId: null, role: 'owner' },
};
export const landmarkAudit: AiVisibilityAudit = {
  id: 11, projectId: 1, status: 'completed', trigger: 'manual', warningCount: 0, error: null,
  cancellationRequested: false, reservedCredits: '10', actualCredits: '8', summary: {},
  inputSnapshot: { project: landmarkProject }, stages: [],
  createdAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:01:00Z',
};
const overview = {
  project: landmarkProject, measurementAudit: landmarkAudit, latestAudit: landmarkAudit,
  latestScore: null, openRecommendations: 0, configurationChanged: false, scoreHistory: [],
};
const report = {
  periodDays: 30, outcomes: [{ channel: 'web', outcome: 'answered', count: 2, avg_confidence: .9, avg_duration_ms: 500 }],
  delivery: [{ status: 'sent', count: 2 }], handoffs: [], playbooks: [],
  privacy: { retained_records: 0, expiring_within_7_days: 0, configured: true }, tools: [],
  privacyAccess: [], privacyAccessHistory: [], knowledgeGaps: [], guardrails: [], adminAudit: [],
  csat: { responses: 0, average_rating: null, rating_1: 0, rating_2: 0, rating_3: 0, rating_4: 0, rating_5: 0 },
  readiness: { llm: true, whatsapp: false, instagram: false, facebook: false, email: false,
    privacyVault: true, moderationEnabled: true, moderationConfigured: true, moderationFailClosed: true },
};

export async function installLandmarkFixtures(page: Page) {
  let heldResponses: Array<() => void> = [];
  const state = { populatedProposals: false, websiteFails: false, pending: 0, hold: false,
    requests: [] as string[], forbiddenActions: [] as string[],
    pause: () => { state.hold = true; },
    resume: () => {
      state.hold = false;
      const responses = heldResponses;
      heldResponses = [];
      responses.forEach(resolve => resolve());
    },
  };
  // Every API request terminates here or in the synthetic shell fixture. No backend is needed.
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const key = `${request.method()} ${pathname}`;
    state.requests.push(key);
    const shell = ['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/business-profiles',
      '/api/organizations', '/api/wallet', '/api/crm/configuration', '/api/chat/threads', '/api/notifications/unread/count'];
    if (shell.includes(pathname)) return route.fallback();
    // These two POSTs are initiated by existing read-screen queries. Return static fixtures,
    // never run project provisioning or competitor discovery against any API/provider.
    const localQueryPost = pathname === '/api/ai-visibility/projects/resolve' || pathname.endsWith('/suggest-competitors');
    if (!['GET', 'HEAD'].includes(request.method()) && !localQueryPost) {
      state.forbiddenActions.push(key);
      return route.fulfill({ status: 409, json: { error: 'Action blocked by the AS015 local fixture.' } });
    }
    const data: Record<string, unknown> = {
      '/api/proposals': { proposals: state.populatedProposals ? [{ id: 42, proposalNumber: 'SYN-42', title: 'Synthetic offer',
        recipientName: 'Fixture recipient', recipientEmail: 'fixture@example.test', status: 'draft', currency: 'INR', total: '500',
        validUntil: null, sentAt: null, createdAt: landmarkAudit.createdAt, updatedAt: landmarkAudit.createdAt,
        lastActivityAt: landmarkAudit.createdAt, owner: { id: 7, name: 'Fixture owner' } }] : [], total: state.populatedProposals ? 1 : 0, totalPages: 1 },
      '/api/proposals/analytics': { total: 0, draft: 0, sent: 0, viewed: 0, accepted: 0, rejected: 0, expired: 0, delivery_unknown: 0, acceptanceRate: 0 },
      '/api/support/ai/orchestration-report': report,
      '/api/instagram/oauth/status': { officialApi: { connected: false } },
      '/api/ai-visibility/projects': { projects: [landmarkProject] },
      '/api/ai-visibility/projects/resolve': { project: null, profile: null, toolkit: null, provisioned: false, missingWebsite: false },
      '/api/ai-visibility/website-searches': { websites: [{ project: landmarkProject, auditCount: 1, latestAudit: landmarkAudit, latestScore: null }] },
      '/api/ai-visibility/projects/1': { project: landmarkProject },
      '/api/ai-visibility/projects/1/overview': overview,
      '/api/ai-visibility/projects/1/alerts': { alerts: [] },
      '/api/ai-visibility/projects/1/audits': { audits: [landmarkAudit] },
      '/api/ai-visibility/audits/11': { audit: landmarkAudit },
      '/api/ai-visibility/projects/1/audits/estimate': { estimate: { estimatedMaximum: 20, walletBalance: 100, lineItems: [], assumptions: { providers: 0, providerRequests: 0 } } },
      '/api/ai-visibility/projects/1/providers': { providers: [] },
      '/api/ai-visibility/projects/1/seo': { audit: landmarkAudit, issues: [], pages: [{ id: 1, url: landmarkProject.domain, finalUrl: landmarkProject.domain, crawlStatus: 'completed', statusCode: 200, title: 'Synthetic home', metaDescription: 'Fixture description', canonicalUrl: landmarkProject.domain, indexable: true, wordCount: 100, imageCount: 0, imagesMissingAlt: 0, headings: { h1: ['Synthetic home'] }, schemaTypes: [], error: null }] },
      '/api/ai-visibility/projects/1/gsc': { connected: false, available: false, unavailableReason: 'Fixture: not connected', connection: null, snapshot: null, summary: null, opportunities: [] },
      '/api/ai-visibility/projects/1/aeo': { audit: landmarkAudit, prompts: [], runs: [] },
      '/api/ai-visibility/projects/1/geo': { audit: landmarkAudit, prompts: [], runs: [] },
      '/api/ai-visibility/projects/1/aeo/questions': { questions: [] },
      '/api/ai-visibility/projects/1/aeo/coverage': { audit: landmarkAudit, available: true, unavailableReason: null, summary: { total: 0, answered: 0, partial: 0, uncovered: 0 }, coverage: [] },
      '/api/ai-visibility/projects/1/commerce': { snapshots: [], latestSnapshot: null },
      '/api/ai-visibility/projects/1/cms-connections': { connections: [] },
      '/api/ai-visibility/projects/1/competitors': { competitors: [] },
      '/api/ai-visibility/projects/1/suggest-competitors': { suggestions: [] },
      '/api/ai-visibility/projects/1/competitor-intelligence': { overview: null, competitors: [] },
      '/api/ai-visibility/projects/1/recommendations': { recommendations: [] },
      '/api/ai-visibility/projects/1/assignees': { members: [] },
      '/api/ai-visibility/projects/1/assets': { assets: [] },
      '/api/ai-visibility/projects/1/reports': { reports: [] },
      '/api/ai-visibility/projects/1/report-shares': { shares: [] },
      '/api/ai-visibility/projects/1/report-deliveries': { deliveries: [] },
      '/api/ai-visibility/workspaces': { workspaces: [] },
      '/api/settings/outreach/assistants/catalog': { runtimeEnabled: false, permissions: { canManage: false }, accounts: [], templates: [], playbooks: [], knowledgeBases: [], members: [] },
      '/api/settings/outreach/assistants/diagnostics': { metrics: [], assignments: [], knowledgeGaps: [], usage: [] },
      '/api/settings/outreach/assistants': { assistants: [], nextCursor: null },
    };
    let body = data[pathname] ?? [];
    if (/^\/api\/integrations\/(instagram|facebook|whatsapp|msg91)\/webhook-events$/.test(pathname)) {
      body = { events: [{ id: 1, event_type: 'message', processed: true, signature_valid: true,
        message_text: 'Synthetic incoming message', created_at: landmarkAudit.createdAt }] };
    }
    state.pending++;
    if (state.hold) await new Promise<void>(resolve => heldResponses.push(resolve));
    // Deliberate async responses cover loading-to-content rather than only cached content.
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      await route.fulfill({ status: state.websiteFails && pathname === '/api/ai-visibility/projects/1' ? 404 : 200, json: body });
    } finally {
      state.pending--;
    }
  });
  return state;
}
