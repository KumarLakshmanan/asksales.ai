import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  AiVisibilityAudit,
  AiVisibilityProject,
  ProviderPromptRun,
  VisibilityOverview,
} from '@/lib/ai-visibility';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  search: '',
  toast: vi.fn(),
  api: Object.fromEntries(
    [
      'getProject',
      'overview',
      'listAudits',
      'estimate',
      'providers',
      'listProjects',
      'listWebsiteSearches',
      'resolveProject',
      'seo',
      'recommendations',
      'alerts',
      'aeoQuestions',
      'aeoCoverage',
      'prompts',
      'assets',
      'cmsConnections',
      'assetApprovals',
      'cmsPublishAttempts',
      'assetVersions',
      'reports',
      'reportShares',
      'reportDeliveries',
      'gsc',
      'competitors',
      'addCompetitor',
      'suggestCompetitors',
      'lookupCompetitorWebsite',
      'competitorIntelligence',
      'assignees',
      'updateRecommendation',
      'addAeoQuestion',
      'updateAeoQuestion',
      'generateAeoAsset',
      'createAudit',
      'editAsset',
      'decideAsset',
      'updateMonitoring',
      'updateProject',
      'correctPromptRun',
      'createCmsDraft',
      'gscAuthUrl',
      'syncGsc',
      'selectGscProperty',
      'disconnectGsc',
      'listWorkspaces',
      'commerce',
      'commerceProducts',
      'uploadCommerceFeed',
      'syncShopifyCatalog',
      'syncWooCommerceCatalog',
      'retryReport',
      'reportUrl',
    ].map((key) => [key, vi.fn()]),
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock('@/lib/ai-visibility', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  aiVisibilityApi: mocks.api,
}));

import { AiVisibilityWorkspace } from '@/components/ai-visibility/AiVisibilityWorkspace';
import { SeoView } from '@/components/ai-visibility/SeoView';
import { AeoView } from '@/components/ai-visibility/AeoView';
import { CommerceView } from '@/components/ai-visibility/CommerceView';
import { CompetitorView } from '@/components/ai-visibility/CompetitorView';
import { GscCard } from '@/components/ai-visibility/GscCard';
import { PromptRunObservation } from '@/components/ai-visibility/PromptRunObservation';
import { GeoView } from '@/components/ai-visibility/GeoView';
import { FixesView } from '@/components/ai-visibility/FixesView';
import { AssetsView } from '@/components/ai-visibility/AssetsView';
import { ReportLibrary } from '@/components/ai-visibility/ReportLibrary';
import { SafeMarkdown } from '@/components/ai-visibility/SafeMarkdown';
import {
  MeasurementContext,
  capabilities,
  refreshVisibility,
} from '@/components/ai-visibility/workspace-context';
import { MeasurementBar } from '@/components/ai-visibility/WorkspaceSettings';
import { AiVisibilityPortfolio } from '@/components/ai-visibility/Portfolio';
import { VIEW_COPY, type AiVisibilityView } from '@/components/ai-visibility/workspace-ui';

const project: AiVisibilityProject = {
  id: 7,
  workspaceId: 1,
  name: 'Example brand',
  domain: 'https://example.com',
  category: 'software',
  brandAliases: [],
  scoringProfile: 'general',
  country: 'IN',
  locale: 'en-IN',
  targetGeography: 'Chennai',
  businessProfileId: null,
  brandToolkitId: null,
  source: 'website_search',
  monitoringEnabled: false,
  monitoringCadence: 'weekly',
  monitoringEstimatedCredits: '20',
  nextMonitoringAt: null,
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01',
  configurationRevision: 2,
  geoPrompts: [],
  workspace: {
    workspaceName: 'Example',
    workspaceKind: 'private',
    organizationId: null,
    role: 'owner',
  },
};
const audit: AiVisibilityAudit = {
  id: 11,
  projectId: 7,
  status: 'completed',
  trigger: 'manual',
  warningCount: 0,
  error: null,
  cancellationRequested: false,
  reservedCredits: '10',
  actualCredits: '8',
  summary: {},
  inputSnapshot: { project },
  createdAt: '2026-09-01T00:00:00Z',
  completedAt: '2026-09-01T00:01:00Z',
};
const overview: VisibilityOverview = {
  project,
  measurementAudit: audit,
  latestAudit: audit,
  latestScore: null,
  openRecommendations: 1,
  coverage: {
    attemptedProviders: 2,
    successfulProviders: 1,
    expectedObservations: 8,
    successfulObservations: 4,
    extractedObservations: 3,
    citations: 4,
    partial: true,
    checkedPages: 5,
    completedPages: 4,
    pageLimit: 25,
  },
  configurationChanged: false,
  scoreHistory: [],
};
const issue = (id: number, severity = 'high') => ({
  id,
  ruleId: severity === 'info' ? 'links.unverified' : 'metadata.missing_title',
  ruleVersion: 3,
  group: 'on_page',
  severity,
  affectedUrl: `https://example.com/${id}`,
  evidence: { title: '', statusCode: 200 },
  recommendation: `Add a unique title ${id}`,
});
const question = {
  id: 3,
  question: 'How can I book a consultation?',
  intent: 'transactional',
  targetPage: null,
  active: true,
};
const recommendation = {
  id: 5,
  auditId: 11,
  module: 'seo',
  title: 'Add descriptive page title',
  description: 'Write a title that identifies this page.',
  severity: 'high',
  impact: 'high',
  effort: 'low',
  affectedUrl: 'https://example.com/1',
  evidence: { ruleId: 'metadata.missing_title' },
  confidence: '1',
  status: 'open',
  assetType: 'metadata',
  generatedDraft: null,
  verificationStatus: 'unverified',
};
const clients: QueryClient[] = [];
function wrap(
  children: ReactNode,
  role: string = 'owner',
  historical = false,
  overviewValue: VisibilityOverview = overview,
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MeasurementContext.Provider
          value={{
            project,
            auditId: 11,
            overview: overviewValue,
            historical,
            can: capabilities(role),
          }}
        >
          {children}
        </MeasurementContext.Provider>
      </QueryClientProvider>,
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = '';
  localStorage.clear();
  const defaults: Record<string, unknown> = {
    getProject: { project },
    overview,
    listAudits: { audits: [audit] },
    listProjects: { projects: [project] },
    estimate: {
      estimate: {
        estimatedMaximum: 20,
        walletBalance: 100,
        lineItems: [],
        assumptions: { providers: 2, providerRequests: 8 },
      },
    },
    providers: { providers: [] },
    seo: { audit, issues: [issue(1), issue(2, 'info')], pages: [] },
    listWebsiteSearches: { websites: [] },
    resolveProject: {
      project: null,
      profile: null,
      toolkit: null,
      provisioned: false,
      missingWebsite: false,
    },
    recommendations: { recommendations: [recommendation] },
    alerts: { alerts: [] },
    aeoQuestions: { questions: [question] },
    aeoCoverage: {
      audit,
      available: true,
      unavailableReason: null,
      summary: { total: 1, answered: 0, partial: 0, uncovered: 1 },
      coverage: [
        {
          ...question,
          questionId: 3,
          status: 'uncovered',
          bestMatch: null,
          matches: [],
        },
      ],
    },
    prompts: { audit, prompts: [], runs: [] },
    assets: { assets: [] },
    cmsConnections: { connections: [] },
    assetApprovals: { decisions: [] },
    cmsPublishAttempts: { attempts: [] },
    assetVersions: { versions: [] },
    reports: { reports: [] },
    reportShares: { shares: [] },
    reportDeliveries: { deliveries: [] },
    assignees: { members: [] },
    listWorkspaces: { workspaces: [] },
    suggestCompetitors: { suggestions: [] },
    commerce: { snapshots: [], latestSnapshot: null },
    competitors: { competitors: [] },
    competitorIntelligence: { overview: null, competitors: [] },
    gsc: {
      connected: false,
      available: false,
      unavailableReason: 'Not connected',
      connection: null,
      snapshot: null,
      summary: null,
      opportunities: [],
    },
    updateRecommendation: {},
    addAeoQuestion: {},
    updateAeoQuestion: {},
    generateAeoAsset: { asset: { id: 22 } },
    editAsset: {},
    decideAsset: {},
  };
  for (const [key, mock] of Object.entries(mocks.api))
    mock.mockReset().mockResolvedValue(defaults[key] || {});
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
});

