import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
  buildApiUrl: vi.fn((path: string) => `https://api.example.test${path}`),
}));

vi.mock('@/lib/api', () => ({
  default: { get: mocks.get, post: mocks.post, put: mocks.put, patch: mocks.patch, delete: mocks.delete, upload: mocks.upload },
  buildApiUrl: mocks.buildApiUrl,
}));

import { aiVisibilityApi } from '@/lib/ai-visibility';
import { getModuleUnavailableMessage, isHiddenDashboardPath, moduleForDashboardPath, moduleForNavigationSection } from '@/lib/platform-access';
import { navSections } from '@/lib/sidebarConfig';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AI Visibility client integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes AI Visibility and Ad Settings in normal workspace navigation', () => {
    const section = navSections.find((item) => item.section === 'ai-visibility');

    expect(section).toBeDefined();
    expect(section?.label).toBe('AI Visibility');
    expect(section?.collapsedPath).toBe('/dashboard/ai-visibility');
    expect(section?.children).toEqual([]);
    expect(navSections.find((item) => item.section === 'settings')?.children.some((item) => item.path === '/dashboard/settings/ads')).toBe(true);
    expect(isHiddenDashboardPath('/dashboard/ai-visibility')).toBe(false);
    expect(isHiddenDashboardPath('/dashboard/ai-visibility/websites/7/reports')).toBe(false);
    expect(isHiddenDashboardPath('/dashboard/settings/ads')).toBe(false);
    expect(isHiddenDashboardPath('/dashboard/home')).toBe(false);
  });

  it('maps the root and every nested AI Visibility page to the feature gate', () => {
    expect(moduleForNavigationSection('ai-visibility')).toBe('ai_visibility');
    expect(moduleForDashboardPath('/dashboard/ai-visibility')).toBe('ai_visibility');
    expect(moduleForDashboardPath('/dashboard/ai-visibility/websites/7/seo')).toBe('ai_visibility');
    expect(moduleForDashboardPath('/dashboard/ai-visibility/websites/7/reports')).toBe('ai_visibility');
    expect(moduleForDashboardPath('/dashboard/unrelated')).toBeNull();
  });

  it('routes the portfolio into website-scoped workspaces and retires unscoped section pages', () => {
    const portfolioPage = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/ai-visibility/page.tsx'), 'utf8');
    const websitePage = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/ai-visibility/websites/[projectId]/page.tsx'), 'utf8');
    const sectionPage = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/ai-visibility/websites/[projectId]/[view]/page.tsx'), 'utf8');
    const legacySeoPage = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/ai-visibility/seo/page.tsx'), 'utf8');

    expect(portfolioPage).toContain('<AiVisibilityPortfolio />');
    expect(websitePage).toContain('<AiVisibilityWorkspace view="overview" projectId={projectId} />');
    expect(sectionPage).toContain("['seo', 'aeo', 'geo', 'commerce', 'competitors', 'fixes', 'assets', 'reports']");
    expect(sectionPage).toContain('projectId={projectId}');
    expect(legacySeoPage).toContain("redirect('/dashboard/ai-visibility')");
  });

  it('keeps direct-link and sidebar ownership aligned for cross-section pages', () => {
    expect(moduleForDashboardPath('/dashboard/outreach-analytics')).toBe('outreach');
    expect(moduleForDashboardPath('/dashboard/settings/ads')).toBe('performance_marketing');
  });

  it('keeps unsupported social routes out of the Next.js route surface', async () => {
    const nextConfig = await import('../../next.config');
    const redirects = await nextConfig.default.redirects?.();

    expect(redirects).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/dashboard/outreach/twitter/:path*', destination: '/dashboard/home' }),
      expect.objectContaining({ source: '/dashboard/outreach/linkedin/:path*', destination: '/dashboard/home' }),
      expect.objectContaining({ source: '/dashboard/integrations/twitter/:path*', destination: '/dashboard/home' }),
      expect.objectContaining({ source: '/dashboard/integrations/linkedin/:path*', destination: '/dashboard/home' }),
    ]));

    expect(redirects?.some((redirect) => redirect.source === '/dashboard/ai-visibility')).toBe(false);
    expect(redirects?.some((redirect) => redirect.source === '/dashboard/settings/ads')).toBe(false);
  });

  it('explains a global module disable instead of blaming the individual account', () => {
    expect(getModuleUnavailableMessage({ status: 'disabled', mode: 'inherit', message: null })).toContain('disabled platform-wide');
    expect(getModuleUnavailableMessage({ status: 'available', mode: 'disabled', message: null })).toContain('not enabled for your account');
  });

  it('uses the authenticated AI Visibility API namespace for project and audit reads', () => {
    aiVisibilityApi.listProjects();
    aiVisibilityApi.listBusinessProfiles();
    aiVisibilityApi.resolveProject(3);
    aiVisibilityApi.getProject(7);
    aiVisibilityApi.overview(7);
    aiVisibilityApi.estimate(7);
    aiVisibilityApi.listAudits(7);
    aiVisibilityApi.getAudit(11);

    expect(mocks.get.mock.calls.map(([path]) => path)).toEqual([
      '/api/ai-visibility/projects',
      '/api/ai-visibility/business-profiles',
      '/api/ai-visibility/projects/7',
      '/api/ai-visibility/projects/7/overview',
      '/api/ai-visibility/projects/7/audits/estimate',
      '/api/ai-visibility/projects/7/audits',
      '/api/ai-visibility/audits/11',
    ]);
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/resolve', { businessProfileId: 3 });
  });

  it('targets the correct SEO, AEO, GEO, commerce and competitor endpoints', () => {
    aiVisibilityApi.seo(7);
    aiVisibilityApi.prompts(7, 'aeo');
    aiVisibilityApi.prompts(7, 'geo');
    aiVisibilityApi.aeoQuestions(7);
    aiVisibilityApi.aeoCoverage(7);
    aiVisibilityApi.commerce(7);
    aiVisibilityApi.competitors(7);
    aiVisibilityApi.competitorIntelligence(7);
    aiVisibilityApi.suggestCompetitors(7);
    aiVisibilityApi.recommendations(7);
    aiVisibilityApi.assets(7);
    aiVisibilityApi.alerts(7);
    aiVisibilityApi.reports(7);
    aiVisibilityApi.reportShares(7);
    aiVisibilityApi.reportDeliveries(7);

    expect(mocks.get.mock.calls.map(([path]) => path)).toEqual([
      '/api/ai-visibility/projects/7/seo',
      '/api/ai-visibility/projects/7/aeo',
      '/api/ai-visibility/projects/7/geo',
      '/api/ai-visibility/projects/7/aeo/questions',
      '/api/ai-visibility/projects/7/aeo/coverage',
      '/api/ai-visibility/projects/7/commerce',
      '/api/ai-visibility/projects/7/competitors',
      '/api/ai-visibility/projects/7/competitor-intelligence',
      '/api/ai-visibility/projects/7/recommendations',
      '/api/ai-visibility/projects/7/assets',
      '/api/ai-visibility/projects/7/alerts',
      '/api/ai-visibility/projects/7/reports',
      '/api/ai-visibility/projects/7/report-shares',
      '/api/ai-visibility/projects/7/report-deliveries',
    ]);
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/7/suggest-competitors', {});
  });

  it('supports reusable arbitrary website searches and onboarding details', () => {
    aiVisibilityApi.listWebsiteSearches();
    aiVisibilityApi.resolveWebsiteSearch({ website: 'https://example.com', name: 'Example', scoringProfile: 'b2b_saas', country: 'US', locale: 'en-US' });
    aiVisibilityApi.archiveProject(7);

    expect(mocks.get).toHaveBeenCalledWith('/api/ai-visibility/website-searches');
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/website-searches', { website: 'https://example.com', name: 'Example', scoringProfile: 'b2b_saas', country: 'US', locale: 'en-US' });
    expect(mocks.delete).toHaveBeenCalledWith('/api/ai-visibility/projects/7');
  });

  it('uses the agency workspace and exact-version approval endpoints without adding another selector', () => {
    aiVisibilityApi.listWorkspaces();
    aiVisibilityApi.createOrganization({ name: 'Orbit Agency', whiteLabelDefaults: { primaryColor: '#123456' } });
    aiVisibilityApi.updateWorkspace(4, { kind: 'client', name: 'Acme' });
    aiVisibilityApi.addWorkspaceMember(4, { email: 'reviewer@example.com', role: 'client_reviewer' });
    aiVisibilityApi.updateWorkspaceMember(4, 9, { status: 'revoked' });
    aiVisibilityApi.assetApprovals(7);
    aiVisibilityApi.decideAsset(7, 19, 3, 'approved');

    expect(mocks.get).toHaveBeenCalledWith('/api/ai-visibility/workspaces');
    expect(mocks.get).toHaveBeenCalledWith('/api/ai-visibility/projects/7/asset-approvals');
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/organizations', { name: 'Orbit Agency', whiteLabelDefaults: { primaryColor: '#123456' } });
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/workspaces/4/members', { email: 'reviewer@example.com', role: 'client_reviewer' });
    expect(mocks.patch).toHaveBeenCalledWith('/api/ai-visibility/workspaces/4', { kind: 'client', name: 'Acme' });
    expect(mocks.patch).toHaveBeenCalledWith('/api/ai-visibility/workspaces/4/members/9', { status: 'revoked' });
    expect(mocks.patch).toHaveBeenCalledWith('/api/ai-visibility/projects/7/assets/19/approval', { assetVersion: 3, decision: 'approved', comment: undefined });
  });

  it('sends state changes to the expected project-owned resources', () => {
    aiVisibilityApi.createAudit(7);
    aiVisibilityApi.cancelAudit(11);
    aiVisibilityApi.retryReport(11);
    aiVisibilityApi.createReportShare(11, 7);
    aiVisibilityApi.sendReportEmail(11, 'client@example.com', '2d94de6e-c82c-46be-ae18-ac05a35f2522');
    aiVisibilityApi.addAeoQuestion(7, { question: 'What is Orbit?', intent: 'informational' });
    aiVisibilityApi.generateAeoAsset(7, 8, 'faq_page');
    aiVisibilityApi.addCompetitor(7, { name: 'Rival', domain: 'rival.test' });
    aiVisibilityApi.updateCompetitor(7, 4, { active: false });
    aiVisibilityApi.generateCompetitorBrief(7, 9, '9:pricing');
    aiVisibilityApi.generateAsset(7, 15);
    aiVisibilityApi.correctPromptRun(21, { brandMentioned: true, brandRank: 2, sentiment: 'positive' });
    aiVisibilityApi.updateRecommendation(7, 15, 'resolved');
    aiVisibilityApi.acknowledgeAlert(7, 3);
    aiVisibilityApi.updateMonitoring(7, true);
    aiVisibilityApi.revokeReportShare(7, 6);

    expect(mocks.post.mock.calls.map(([path]) => path)).toEqual([
      '/api/ai-visibility/projects/7/audits',
      '/api/ai-visibility/audits/11/cancel',
      '/api/ai-visibility/audits/11/report/retry',
      '/api/ai-visibility/audits/11/report-shares',
      '/api/ai-visibility/audits/11/report-deliveries',
      '/api/ai-visibility/projects/7/aeo/questions',
      '/api/ai-visibility/projects/7/aeo/questions/8/assets',
      '/api/ai-visibility/projects/7/competitors',
      '/api/ai-visibility/projects/7/competitor-intelligence/briefs',
      '/api/ai-visibility/projects/7/recommendations/15/assets',
      '/api/ai-visibility/prompt-runs/21/corrections',
    ]);
    expect(mocks.patch).toHaveBeenCalledWith('/api/ai-visibility/projects/7/recommendations/15', { status: 'resolved' });
    expect(mocks.patch).toHaveBeenCalledWith('/api/ai-visibility/projects/7/competitors/4', { active: false });
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/7/competitor-intelligence/briefs', { competitorId: 9, gapKey: '9:pricing' });
    expect(mocks.patch).toHaveBeenCalledWith('/api/ai-visibility/projects/7/alerts/3', {});
    expect(mocks.patch).toHaveBeenCalledWith('/api/ai-visibility/projects/7/monitoring', { enabled: true });
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/7/aeo/questions/8/assets', { assetType: 'faq_page' });
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/audits/11/report-shares', { expiresInDays: 7 });
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/audits/11/report-deliveries', { recipientEmail: 'client@example.com', idempotencyKey: '2d94de6e-c82c-46be-ae18-ac05a35f2522' });
    expect(mocks.delete).toHaveBeenCalledWith('/api/ai-visibility/projects/7/report-shares/6');
  });

  it('uploads the selected commerce file as multipart form data', () => {
    const file = new File(['id,title\n1,Widget'], 'products.csv', { type: 'text/csv' });

    aiVisibilityApi.uploadCommerceFeed(7, file);

    expect(mocks.upload).toHaveBeenCalledTimes(1);
    const [path, form] = mocks.upload.mock.calls[0];
    expect(path).toBe('/api/ai-visibility/projects/7/commerce/feeds');
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get('file')).toBe(file);
  });

  it('syncs an owned Shopify catalog through Commerce', () => {
    aiVisibilityApi.syncShopifyCatalog(7);
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/7/commerce/shopify/sync');
  });

  it('uses owner-scoped CMS connection and draft endpoints', () => {
    const intentKey = '2d94de6e-c82c-46be-ae18-ac05a35f2522';
    aiVisibilityApi.cmsConnections(7);
    aiVisibilityApi.cmsPublishAttempts(7);
    aiVisibilityApi.saveCmsConnection(7, { platform: 'wordpress', siteUrl: 'https://example.com', username: 'editor', applicationPassword: 'secret' });
    aiVisibilityApi.createCmsDraft(7, 19, 'shopify', intentKey, 2);
    aiVisibilityApi.deleteCmsConnection(7, 'wordpress');

    expect(mocks.get).toHaveBeenCalledWith('/api/ai-visibility/projects/7/cms-connections');
    expect(mocks.get).toHaveBeenCalledWith('/api/ai-visibility/projects/7/cms-publish-attempts');
    expect(mocks.put).toHaveBeenCalledWith('/api/ai-visibility/projects/7/cms-connections/wordpress', {
      platform: 'wordpress', siteUrl: 'https://example.com', username: 'editor', applicationPassword: 'secret',
    });
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/7/assets/19/cms-drafts', { platform: 'shopify', idempotencyKey: intentKey, assetVersion: 2 });
    expect(mocks.delete).toHaveBeenCalledWith('/api/ai-visibility/projects/7/cms-connections/wordpress');
  });

  it('uses project-owned Search Console connection, property, sync, and disconnect endpoints', () => {
    aiVisibilityApi.gsc(7);
    aiVisibilityApi.gscAuthUrl(7);
    aiVisibilityApi.selectGscProperty(7, 'sc-domain:example.com');
    aiVisibilityApi.syncGsc(7);
    aiVisibilityApi.disconnectGsc(7);

    expect(mocks.get).toHaveBeenCalledWith('/api/ai-visibility/projects/7/gsc');
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/7/gsc/auth-url');
    expect(mocks.put).toHaveBeenCalledWith('/api/ai-visibility/projects/7/gsc/property', { propertyUri: 'sc-domain:example.com' });
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/7/gsc/sync', {});
    expect(mocks.delete).toHaveBeenCalledWith('/api/ai-visibility/projects/7/gsc');
  });

  it('builds an authenticated report download URL through the shared API helper', () => {
    expect(aiVisibilityApi.reportUrl(11)).toBe('https://api.example.test/api/ai-visibility/audits/11/report');
    expect(aiVisibilityApi.reportCsvUrl(11)).toBe('https://api.example.test/api/ai-visibility/audits/11/export.csv');
    expect(aiVisibilityApi.sharedReportUrl('secret')).toBe('https://api.example.test/api/ai-visibility/shared-reports/secret');
    expect(mocks.buildApiUrl).toHaveBeenCalledWith('/api/ai-visibility/audits/11/report');
  });

  it('preserves explicit measurement selection across evidence endpoints', () => {
    aiVisibilityApi.overview(7, 11);
    aiVisibilityApi.seo(7, 11);
    aiVisibilityApi.prompts(7, 'geo', 11);
    aiVisibilityApi.aeoCoverage(7, 11);
    aiVisibilityApi.competitorIntelligence(7, 11);
    aiVisibilityApi.recommendations(7, 11);
    expect(mocks.get.mock.calls.every(([path]) => path.endsWith('?auditId=11'))).toBe(true);
  });
});