describe('AI Visibility rendered workbench interactions', () => {
  it('AS015: keeps the named portfolio section inside the single dashboard main', async () => {
    wrap(<main id="main-content"><AiVisibilityPortfolio /></main>);
    await screen.findByText('Example brand');
    const heading = screen.getByRole('heading', { level: 1, name: 'AI Visibility websites' });
    const section = screen.getByRole('region', { name: 'AI Visibility websites' });
    expect(section).toHaveAttribute('aria-labelledby', heading.id);
    expect(section.tagName).toBe('SECTION');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(document.querySelector('main main, main [role="main"]')).toBeNull();
  });

  it.each(Object.keys(VIEW_COPY) as AiVisibilityView[])('AS015: %s retains its heading association without nesting a main', async (view) => {
    wrap(<main id="main-content"><AiVisibilityWorkspace projectId={7} view={view} /></main>);
    const heading = await screen.findByRole('heading', { level: 1, name: VIEW_COPY[view].title });
    const section = screen.getByRole('region', { name: VIEW_COPY[view].title });
    expect(heading).toHaveAttribute('id', 'ai-visibility-title');
    expect(section).toHaveAttribute('aria-labelledby', heading.id);
    expect(section.tagName).toBe('SECTION');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(document.querySelector('main main, main [role="main"]')).toBeNull();
  });

  it('AS015: a failed website load also stays inside the dashboard main', async () => {
    mocks.api.getProject.mockRejectedValue(new Error('Synthetic unavailable website'));
    wrap(<main id="main-content"><AiVisibilityWorkspace projectId={7} view="overview" /></main>);
    await screen.findByText('This website workspace could not be loaded. It may not exist or you may not have access.');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(document.querySelector('main main, main [role="main"]')).toBeNull();
  });

  it('keeps the accessible website portfolio visible when status summaries fail and identifies the failed source', async () => {
    mocks.api.listWebsiteSearches.mockRejectedValue(new Error('Request failed with status 503'));
    wrap(<AiVisibilityPortfolio />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Website status summaries');
    expect(screen.getByRole('alert')).toHaveTextContent('503');
    expect(screen.getByText('Example brand')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('shows endpoint-specific failures and retries all portfolio sources when none load', async () => {
    mocks.api.listProjects.mockRejectedValue(new Error('projects unavailable'));
    mocks.api.listWebsiteSearches.mockRejectedValue(new Error('summaries unavailable'));
    mocks.api.resolveProject.mockRejectedValue(new Error('profile match unavailable'));
    wrap(<AiVisibilityPortfolio />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Accessible website list: projects unavailable');
    expect(alert).toHaveTextContent('Website status summaries: summaries unavailable');
    expect(alert).toHaveTextContent('Business Profile website match: profile match unavailable');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(mocks.api.listProjects).toHaveBeenCalledTimes(2);
      expect(mocks.api.listWebsiteSearches).toHaveBeenCalledTimes(2);
      expect(mocks.api.resolveProject).toHaveBeenCalledTimes(2);
    });
  });

  it('filters informational SEO findings and opens captured evidence', async () => {
    wrap(<SeoView projectId={7} />);
    await screen.findByText('Findings (2)');
    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'info');
    expect(screen.getByText(/1 groups · 1 findings/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Links could not be verified'));
    await userEvent.click(screen.getByRole('button', { name: /example\.com\/2.*Evidence/ }));
    expect(screen.getByRole('complementary', { name: 'Finding evidence' })).toHaveTextContent(
      '200',
    );
    expect(screen.getByRole('link', { name: 'https://example.com/2' })).toHaveAttribute(
      'href',
      'https://example.com/2',
    );
  });
  it('changes the evidence panel to the clicked page and lists the images without alt text', async () => {
    const altIssue = (id: number, page: string, elements: Array<{ index: number; source: string }>) => ({
      id,
      ruleId: 'images.missing_alt',
      ruleVersion: 4,
      group: 'on_page',
      severity: 'low',
      affectedUrl: `https://example.com/${page}`,
      evidence: { imageCount: 3, missingAlt: elements.length, elements, evidenceComplete: elements.length > 0 },
      recommendation: 'Add accurate alternative text to meaningful images.',
    });
    mocks.api.seo.mockResolvedValue({
      audit,
      issues: [
        altIssue(70, 'about', [{ index: 2, source: '/team.png' }]),
        altIssue(71, 'pricing', []),
      ],
      pages: [],
    });
    wrap(<SeoView projectId={7} />);
    await userEvent.click(await screen.findByText('Images missing alt text', { selector: 'summary span' }));
    expect(screen.getAllByText('Add accurate alternative text to meaningful images.')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /example\.com\/about.*Evidence/ }));
    const panel = screen.getByRole('complementary', { name: 'Finding evidence' });
    expect(panel).toHaveTextContent('1 of 3 images have no alt text.');
    expect(within(panel).getByRole('link', { name: '/team.png' })).toHaveAttribute('href', 'https://example.com/team.png');
    expect(screen.getByRole('button', { name: /example\.com\/about.*Viewing/ })).toHaveAttribute('aria-current', 'true');

    await userEvent.click(screen.getByRole('button', { name: /example\.com\/pricing.*Evidence/ }));
    expect(within(panel).getByRole('link', { name: 'https://example.com/pricing' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('The list of images is recorded from the next analysis.');
    expect(panel).not.toHaveTextContent('/team.png');
  });
  it('says how many older robots findings were withdrawn and labels severities consistently', async () => {
    mocks.api.seo.mockResolvedValue({ audit, issues: [issue(1)], pages: [], withdrawnFindings: 25 });
    wrap(<SeoView projectId={7} />);
    expect(
      await screen.findByText(/25 “Page blocked by robots.txt” findings were removed: an older check misread robots.txt/),
    ).toBeInTheDocument();
    const severity = screen.getByRole('combobox', { name: /severity/i });
    expect(within(severity).getAllByRole('option').map((option) => option.textContent)).toEqual(
      expect.arrayContaining(['Critical', 'High', 'Medium', 'Low', 'Info']),
    );
  });
  it('preserves completed SEO details while another audit is running', async () => {
    mocks.api.listAudits.mockResolvedValue({
      audits: [{ ...audit, id: 12, status: 'running' }, audit],
    });
    mocks.api.overview.mockResolvedValue({
      ...overview,
      latestAudit: { ...audit, id: 12, status: 'running' },
    });
    wrap(<AiVisibilityWorkspace projectId={7} view="seo" />);
    await screen.findByText('Findings (2)');
    expect(mocks.api.seo).toHaveBeenCalledWith(7, 11);
    expect(screen.getByText(/New analysis #12 is running/)).toBeInTheDocument();
    expect(screen.queryByText(/No SEO issues/)).not.toBeInTheDocument();
  });
  it('refreshes mounted findings when a running audit reaches completion', async () => {
    const running = { ...audit, id: 12, status: 'running' };
    mocks.api.listAudits.mockResolvedValue({ audits: [running, audit] });
    mocks.api.overview.mockResolvedValue({ ...overview, latestAudit: running });
    const { client } = wrap(<AiVisibilityWorkspace projectId={7} view="seo" />);
    await screen.findByText('Findings (2)');
    const completed = { ...audit, id: 12 };
    mocks.api.overview.mockResolvedValue({
      ...overview,
      latestAudit: completed,
      measurementAudit: completed,
    });
    mocks.api.seo.mockResolvedValue({
      audit: completed,
      issues: [issue(88, 'critical')],
      pages: [],
    });
    client.setQueryData(['ai-visibility-audits', 7], {
      audits: [completed, audit],
    });
    await screen.findByText('Findings (1)');
    expect(mocks.api.seo).toHaveBeenCalledWith(7, 12);
    expect(screen.queryByText(/New analysis #12 is running/)).not.toBeInTheDocument();
  });
  it('charts SEO health and filters findings from the charts with rule-level robots evidence', async () => {
    const robotsIssue = {
      id: 40,
      ruleId: 'robots.disallowed_page',
      ruleVersion: 4,
      group: 'indexability',
      severity: 'high',
      affectedUrl: 'https://example.com/private',
      evidence: {
        evaluatedAs: 'Googlebot',
        matchedRule: 'Disallow: /private',
        robotsTxtLine: 2,
        userAgentGroup: '*',
        testedPath: '/private',
      },
      recommendation: 'Align robots.txt for this URL.',
    };
    const titleIssue = {
      ...issue(41, 'low'),
      ruleId: 'metadata.title_length',
      evidence: { length: 16, title: 'AskSales | Home', problem: 'too_short', recommendedRange: '20–65 characters' },
      recommendation: 'Expand the title.',
    };
    mocks.api.seo.mockResolvedValue({
      audit,
      issues: [issue(1), robotsIssue, titleIssue],
      pages: [
        { id: 1, url: 'https://example.com/', crawlStatus: 'completed', title: 'AskSales | Home', metaDescription: null, headings: { h1: [] }, wordCount: 320, schemaTypes: [] },
        { id: 2, url: 'https://example.com/private', crawlStatus: 'completed', headings: { h1: ['Private'] }, wordCount: 10, schemaTypes: [] },
      ],
      site: {
        score: 72,
        subScores: { technical: 90, on_page: 60, content: 80, internal_linking: 100, schema: 50, indexability: 70 },
        robots: { available: true, error: null, groups: 2, rules: 3 },
        sitemap: { available: true, urlCount: 140, complete: false, declaredInRobots: false, sources: [] },
        discoveredPages: 160,
        pageLimit: 25,
        checkedLinks: 48,
        crawlerAccess: [
          { crawler: 'Googlebot', owner: 'Google', purpose: 'search', allowed: true, group: ['*'] },
          { crawler: 'PerplexityBot', owner: 'Perplexity', purpose: 'ai_search', allowed: false, rule: 'Disallow: /', line: 5, group: ['perplexitybot'] },
        ],
        crawlerAccessUrl: 'https://example.com/',
      },
    });
    wrap(<SeoView projectId={7} />);
    expect(await screen.findByRole('img', { name: 'SEO score 72 out of 100' })).toBeInTheDocument();
    expect(screen.getByText('Needs work')).toBeInTheDocument();
    expect(screen.getByText('PerplexityBot').closest('span[tabindex]')).toHaveTextContent('Blocked');
    expect(screen.getByText('Partial')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Indexability/ }));
    expect(screen.getByText(/1 groups · 1 findings/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filter Area: Indexability' }));
    expect(screen.getByText(/3 groups · 3 findings/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Page blocked by robots.txt/ }));
    await userEvent.click(screen.getByText('Page blocked by robots.txt', { selector: 'summary span' }));
    // The advice is said once for the rule; each row is the affected page.
    expect(screen.getAllByText('Align robots.txt for this URL.')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /example\.com\/private.*Evidence/ }));
    const evidence = screen.getByRole('complementary', { name: 'Finding evidence' });
    expect(evidence).toHaveTextContent('Disallow: /private');
    expect(evidence).toHaveTextContent('← line 2');

    await userEvent.click(screen.getByRole('button', { name: /Clear filter Issue/ }));
    await userEvent.click(screen.getByText('Page title length', { selector: 'summary span' }));
    await userEvent.click(screen.getByRole('button', { name: /example\.com\/41.*Evidence/ }));
    expect(screen.getByRole('complementary', { name: 'Finding evidence' })).toHaveTextContent(
      '16 characters · recommended 20–65 characters',
    );
  });
  it('warns when SEO findings come from older checks and links to a new analysis', async () => {
    mocks.api.seo.mockResolvedValue({
      audit,
      issues: [issue(1)],
      pages: [{ id: 1, url: 'https://example.com/', crawlStatus: 'completed', headings: { h1: ['Home'] }, wordCount: 300, schemaTypes: [] }],
      site: {
        score: 79,
        subScores: null,
        robots: { available: true, error: null, groups: null, rules: null },
        sitemap: { available: true, urlCount: 8, complete: null, declaredInRobots: null, sources: [] },
        discoveredPages: null,
        pageLimit: null,
        checkedLinks: 79,
        crawlerAccess: null,
        crawlerAccessUrl: 'https://example.com/',
        ruleVersion: 2,
        currentRuleVersion: 4,
        rulesOutdated: true,
      },
    });
    wrap(<SeoView projectId={7} />);
    expect(await screen.findByText('Measured with older SEO checks')).toBeInTheDocument();
    expect(screen.getByText(/Some findings may no longer apply/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analyze again' })).toHaveAttribute(
      'href',
      '/dashboard/ai-visibility/websites/7',
    );
  });
  it('flags SEO fixes from older checks on the fixes page only when they are older', async () => {
    mocks.api.recommendations.mockResolvedValue({ recommendations: [recommendation] });
    const older = { ...overview, measurementSeoRuleVersion: 2, currentSeoRuleVersion: 4 };
    const { unmount } = wrap(<FixesView projectId={7} />, 'owner', false, older);
    expect(await screen.findByText('Measured with older SEO checks')).toBeInTheDocument();
    expect(screen.getByText(/Some SEO fixes may no longer be needed/)).toBeInTheDocument();
    unmount();

    wrap(<FixesView projectId={7} />, 'owner', false, { ...older, measurementSeoRuleVersion: 4 });
    await screen.findByRole('button', { name: /Missing page title/ });
    expect(screen.queryByText('Measured with older SEO checks')).not.toBeInTheDocument();
  });
  it('does not present a score change caused by updated SEO checks', async () => {
    const snapshot = (auditId: number, overallScore: string) => ({
      auditId,
      scoringVersion: 2,
      overallScore,
      seoScore: '80',
      aeoScore: '50',
      geoScore: '60',
      commerceScore: null,
      pillarStatuses: { seo: 'scored', aeo: 'scored', geo: 'scored' } as const,
      metrics: {},
      subScores: {},
      inputFingerprint: `f${auditId}`,
    });
    const older = { ...audit, id: 9, createdAt: '2026-08-01T00:00:00Z' };
    mocks.api.listAudits.mockResolvedValue({ audits: [audit, older] });
    mocks.api.overview.mockResolvedValue({
      ...overview,
      latestScore: snapshot(11, '80'),
      measurementSeoRuleVersion: 4,
      currentSeoRuleVersion: 4,
      scoreHistory: [
        { audit, score: snapshot(11, '80'), seoRuleVersion: 4 },
        { audit: older, score: snapshot(9, '62'), seoRuleVersion: 2 },
      ],
    });
    wrap(<AiVisibilityWorkspace projectId={7} view="overview" />);
    expect(
      await screen.findByText('Not compared: SEO checks changed since the last measurement.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/since last comparable measurement/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Older SEO checks')).toHaveLength(1);
  });
  it('shows the score change when both measurements used the same SEO checks', async () => {
    const snapshot = (auditId: number, overallScore: string) => ({
      auditId,
      scoringVersion: 2,
      overallScore,
      seoScore: '80',
      aeoScore: '50',
      geoScore: '60',
      commerceScore: null,
      pillarStatuses: { seo: 'scored', aeo: 'scored', geo: 'scored' } as const,
      metrics: {},
      subScores: {},
      inputFingerprint: `f${auditId}`,
    });
    const older = { ...audit, id: 9, createdAt: '2026-08-01T00:00:00Z' };
    mocks.api.listAudits.mockResolvedValue({ audits: [audit, older] });
    mocks.api.overview.mockResolvedValue({
      ...overview,
      latestScore: snapshot(11, '80'),
      measurementSeoRuleVersion: 4,
      currentSeoRuleVersion: 4,
      scoreHistory: [
        { audit, score: snapshot(11, '80'), seoRuleVersion: 4 },
        { audit: older, score: snapshot(9, '62'), seoRuleVersion: 4 },
      ],
    });
    wrap(<AiVisibilityWorkspace projectId={7} view="overview" />);
    expect(await screen.findByText(/since last comparable measurement/)).toHaveTextContent(
      '+18 since last comparable measurement',
    );
    expect(screen.queryByText(/Not compared/)).not.toBeInTheDocument();
    expect(screen.queryByText('Older SEO checks')).not.toBeInTheDocument();
  });
  it('does not claim crawler access for measurements recorded before robots rules were stored', async () => {
    mocks.api.seo.mockResolvedValue({
      audit,
      issues: [],
      pages: [{ id: 1, url: 'https://example.com/', crawlStatus: 'completed', headings: { h1: ['Home'] }, wordCount: 300, schemaTypes: [] }],
      site: {
        score: 79,
        subScores: null,
        robots: { available: true, error: null, groups: null, rules: null },
        sitemap: { available: true, urlCount: 8, complete: null, declaredInRobots: null, sources: [] },
        discoveredPages: null,
        pageLimit: null,
        checkedLinks: 79,
        crawlerAccess: null,
        crawlerAccessUrl: 'https://example.com/',
      },
    });
    wrap(<SeoView projectId={7} />);
    expect(
      await screen.findByText('Robots rules and crawler access are recorded from the next analysis.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Crawler access')).not.toBeInTheDocument();
    expect(screen.queryByText('Not recorded')).not.toBeInTheDocument();
    expect(screen.queryByText('Allowed')).not.toBeInTheDocument();
    expect(screen.queryByText(/groups · \d+ rules/)).not.toBeInTheDocument();
  });
  it('shows every unavailable page including blocked pages beyond the first 20', async () => {
    mocks.api.seo.mockResolvedValue({
      audit,
      issues: [],
      pages: Array.from({ length: 25 }, (_, i) => ({
        id: i + 1,
        url: `https://example.com/page-${i + 1}`,
        crawlStatus: i % 2 ? 'blocked' : 'failed',
        error: 'Unavailable',
      })),
    });
    wrap(<SeoView projectId={7} />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: /25 pages not crawled/,
      }),
    );
    expect(screen.getByText(/of 25 pages/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByRole('link', {
        name: 'https://example.com/page-25',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('21–25 of 25 pages')).toBeInTheDocument();
  });
  it('shows retry on a question-query error without claiming the list is empty', async () => {
    mocks.api.aeoQuestions.mockRejectedValue(new Error('Network unavailable'));
    wrap(<AeoView projectId={7} />);
    await screen.findByText('Tracked questions could not be loaded.');
    expect(screen.queryByText(/No questions tracked yet/)).not.toBeInTheDocument();
    mocks.api.aeoQuestions.mockResolvedValue({ questions: [question] });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: question.question })).toBeInTheDocument();
  });
  it('tracks a generated idea with editable intent and target page', async () => {
    mocks.api.prompts.mockResolvedValue({
      audit,
      prompts: [
        {
          id: 9,
          prompt: 'What services does Example provide?',
          intent: 'informational',
          locale: 'en-IN',
          isGeneric: false,
        },
      ],
      runs: [],
    });
    wrap(<AeoView projectId={7} />);
    await screen.findByRole('button', { name: question.question });
    await userEvent.click(screen.getByText('Generated question ideas'));
    await userEvent.click(await screen.findByRole('button', { name: 'Track question' }));
    fireEvent.change(screen.getByLabelText('Intent'), {
      target: { value: 'comparison' },
    });
    fireEvent.change(screen.getByLabelText('Target page (optional)'), {
      target: { value: 'https://example.com/services' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));
    await waitFor(() =>
      expect(mocks.api.addAeoQuestion).toHaveBeenCalledWith(7, {
        question: 'What services does Example provide?',
        intent: 'comparison',
        targetPage: 'https://example.com/services',
      }),
    );
  });
  it('creates an honest research brief for an uncovered question', async () => {
    wrap(<AeoView projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: question.question }));
    await userEvent.click(screen.getByRole('button', { name: 'Create research brief' }));
    await waitFor(() =>
      expect(mocks.api.generateAeoAsset).toHaveBeenCalledWith(7, 3, 'research_brief'),
    );
    expect(screen.queryByRole('button', { name: 'Draft answer block' })).not.toBeInTheDocument();
  });
  it.each(['owner', 'agency_admin', 'editor', 'client_reviewer'])(
    'aligns analysis and editing capabilities for %s',
    async (role) => {
      mocks.api.getProject.mockResolvedValue({
        project: { ...project, workspace: { ...project.workspace, role } },
      });
      wrap(<AiVisibilityWorkspace projectId={7} view="overview" />, role);
      const analyze = await screen.findByRole('button', {
        name: 'Analyze again',
      });
      expect(analyze).toHaveProperty('disabled', role !== 'owner');
      const settings = screen.getByText('Settings and monitoring');
      await userEvent.click(settings);
      if (role === 'client_reviewer')
        expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
      else expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Enable monitoring' })).toHaveProperty(
        'disabled',
        role !== 'owner',
      );
    },
  );
  it('hides reviewer question mutations while keeping evidence readable', async () => {
    wrap(<AeoView projectId={7} />, 'client_reviewer');
    await userEvent.click(await screen.findByRole('button', { name: question.question }));
    expect(screen.queryByRole('button', { name: 'Add question' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create research brief' })).not.toBeInTheDocument();
    expect(screen.getByText('No verified answer was found in this crawl.')).toBeInTheDocument();
  });
  it('discloses persisted configuration and correction revisions across navigation', async () => {
    wrap(
      <MeasurementBar
        project={project}
        data={{
          ...overview,
          configurationChanged: true,
          measurementAudit: {
            ...audit,
            correctionRevision: 2,
            correctedAt: '2026-09-02T00:00:00Z',
          },
        }}
        audits={[audit]}
        view="geo"
        loading={false}
        error={false}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/Settings changed since this measurement/)).toBeInTheDocument();
    expect(screen.getByText(/Evidence correction revision 2/)).toHaveTextContent(
      'Scores and generated PDFs are historical snapshots',
    );
    await userEvent.selectOptions(screen.getByLabelText('Select measurement'), '11');
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/ai-visibility/websites/7/geo?audit=11');
  });
  it('searches the displayed SEO fix title while retaining raw title, URL, module and status filters', async () => {
    const heading = { ...recommendation, title: 'Add an H1 to the page', description: 'Add a heading.', evidence: { ruleId: 'headings.missing_h1' } };
    mocks.api.recommendations.mockResolvedValue({ recommendations: [heading, { ...heading, id: 6, status: 'resolved' }] });
    wrap(<FixesView projectId={7} />);
    await screen.findByRole('button', { name: /Missing primary heading/ });
    const user = userEvent.setup();
    const search = screen.getByRole('textbox', { name: 'Search fixes' });
    for (const text of ['missing', 'MISSING PRIMARY HEADING', 'Add an H1', 'example.com/1', 'seo']) {
      await user.clear(search);
      await user.type(search, text);
      expect(screen.getByText('1 of 2 fixes')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Missing primary heading/ })).toBeInTheDocument();
    }
    await user.clear(search);
    await user.type(search, 'no_such_fix');
    expect(screen.getByText('No fixes match these filters.')).toBeInTheDocument();
    await user.clear(search);
    expect(screen.getByText('1 of 2 fixes')).toBeInTheDocument();
    expect(mocks.api.updateRecommendation).not.toHaveBeenCalled();
  });

  it('saves resolution evidence and refreshes the overview count without reload', async () => {
    const { client } = wrap(<FixesView projectId={7} />);
    client.setQueryData(['ai-visibility-overview', 7], overview);
    await userEvent.click(await screen.findByRole('button', { name: /Missing page title/ }));
    await userEvent.selectOptions(screen.getByLabelText('Workflow status'), 'resolved');
    fireEvent.change(screen.getByLabelText('Resolution evidence'), {
      target: { value: 'Implemented in PR #42' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save work' }));
    await waitFor(() =>
      expect(mocks.api.updateRecommendation).toHaveBeenCalledWith(
        7,
        5,
        expect.objectContaining({
          status: 'resolved',
          resolutionEvidence: 'Implemented in PR #42',
        }),
      ),
    );
    await waitFor(() =>
      expect(client.getQueryState(['ai-visibility-overview', 7])?.isInvalidated).toBe(true),
    );
  });
  it('refreshes mounted dependent queries on terminal transitions and late report retry', async () => {
    const { client } = wrap(<SeoView projectId={7} />);
    await screen.findByText('Findings (2)');
    for (const key of [
      'ai-visibility-overview',
      'ai-visibility-prompts',
      'ai-visibility-aeo-coverage',
      'ai-visibility-competitor-intelligence',
      'ai-visibility-reports',
    ])
      client.setQueryData([key, 7], {});
    mocks.api.seo.mockResolvedValue({
      audit,
      issues: [issue(30, 'critical')],
      pages: [],
    });
    await refreshVisibility(client, 7);
    await screen.findByText('Findings (1)');
    for (const key of [
      'ai-visibility-overview',
      'ai-visibility-prompts',
      'ai-visibility-aeo-coverage',
      'ai-visibility-competitor-intelligence',
      'ai-visibility-reports',
    ])
      expect(client.getQueryState([key, 7])?.isInvalidated).toBe(true);
  });
  it('edits an exact asset version and sends review comments with that version', async () => {
    const asset = {
      id: 4,
      auditId: 11,
      recommendationId: 5,
      contentAssetId: 33,
      title: 'Content research plan',
      type: 'content_brief',
      content: '# Research plan\nVerify customer claims.',
      status: 'draft',
      approvalStatus: 'draft',
      version: 3,
      createdAt: '2026-09-01',
    };
    mocks.api.assets.mockResolvedValue({ assets: [asset] });
    wrap(<AssetsView projectId={7} role="owner" />);
    await screen.findByRole('button', { name: 'Edit this asset' });
    fireEvent.change(screen.getByLabelText('Review comment'), {
      target: { value: 'Sources reviewed' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Approve v3' }));
    await waitFor(() =>
      expect(mocks.api.decideAsset).toHaveBeenCalledWith(7, 4, 3, 'approved', 'Sources reviewed'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit this asset' }));
    fireEvent.change(screen.getByLabelText('Draft content'), {
      target: { value: '# Revised plan\nUse verified sources.' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await waitFor(() =>
      expect(mocks.api.editAsset).toHaveBeenCalledWith(7, 4, {
        version: 3,
        title: asset.title,
        content: '# Revised plan\nUse verified sources.',
      }),
    );
  });
  it('retains Markdown blog formatting in exact asset review',async()=>{
    mocks.api.assets.mockResolvedValue({assets:[{id:4,auditId:11,contentAssetId:33,title:'Markdown article',type:'blog',content:'## Reviewed heading\n\n**Reviewed bold**',status:'draft',approvalStatus:'draft',version:3,createdAt:'2026-09-01'}]});
    const {container}=wrap(<AssetsView projectId={7} role="owner"/>);
    await screen.findByRole('heading',{name:'Reviewed heading'});
    expect(container.querySelector('strong')).toHaveTextContent('Reviewed bold');expect(screen.queryByLabelText('HTML draft source')).not.toBeInTheDocument();
  });

  it.each(['blog','blog_post'])('shows an HTML %s body as escaped source for exact review',async type=>{
    const body='<p>Reviewed synthetic body</p><img src="https://external.example.test/image" onerror="alert(1)"><script>alert(1)</script>';
    mocks.api.assets.mockResolvedValue({assets:[{id:4,auditId:11,contentAssetId:33,title:'HTML article',type,content:body,status:'draft',approvalStatus:'approved',version:3,createdAt:'2026-09-01'}]});
    const {container}=wrap(<AssetsView projectId={7} role="owner"/>);
    await screen.findByRole('heading',{name:'HTML article'});
    expect(screen.getByText(/Reviewed synthetic body/)).toBeInTheDocument();
    expect(screen.getByLabelText('HTML draft source')).toHaveTextContent(body);
    expect(container.querySelector('img,script,iframe')).toBeNull();
  });

  it("checks a sending CMS outcome after reload using its original intent and exact version", async () => {
    const asset = {
      id: 4,
      auditId: 11,
      recommendationId: 5,
      contentAssetId: 33,
      title: "Reviewed article",
      type: "blog",
      content: "<p>Reviewed content</p>",
      status: "draft",
      approvalStatus: "approved",
      version: 3,
      createdAt: "2026-09-01",
    };
    mocks.api.assets.mockResolvedValue({ assets: [asset] });
    mocks.api.cmsConnections.mockResolvedValue({
      connections: [
        { platform: "wordpress", connected: true, publishingReady: true },
      ],
    });
    mocks.api.cmsPublishAttempts.mockResolvedValue({
      attempts: [
        {
          id: 9,
          idempotencyKey: "00000000-0000-4000-8000-000000000009",
          generatedAssetLinkId: 4,
          contentAssetId: 33,
          platform: "wordpress",
          assetVersion: 3,
          status: "sending",
          createdAt: "2026-09-01",
          attemptCount: 1,
        },
      ],
    });
    wrap(<AssetsView projectId={7} role="owner" />);
    const check = await screen.findByRole("button", {
      name: "Check wordpress draft outcome",
    });
    expect(check).toBeEnabled();
    expect(screen.getByText(/no confirmed outcome yet/)).toBeInTheDocument();
    await userEvent.click(check);
    await waitFor(() =>
      expect(mocks.api.createCmsDraft).toHaveBeenCalledWith(
        7,
        4,
        "wordpress",
        "00000000-0000-4000-8000-000000000009",
        3,
        true,
      ),
    );
  });

  it('renders safe Markdown and rejects script links and raw HTML', () => {
    const { container } = wrap(
      <SafeMarkdown>
        {
          '**Verified answer** [source](https://example.com) [unsafe](javascript:alert(1)) <script>alert(1)</script>'
        }
      </SafeMarkdown>,
    );
    expect(container.querySelector('strong')).toHaveTextContent('Verified answer');
    expect(screen.getByRole('link', { name: 'source' })).toHaveAttribute(
      'href',
      'https://example.com/',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });
});

describe('Report recovery and complete library access', () => {
  it('polls a late PDF retry into a fresh preview without reloading', async () => {
    const report = {
      auditId: 11,
      status: 'failed',
      createdAt: audit.createdAt,
      completedAt: null,
      sizeBytes: 0,
    };
    mocks.api.reports.mockResolvedValue({ reports: [report] });
    mocks.api.retryReport.mockResolvedValue({ auditId: 11 });
    mocks.api.reportUrl.mockReturnValue('/fixture.pdf');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('%PDF-1.4\nSynthetic fixture', {
      headers: { 'Content-Type': 'application/pdf' },
    }));
    const createUrl = URL.createObjectURL,
      revokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:fixture');
    URL.revokeObjectURL = vi.fn();
    try {
      const { client } = wrap(
        <ReportLibrary
          projectId={7}
          onDownload={vi.fn()}
          onEmail={vi.fn()}
          onShare={vi.fn()}
          sharing={false}
        />,
      );
      await userEvent.click(
        await screen.findByRole('button', {
          name: 'Retry PDF · no analysis charge',
        }),
      );
      expect(await screen.findByText(/PDF generation queued/)).toBeInTheDocument();
      mocks.api.reports.mockResolvedValue({
        reports: [
          {
            ...report,
            status: 'completed',
            completedAt: '2026-09-09T12:00:00Z',
            sizeBytes: 2048,
          },
        ],
      });
      await waitFor(
        () =>
          expect(screen.getByTitle('PDF preview for analysis 11')).toHaveAttribute(
            'src',
            'blob:fixture',
          ),
        { timeout: 5000 },
      );
      expect(screen.queryByText(/PDF generation queued/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
      expect(
        client.getQueryData(['ai-visibility-report-pdf', 11, '2026-09-09T12:00:00Z']),
      ).toBeDefined();
    } finally {
      fetchMock.mockRestore();
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revokeUrl;
    }
  });
  it('keeps report 45 searchable and reachable for a reviewer without sharing controls', async () => {
    mocks.api.reports.mockResolvedValue({
      reports: Array.from({ length: 45 }, (_, index) => ({
        auditId: index + 1,
        status: 'failed',
        createdAt: audit.createdAt,
        completedAt: null,
      })),
    });
    wrap(
      <ReportLibrary
        projectId={7}
        onDownload={vi.fn()}
        onEmail={vi.fn()}
        onShare={vi.fn()}
        sharing={false}
      />,
      'client_reviewer',
    );
    await screen.findByText('45 matching reports');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: /Analysis #45 · PDF not ready/ }));
    expect(screen.getByRole('heading', { name: 'Analysis #45' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry PDF/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search reports' }), '45');
    expect(screen.getByText('1 matching reports')).toBeInTheDocument();
  });
});

const observedRun: ProviderPromptRun = {
  id: 31,
  promptId: 1,
  provider: 'openai',
  model: 'fixture',
  status: 'completed',
  answer: '**Verified fixture answer**',
  citations: [{ url: 'https://example.com/evidence', title: 'Source' }],
  cachedFromRunId: null,
  brandMentioned: true,
  brandRank: 1,
  sentiment: 'neutral',
  competitors: [],
  recommendationReason: null,
  exclusionReason: null,
  extractionStatus: 'completed',
  extractionMethod: 'fixture',
  extractionProvider: 'fixture',
  extractionModel: 'fixture',
  extractionFidelity: 'live_api',
  extractionError: null,
  error: null,
};

describe('Cross-section roles and GEO evidence filters', () => {
  it.each(['owner', 'agency_admin', 'editor', 'client_reviewer'])(
    'applies connection, catalog, competitor and correction permissions for %s',
    async (role) => {
      wrap(
        <>
          <GscCard projectId={7} />
          <CommerceView projectId={7} />
          <CompetitorView projectId={7} />
          <PromptRunObservation projectId={7} run={observedRun} />
        </>,
        role,
      );
      expect(await screen.findByRole('button', { name: 'Connect Search Console' })).toHaveProperty(
        'disabled',
        role !== 'owner',
      );
      expect(screen.getByLabelText('Product feed')).toHaveProperty(
        'disabled',
        role === 'client_reviewer',
      );
      await userEvent.type(screen.getByLabelText('Competitor name'), 'Fixture competitor');
      await userEvent.type(screen.getByLabelText('Website URL'), 'https://competitor.example');
      expect(screen.getByRole('button', { name: 'Add competitor' })).toHaveProperty(
        'disabled',
        role === 'client_reviewer',
      );
      expect(Boolean(screen.queryByRole('button', { name: 'Correct extracted fields' }))).toBe(
        role !== 'client_reviewer',
      );
      expect(
        Boolean(
          within(screen.getByRole('region', { name: 'Catalog connection' })).queryByRole('button', {
            name: 'Connect',
          }),
        ),
      ).toBe(role === 'owner');
    },
  );
  it('filters discovery evidence by provider, mention and citation without treating failed extraction as absence', async () => {
    const prompts = [
      {
        id: 1,
        prompt: 'Which service solves my problem?',
        intent: 'discovery',
        isGeneric: true,
        locale: 'en-IN',
      },
      {
        id: 2,
        prompt: 'How does Example brand work?',
        intent: 'branded',
        isGeneric: false,
        locale: 'en-IN',
      },
    ];
    mocks.api.prompts.mockResolvedValue({
      audit,
      prompts,
      runs: [
        observedRun,
        {
          ...observedRun,
          id: 32,
          promptId: 2,
          provider: 'gemini',
          brandMentioned: false,
          citations: [],
        },
        {
          ...observedRun,
          id: 33,
          promptId: 1,
          provider: 'gemini',
          brandMentioned: false,
          extractionStatus: 'failed',
          citations: [],
        },
      ],
    });
    wrap(<GeoView projectId={7} />);
    await screen.findByText('2 matching prompts');
    await userEvent.selectOptions(screen.getByLabelText('Prompt type'), 'discovery');
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'openai');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Brand mentioned' }), 'yes');
    await userEvent.selectOptions(screen.getByLabelText('Has citations'), 'yes');
    expect(screen.getByText('1 matching prompts')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /View ChatGPT \(OpenAI\) evidence for/ }));
    expect(screen.getByRole('complementary', { name: 'Provider answer detail' })).toHaveTextContent(
      'Verified fixture answer',
    );
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'gemini');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Brand mentioned' }), 'no');
    await userEvent.selectOptions(screen.getByLabelText('Has citations'), 'all');
    expect(screen.getByText('No observations match these filters.')).toBeInTheDocument();
  });

  it('says why no earlier analysis can be compared instead of an empty list', async () => {
    // Saved before analyses recorded their settings, so it can't be compared.
    const older = { ...audit, id: 1, inputSnapshot: {}, createdAt: '2026-08-13T00:00:00Z' };
    mocks.api.listAudits.mockResolvedValue({ audits: [audit, older] });
    mocks.api.prompts.mockResolvedValue({
      audit,
      prompts: [{ id: 1, prompt: 'Which service solves my problem?', intent: 'discovery', isGeneric: true, locale: 'en-IN' }],
      runs: [{ ...observedRun, promptId: 1 }],
    });
    wrap(<GeoView projectId={7} />);
    await userEvent.click(await screen.findByText('Compare compatible measurements'));
    expect(
      await screen.findByText(/None of the 1 other completed analysis can be compared with this one\./),
    ).toHaveTextContent('Run another analysis with the same settings to compare.');
    expect(screen.queryByLabelText('Compare with')).not.toBeInTheDocument();
  });
});

describe('Complete question and asset lists', () => {
  it('opens question 65 after pagination and preserves searchable access', async () => {
    const questions = Array.from({ length: 65 }, (_, index) => ({
      ...question,
      id: index + 1,
      question: `Fixture question ${index + 1}?`,
    }));
    mocks.api.aeoQuestions.mockResolvedValue({ questions });
    mocks.api.aeoCoverage.mockResolvedValue({
      audit,
      available: true,
      summary: { total: 65, answered: 0, partial: 0, uncovered: 65 },
      coverage: questions.map((item) => ({
        ...item,
        questionId: item.id,
        status: 'uncovered',
        bestMatch: null,
        matches: [],
      })),
    });
    wrap(<AeoView projectId={7} />);
    await screen.findByText('65 matching questions');
    for (let page = 0; page < 3; page++)
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Fixture question 65?' }),
    );
    expect(
      screen.getByRole('complementary', { name: 'Question evidence and actions' }),
    ).toHaveTextContent('Fixture question 65?');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search tracked questions' }),
      'question 65?',
    );
    expect(screen.getByText('1 matching questions')).toBeInTheDocument();
  });
  it('opens asset 45 directly from the final page and keeps its exact version visible', async () => {
    mocks.api.assets.mockResolvedValue({
      assets: Array.from({ length: 45 }, (_, index) => ({
        id: index + 1,
        auditId: 11,
        recommendationId: null,
        contentAssetId: 100 + index,
        title: `Fixture brief ${index + 1}`,
        type: 'content_brief',
        content: `# Research plan ${index + 1}\nVerify primary sources.`,
        status: 'draft',
        approvalStatus: 'draft',
        version: 3,
        createdAt: '2026-09-01',
      })),
    });
    wrap(<AssetsView projectId={7} role="owner" />);
    await screen.findByText('45 assets');
    for (let page = 0; page < 2; page++)
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: /Fixture brief 45/ }));
    expect(screen.getByRole('button', { name: 'Approve v3' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Research plan 45' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search assets' }), 'brief 45');
    expect(screen.getByText('1 assets')).toBeInTheDocument();
  });
});

describe('Commerce for websites that are not online stores', () => {
  it('explains that Commerce is for online stores and reads a WooCommerce catalog on request', async () => {
    mocks.api.syncWooCommerceCatalog.mockResolvedValue({ snapshot: { id: 1 } });
    wrap(<CommerceView projectId={7} />);
    expect(await screen.findByText('Commerce is for online stores')).toBeInTheDocument();
    expect(screen.getByText(/example\.com is set up as “Other business”/)).toBeInTheDocument();
    // Shopify is not connected, so there is nothing to sync yet.
    expect(screen.queryByRole('button', { name: 'Sync Shopify products' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Read products from example.com' }));
    await waitFor(() => expect(mocks.api.syncWooCommerceCatalog).toHaveBeenCalledWith(7));
  });
});

describe('Populated search and competitor measurements', () => {
  it('exposes every Search Console opportunity, filters missing matches, and syncs the chosen dates', async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      query: `fixture search ${index + 1}`,
      page: `https://example.com/page-${index + 1}`,
      clicks: 1,
      impressions: 100,
      ctr: 0.01,
      position: 8,
      priority: 'high',
      reason: 'Review the result snippet.',
    }));
    mocks.api.gsc.mockResolvedValue({
      connected: true,
      available: true,
      connection: { selectedProperty: 'sc-domain:example.com', availableProperties: [] },
      summary: { clicks: 75, impressions: 7500, ctr: 0.01, position: 8 },
      snapshot: { id: 1, startDate: '2026-08-10', endDate: '2026-08-16' },
      opportunities: rows,
      rows,
    });
    wrap(<GscCard projectId={7} />);
    await screen.findByText('75 matching opportunities · 75 total in loaded rows');
    await userEvent.click(screen.getByRole('button', { name: 'Show more opportunities' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show more opportunities' }));
    expect(screen.getByText('fixture search 75', { selector: 'span' })).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search Search Console queries and pages' }),
      'does not exist',
    );
    expect(screen.getByText('No opportunities match this search.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Show more opportunities' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-16' } });
    await userEvent.click(screen.getByRole('button', { name: 'Sync selected dates' }));
    await waitFor(() =>
      expect(mocks.api.syncGsc).toHaveBeenCalledWith(7, {
        startDate: '2026-08-10',
        endDate: '2026-08-16',
        compare: true,
      }),
    );
  });
  it('shows the tracked-set denominator beside benchmark metrics and separate sampled content gaps', async () => {
    const metrics = {
      mentions: 2,
      shareOfVoice: 0.5,
      promptWins: 1,
      citationCount: 1,
      crawledPages: 8,
      mentionRate: 0.5,
      citationShare: 0.5,
    };
    mocks.api.competitorIntelligence.mockResolvedValue({
      available: true,
      intelligence: {
        promptCount: 4,
        totalMentionEvents: 4,
        brand: { ...metrics, crawledPages: 25 },
        citedDomains: [
          {
            domain: 'tripadvisor.com',
            citations: 16,
            share: 0.4,
            hosts: ['tripadvisor.com', 'tripadvisor.in', 'no.tripadvisor.com'],
          },
        ],
        competitors: [
          {
            competitorId: 9,
            name: 'Fixture rival',
            domain: 'https://rival.example',
            active: true,
            metrics,
            contentGaps: [
              {
                key: 'pricing',
                label: 'Pricing',
                competitorPageCount: 1,
                brandPageCount: 0,
                evidenceUrls: ['https://rival.example/pricing'],
              },
            ],
          },
        ],
      },
    });
    wrap(<CompetitorView projectId={7} />);
    await screen.findByText(/Based on 4 AI answers/);
    expect(screen.getByText(/Based on 4 AI answers/)).toHaveTextContent('it is not market share');
    // One competitor is too few for share of voice to mean much.
    expect(screen.getByText('Too few competitors for a fair comparison')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Pages competitors have that you don’t' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Fixture rival has 1; none found on your site.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View their page' })).toHaveAttribute(
      'href',
      'https://rival.example/pricing',
    );
    expect(screen.getByText('tripadvisor.com · 16 (3 country sites)')).toBeInTheDocument();
  });

  it('finds a suggested competitor’s website, then tracks it with that website', async () => {
    mocks.api.suggestCompetitors.mockResolvedValue({
      suggestions: [
        {
          name: 'Discovery Village Nandi',
          domain: null,
          aliases: [],
          confidence: 'medium',
          sources: [{ type: 'provider_observation', label: 'Named in ChatGPT answers', evidenceCount: 2 }],
        },
      ],
      sourcesUsed: ['provider_observation'],
      unavailableReason: null,
    });
    mocks.api.lookupCompetitorWebsite.mockResolvedValue({
      website: 'https://www.discoveryvillage.in',
      verified: true,
      trackable: true,
      pageTitle: 'Discovery Village',
      message: 'Found https://www.discoveryvillage.in. Check it is Discovery Village Nandi’s own website, then track it.',
    });
    wrap(<CompetitorView projectId={7} />);
    expect(await screen.findByText('Named in ChatGPT answers (2 times)')).toBeInTheDocument();
    const track = screen.getByRole('button', { name: 'Track competitor' });
    expect(track).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Find website' }));
    expect(await screen.findByDisplayValue('https://www.discoveryvillage.in')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Check it is Discovery Village Nandi/);
    await userEvent.click(track);
    await waitFor(() =>
      expect(mocks.api.addCompetitor).toHaveBeenCalledWith(7, {
        name: 'Discovery Village Nandi',
        domain: 'https://www.discoveryvillage.in',
        aliases: [],
      }),
    );
  });
});

describe('Report storage failure recovery', () => {
  it('shows the storage cause and stops polling when a retry fails again', async () => {
    const report = {
      auditId: 11,
      status: 'missing',
      createdAt: audit.createdAt,
      completedAt: null,
      generationAttempt: 1,
      generationStatus: 'warning',
      error: 'Storage limit exceeded. Fixture quota.',
    };
    mocks.api.reports.mockResolvedValue({ reports: [report] });
    mocks.api.retryReport.mockImplementation(async () => {
      mocks.api.reports.mockResolvedValue({ reports: [{ ...report, generationAttempt: 2 }] });
      return { auditId: 11 };
    });
    wrap(
      <ReportLibrary
        projectId={7}
        onDownload={vi.fn()}
        onEmail={vi.fn()}
        onShare={vi.fn()}
        sharing={false}
      />,
    );
    expect(
      await screen.findByText('There is not enough storage to save this PDF. Review storage usage before retrying.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Review storage usage before retrying' }),
    ).toHaveAttribute('href', '/dashboard/storage');
    await userEvent.click(screen.getByRole('button', { name: 'Retry PDF · no analysis charge' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry PDF · no analysis charge' })).toBeEnabled(),
    );
    expect(screen.queryByText(/PDF generation queued/)).not.toBeInTheDocument();
  });
});

describe('Audit history completion wording', () => {
  it.each(['queued', 'running', 'failed', 'cancelled'] as const)(
    'does not describe a zero-warning %s attempt as completed',
    async (status) => {
      mocks.api.listAudits.mockResolvedValue({
        audits: [{ ...audit, id: 12, status, completedAt: null, warningCount: 0 }],
      });
      wrap(<AiVisibilityWorkspace projectId={7} view="overview" />);
      await screen.findByText(
        status === 'failed' ? 'Analysis failed before completion' : `Analysis ${status}`,
      );
      expect(screen.queryByText('No warnings')).not.toBeInTheDocument();
    },
  );
});

describe('Competitor workspace recovery', () => {
  it('keeps manual additions available when measurement context fails', async () => {
    mocks.api.overview.mockRejectedValue(new Error('Overview failed'));
    mocks.api.addCompetitor.mockResolvedValue({ competitor: { id: 99 } });
    wrap(<AiVisibilityWorkspace projectId={7} view="competitors" />);
    await screen.findByText('Measurement context is unavailable.', {}, { timeout: 15000 });
    fireEvent.change(screen.getByLabelText('Competitor name'), {
      target: { value: 'Manual company' },
    });
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://manual.example' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add competitor' }));
    await waitFor(() =>
      expect(mocks.api.addCompetitor).toHaveBeenCalledWith(7, {
        name: 'Manual company',
        domain: 'https://manual.example',
      }),
    );
  });
});
