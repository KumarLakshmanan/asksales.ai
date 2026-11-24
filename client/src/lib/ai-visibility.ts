import api, { buildApiUrl } from './api';
import { type CompetitorVisibilityMetrics, type ExtractionCorrection } from '../../../shared/aiVisibilityTypes';
export type { ExtractionCorrection };
export type { CompetitorVisibilityMetrics };

export type AiVisibilityProfile = 'b2b_saas' | 'ecommerce' | 'local_business' | 'general';
export type AuditStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled';
export type StageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface CustomGeoPrompt {
  id: string;
  prompt: string;
  intent: string;
  isGeneric: boolean;
  active: boolean;
}

export interface AiVisibilityProject {
  configurationRevision?: number;
  geoPrompts?: CustomGeoPrompt[];
  id: number;
  workspaceId: number;
  name: string;
  domain: string;
  category: string | null;
  brandAliases: string[];
  scoringProfile: AiVisibilityProfile;
  country: string;
  locale: string;
  targetGeography: string | null;
  businessProfileId: number | null;
  brandToolkitId: number | null;
  source: 'business_profile' | 'website_search' | 'legacy';
  monitoringEnabled: boolean;
  monitoringCadence: string;
  monitoringEstimatedCredits: string;
  nextMonitoringAt: string | null;
  createdAt: string;
  updatedAt: string;
  workspace?: {
    workspaceName: string;
    workspaceKind: 'private' | 'client';
    organizationId: number | null;
    role: 'owner' | 'billing_admin' | 'member' | 'agency_admin' | 'editor' | 'client_reviewer';
  };
}

export interface AiVisibilityBusinessProfile {
  id: number;
  name: string | null;
  companyName: string | null;
  businessName: string | null;
  website: string | null;
  isDefault: boolean | null;
  isApproved: boolean;
}

export interface WebsiteSearchInput {
  website: string;
  name?: string;
  brandAliases?: string[];
  category?: string;
  scoringProfile?: AiVisibilityProfile;
  country?: string;
  locale?: string;
  targetGeography?: string;
}

export interface AiVisibilityGeneratedAsset {
  metadata?: Record<string, unknown> | null;
  validationSnapshot?: Record<string, unknown> | null;
  id: number;
  auditId: number;
  recommendationId: number | null;
  contentAssetId: number;
  title: string;
  type: string;
  content: string;
  status: string;
  approvalStatus: string;
  version: number;
  createdAt: string;
}

export interface AiVisibilityAssetApprovalDecision {
  decision: {
    id: number;
    generatedAssetLinkId: number;
    contentAssetId: number;
    assetVersion: number;
    actorUserId: number;
    decision: 'approved' | 'rejected';
    comment: string | null;
    createdAt: string;
  };
  actorName: string;
  actorEmail: string;
}

export type AiVisibilityWorkspaceRole = 'owner' | 'billing_admin' | 'member' | 'agency_admin' | 'editor' | 'client_reviewer';
export interface AiVisibilityWhiteLabelDefaults {
  displayName?: string;
  tagline?: string;
  primaryColor?: string;
  accentColor?: string;
}
export interface AiVisibilityWorkspaceSummary {
  workspace: {
    id: number;
    name: string;
    kind: 'private' | 'client';
    organizationId: number | null;
    whiteLabelDefaults: AiVisibilityWhiteLabelDefaults;
  };
  organization: {
    id: number;
    name: string;
    slug: string;
    whiteLabelDefaults: AiVisibilityWhiteLabelDefaults;
  } | null;
  membership: { id: number; role: AiVisibilityWorkspaceRole; status: string };
  members: Array<{
    membership: { id: number; role: AiVisibilityWorkspaceRole; status: string };
    name: string;
    email: string;
  }>;
}

export type AiVisibilityCmsPlatform = 'wordpress' | 'shopify';

export interface AiVisibilityCmsConnection {
  publishingReady?: boolean;
  platform: AiVisibilityCmsPlatform;
  connected: boolean;
  accountLabel: string | null;
  siteUrl: string | null;
  storeDomain: string | null;
  blogTitle: string | null;
}

export interface AiVisibilityCmsPublishAttempt {
  id: number;
  idempotencyKey: string;
  generatedAssetLinkId: number;
  contentAssetId: number;
  platform: AiVisibilityCmsPlatform;
  assetVersion: number;
  status: 'pending' | 'sending' | 'draft_created' | 'retryable_failed' | 'ambiguous' | 'failed';
  destinationId: string | null;
  destinationUrl: string | null;
  attemptCount: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AiVisibilityReport {
  generationAttempt?: number | null;
  generationStatus?: string | null;
  error?: string | null;
  correctionRevision?: number;
  correctedAt?: string | null;
  id: number | null;
  auditId: number;
  projectId: number;
  auditStatus: 'completed' | 'completed_with_warnings';
  status: string;
  sizeBytes: number | null;
  brandingSnapshot: {
    toolkitId: number | null;
    displayName: string;
    tagline: string | null;
    primaryColor: string;
    accentColor: string;
  } | null;
  methodology: {
    methodologyVersion: number;
    generatedAt: string;
    scoring: {
      profile: string;
      version: number;
      inputFingerprint: string;
      overallScore: number;
      normalizedWeights: Record<string, number>;
    };
    pillars: Array<{
      key: 'seo' | 'aeo' | 'geo' | 'commerce';
      label: string;
      status: 'scored' | 'not_applicable' | 'unavailable';
      score: number | null;
      reason: string;
      formula: string;
    }>;
    coverage: {
      completedBrandPages: number;
      failedBrandPages: number;
      seoIssues: number;
      aeoQuestions: number;
      providerObservations: number;
      successfulProviderAnswers: number;
      extractedProviderAnswers: number;
      citations: number;
      trackedCompetitors: number;
      competitorSnapshots: number;
    };
    providers: Array<{
      provider: string;
      models: string[];
      fidelity: string[];
      observations: number;
      successful: number;
      failed: number;
      extracted: number;
      citations: number;
      failureReasons: string[];
    }>;
    competitors: {
      status: 'measured' | 'unavailable' | 'not_applicable';
      tracked: number;
      analyzed: number;
      extractedMentions: number;
      reason: string;
    };
    commerce: {
      status: 'measured' | 'not_applicable';
      sourceType: string | null;
      sourceName: string | null;
      itemCount: number;
      validItemCount: number;
      inputFingerprint: string | null;
      reason: string;
    };
    disclosures: string[];
  } | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AiVisibilityReportDelivery {
  id: number;
  auditId: number;
  recipientEmail: string;
  status: 'sending' | 'sent' | 'failed';
  attempts: number;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiVisibilityReportShare {
  id: number;
  auditId: number;
  tokenPrefix: string;
  expiresAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
  active: boolean;
}

export interface AiVisibilityAuditEstimate {
  providerReadiness?: ProviderReadiness[];
  reservedCredits: number;
  temporaryHold: number;
  estimatedMaximum: number;
  directBaseCharge: number;
  walletBalance: number;
  expectedActual: number | null;
  expectedActualBasis: 'audit_history' | 'unavailable';
  assumptions: {
    brandPageLimit: number;
    competitorPageLimit: number;
    automaticCompetitorLimit?: number;
    activeCompetitors?: number;
    competitors: number;
    providerRequests: number;
    extractionRequests: number;
    reportCount: number;
    [key: string]: number | undefined;
  };
  pricing: Record<string, number>;
  lineItems: Array<{
    key: string;
    units: number;
    creditsPerUnit: number;
    maximumCredits: number;
  }>;
}

export interface AuditStage {
  id: number;
  stageKey: string;
  status: StageStatus;
  attemptCount: number;
  progress: number;
  warning: string | null;
  error: string | null;
  output: Record<string, unknown> | null;
}

export interface AiVisibilityAudit {
  correctionRevision?: number;
  correctedAt?: string | null;
  inputSnapshot?: { project?: Partial<AiVisibilityProject> };
  id: number;
  projectId: number;
  status: AuditStatus;
  trigger: 'manual' | 'monitoring';
  warningCount: number;
  error: string | null;
  cancellationRequested: boolean;
  reservedCredits: string;
  actualCredits: string;
  billingMode?: 'reservation' | 'direct';
  summary: Record<string, unknown>;
  stages?: AuditStage[];
  createdAt: string;
  completedAt: string | null;
}

export interface ScoreSnapshot {
  auditId?: number;
  scoringVersion?: number;
  createdAt?: string;
  overallScore: string;
  seoScore: string | null;
  aeoScore: string | null;
  geoScore: string | null;
  commerceScore: string | null;
  pillarStatuses: Record<string, 'scored' | 'not_applicable' | 'unavailable'>;
  metrics: Record<string, number | string | null>;
  subScores: Record<string, number>;
  inputFingerprint: string;
}

export interface GscPropertyAccess {
  siteUrl: string;
  permissionLevel: string;
}

export interface AiVisibilityGscOpportunity {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  priority: 'high' | 'medium';
  potentialClicks: number;
  reason: string;
}

export interface GscSnapshot {
  id: number;
  propertyUri: string;
  startDate: string;
  endDate: string;
  rowCount: number;
  createdAt: string;
}

export interface AiVisibilityGscOverview {
  snapshots?: GscSnapshot[];
  rows?: Array<{
    query: string;
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  comparison?: {
    snapshot: GscSnapshot;
    clicks: number;
    impressions: number;
  } | null;
  connected: boolean;
  available: boolean;
  unavailableReason: string | null;
  connection: null | {
    id: number;
    selectedProperty: string | null;
    permissionLevel: string | null;
    availableProperties: GscPropertyAccess[];
    status: string;
    lastSyncedAt: string | null;
    lastSyncError: string | null;
  };
  snapshot: null | {
    id: number;
    propertyUri: string;
    startDate: string;
    endDate: string;
    rowCount: number;
    createdAt: string;
  };
  summary: null | {
    rowCount: number;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
  opportunities: AiVisibilityGscOpportunity[];
}

export interface Recommendation {
  issueKey?: string | null;
  assigneeUserId?: number | null;
  dueDate?: string | null;
  resolutionEvidence?: string | null;
  verificationStatus?: 'unverified' | 'verified' | 'still_present' | 'not_rechecked';
  verifiedAt?: string | null;
  id: number;
  auditId: number;
  module: string;
  title: string;
  description: string;
  severity: string;
  impact: string;
  effort: string;
  affectedUrl: string | null;
  evidence: Record<string, unknown>;
  confidence: string;
  status: 'open' | 'in_progress' | 'resolved' | 'rejected';
  assetType: string | null;
  generatedDraft: string | null;
}

export interface ProviderCitation {
  url: string;
  title?: string | null;
}

export interface ProviderPromptRun {
  id: number;
  promptId: number;
  provider: string;
  model: string;
  status: string;
  answer: string | null;
  citations: ProviderCitation[];
  cachedFromRunId: number | null;
  brandMentioned: boolean | null;
  brandRank: number | null;
  sentiment: string | null;
  competitors: string[];
  recommendationReason: string | null;
  exclusionReason: string | null;
  extractionStatus: 'pending' | 'completed' | 'failed' | 'corrected' | 'cached' | 'legacy';
  extractionMethod: string | null;
  extractionProvider: string | null;
  extractionModel: string | null;
  extractionFidelity: string | null;
  extractionError: string | null;
  error: string | null;
}

export interface AiVisibilityAlert {
  id: number;
  auditId: number | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface CompetitorSuggestion {
  name: string;
  domain: string | null;
  aliases: string[];
  confidence: 'high' | 'medium';
  sources: Array<{
    type: 'business_profile_reference' | 'provider_observation';
    label: string;
    evidenceCount: number;
  }>;
  lastObservedAt: string | null;
}

export interface CompetitorIntelligence {
  promptCount: number;
  totalMentionEvents: number;
  totalCitations: number;
  brand: CompetitorVisibilityMetrics;
  competitors: Array<{
    competitorId: number;
    name: string;
    domain: string;
    active: boolean;
    metrics: CompetitorVisibilityMetrics;
    contentGaps: Array<{
      key: string;
      pageType: string;
      label: string;
      brandPageCount: number;
      competitorPageCount: number;
      evidenceUrls: string[];
    }>;
  }>;
  /** `hosts` lists the site's editions counted together (tripadvisor.com, tripadvisor.in, …). */
  citedDomains: Array<{ domain: string; citations: number; share: number; hosts?: string[] }>;
}

export interface CompetitorWebsiteLookup {
  website: string | null;
  verified: boolean;
  /** False when the business only has a page on a larger company's site. */
  trackable: boolean;
  pageTitle: string | null;
  message: string;
}

export interface AeoQuestionCoverage {
  questionId: number;
  question: string;
  intent: string;
  targetPage: string | null;
  active: boolean;
  status: 'answered' | 'partial' | 'uncovered';
  bestMatch: {
    pageId: number;
    url: string;
    title: string | null;
    score: number;
    answerExcerpt: string | null;
    supportedSchema: boolean;
    signals: string[];
  } | null;
  matches: Array<{
    pageId: number;
    url: string;
    title: string | null;
    score: number;
    answerExcerpt: string | null;
    supportedSchema: boolean;
    signals: string[];
  }>;
}

export interface ProviderReadiness {
  provider: string;
  model: string | null;
  configured: boolean;
  status: string;
  reason: string;
  lastAuditId?: number | null;
  lastObservedAt?: string | null;
  successful?: number;
  failed?: number;
  lastError?: string | null;
}
export interface MeasurementCoverage {
  attemptedProviders: number;
  successfulProviders: number;
  expectedObservations: number;
  successfulObservations: number;
  extractedObservations: number;
  citations: number;
  partial: boolean;
  checkedPages: number;
  completedPages: number;
  pageLimit: number;
}
export interface VisibilityOverview {
  project: AiVisibilityProject;
  latestAudit: AiVisibilityAudit | null;
  measurementAudit?: AiVisibilityAudit | null;
  latestScore: ScoreSnapshot | null;
  openRecommendations: number;
  coverage?: MeasurementCoverage;
  configurationChanged?: boolean;
  /** SEO rule version of the measurement shown; scores compare only within one version. */
  measurementSeoRuleVersion?: number | null;
  currentSeoRuleVersion?: number;
  scoreHistory?: Array<{ score: ScoreSnapshot; audit: AiVisibilityAudit; seoRuleVersion?: number | null }>;
}
export interface SeoIssue {
  id: number;
  ruleId: string;
  ruleVersion: number;
  group: string;
  severity: string;
  affectedUrl: string | null;
  evidence: Record<string, unknown>;
  recommendation: string;
}
export interface CrawlPage {
  id: number;
  url: string;
  finalUrl: string | null;
  crawlStatus: string;
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  indexable: boolean;
  wordCount: number;
  imageCount: number;
  imagesMissingAlt: number;
  headings: Record<string, string[]>;
  schemaTypes: string[];
  error: string | null;
  pageType?: string | null;
  robotsDirective?: string | null;
}
export interface SeoCrawlerAccess {
  crawler: string;
  owner: string;
  purpose: 'search' | 'ai_search' | 'ai_user' | 'ai_training';
  allowed: boolean;
  rule?: string;
  line?: number;
  group: string[];
}
export interface SeoSitemapSource {
  url: string;
  statusCode?: number;
  kind: 'urlset' | 'sitemapindex' | 'invalid' | 'unreachable' | 'skipped';
  urlCount: number;
  error?: string;
}
/** Site-level crawl facts behind the SEO findings. Null for analyses with no completed crawl. */
export interface SeoSiteSummary {
  score: number | null;
  subScores: Record<string, number> | null;
  /** groups/rules are null for measurements recorded before robots rules were stored. */
  robots: { available: boolean; error: string | null; groups: number | null; rules: number | null };
  sitemap: {
    available: boolean;
    urlCount: number;
    complete: boolean | null;
    declaredInRobots: boolean | null;
    sources: SeoSitemapSource[];
  };
  discoveredPages: number | null;
  pageLimit: number | null;
  checkedLinks: number | null;
  crawlerAccess: SeoCrawlerAccess[] | null;
  crawlerAccessUrl: string | null;
  /** SEO rule version this measurement used; null when it cannot be told. */
  ruleVersion?: number | null;
  currentRuleVersion?: number;
  /** A new analysis would apply newer checks than this measurement used. */
  rulesOutdated?: boolean;
}
export interface VisibilityPrompt {
  id: number;
  prompt: string;
  intent: string;
  persona: string;
  locale: string;
  isGeneric: boolean;
}
export interface CommerceSnapshot {
  id: number;
  score: string;
  itemCount: number;
  validItemCount: number;
  sourceType: string;
  sourceName: string;
  fieldCoverage: Record<string, number>;
  issues: Array<{
    field: string;
    missing: number;
    invalid?: number;
    severity: string;
    message: string;
  }>;
  summary: Record<string, unknown>;
  createdAt: string;
}
export interface AssetVersion {
  version: number;
  title: string;
  content: string;
  actorUserId: number | null;
  createdAt: string;
}
const auditQuery = (auditId?: number) => (auditId ? `?auditId=${auditId}` : '');

export const aiVisibilityApi = {
  updateProject: (
    id: number,
    input: Partial<
      Pick<
        AiVisibilityProject,
        | 'name'
        | 'category'
        | 'scoringProfile'
        | 'country'
        | 'locale'
        | 'targetGeography'
        | 'brandAliases'
        | 'geoPrompts'
      >
    >,
  ) => api.patch<{ project: AiVisibilityProject }>(`/api/ai-visibility/projects/${id}`, input),
  providers: (id: number) =>
    api.get<{ providers: ProviderReadiness[] }>(`/api/ai-visibility/projects/${id}/providers`),
  assignees: (id: number) =>
    api.get<{ members: Array<{ id: number; name: string; email: string }> }>(
      `/api/ai-visibility/projects/${id}/assignees`,
    ),
  assetVersions: (projectId: number, assetId: number) =>
    api.get<{ versions: AssetVersion[] }>(
      `/api/ai-visibility/projects/${projectId}/assets/${assetId}/versions`,
    ),
  editAsset: (
    projectId: number,
    assetId: number,
    input: { version: number; title: string; content: string },
  ) => api.patch(`/api/ai-visibility/projects/${projectId}/assets/${assetId}`, input),
  commerceProducts: (
    id: number,
    options: {
      snapshotId?: number;
      query?: string;
      issuesOnly?: boolean;
      offset?: number;
      limit?: number;
    },
  ) =>
    api.get<{
      available: boolean;
      snapshotId: number | null;
      total: number;
      products: Array<{
        row: number;
        identifier: string;
        title: string;
        valid: boolean;
        issues: string[];
      }>;
    }>(
      `/api/ai-visibility/projects/${id}/commerce/products?${new URLSearchParams(
        Object.entries(options)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      )}`,
    ),
  listProjects: () => api.get<{ projects: AiVisibilityProject[] }>('/api/ai-visibility/projects'),
  listWorkspaces: () =>
    api.get<{ workspaces: AiVisibilityWorkspaceSummary[] }>('/api/ai-visibility/workspaces'),
  createOrganization: (input: {
    name: string;
    whiteLabelDefaults?: AiVisibilityWhiteLabelDefaults;
  }) =>
    api.post<{ organization: { id: number; name: string; slug: string } }>(
      '/api/ai-visibility/organizations',
      input,
    ),
  updateOrganization: (
    organizationId: number,
    input: {
      name?: string;
      whiteLabelDefaults?: AiVisibilityWhiteLabelDefaults;
    },
  ) =>
    api.patch<{ organization: { id: number; name: string } }>(
      `/api/ai-visibility/organizations/${organizationId}`,
      input,
    ),
  updateWorkspace: (
    workspaceId: number,
    input: {
      name?: string;
      organizationId?: number | null;
      kind?: 'private' | 'client';
      whiteLabelDefaults?: AiVisibilityWhiteLabelDefaults;
    },
  ) =>
    api.patch<{ workspace: AiVisibilityWorkspaceSummary['workspace'] }>(
      `/api/ai-visibility/workspaces/${workspaceId}`,
      input,
    ),
  addWorkspaceMember: (
    workspaceId: number,
    input: { email: string; role: Exclude<AiVisibilityWorkspaceRole, 'owner'> },
  ) =>
    api.post<{
      membership: {
        id: number;
        role: AiVisibilityWorkspaceRole;
        status: string;
        email: string;
        name: string;
      };
    }>(`/api/ai-visibility/workspaces/${workspaceId}/members`, input),
  updateWorkspaceMember: (
    workspaceId: number,
    membershipId: number,
    input: {
      role?: Exclude<AiVisibilityWorkspaceRole, 'owner'>;
      status?: 'active' | 'revoked';
    },
  ) =>
    api.patch<{
      membership: {
        id: number;
        role: AiVisibilityWorkspaceRole;
        status: string;
      };
    }>(`/api/ai-visibility/workspaces/${workspaceId}/members/${membershipId}`, input),
  listWebsiteSearches: () =>
    api.get<{
      websites: Array<{
        project: AiVisibilityProject;
        auditCount: number;
        latestAudit: AiVisibilityAudit | null;
        latestScore: ScoreSnapshot | null;
      }>;
    }>('/api/ai-visibility/website-searches'),
  resolveWebsiteSearch: (input: string | WebsiteSearchInput) =>
    api.post<{ project: AiVisibilityProject; created: boolean }>(
      '/api/ai-visibility/website-searches',
      typeof input === 'string' ? { website: input } : input,
    ),
  listBusinessProfiles: () =>
    api.get<{ profiles: AiVisibilityBusinessProfile[] }>('/api/ai-visibility/business-profiles'),
  resolveProject: (businessProfileId?: number | null) =>
    api.post<{
      project: AiVisibilityProject | null;
      profile: AiVisibilityBusinessProfile | null;
      toolkit: { id: number; name: string } | null;
      provisioned: boolean;
      missingWebsite: boolean;
    }>('/api/ai-visibility/projects/resolve', businessProfileId ? { businessProfileId } : {}),
  createProject: (input: {
    name: string;
    domain: string;
    category?: string;
    scoringProfile: AiVisibilityProfile;
    country: string;
    locale: string;
    targetGeography?: string;
    brandAliases?: string[];
  }) => api.post<{ project: AiVisibilityProject }>('/api/ai-visibility/projects', input),
  getProject: (id: number) =>
    api.get<{ project: AiVisibilityProject }>(`/api/ai-visibility/projects/${id}`),
  archiveProject: (id: number) =>
    api.delete<{ project: AiVisibilityProject }>(`/api/ai-visibility/projects/${id}`),
  overview: (id: number, auditId?: number) =>
    api.get<VisibilityOverview>(`/api/ai-visibility/projects/${id}/overview${auditQuery(auditId)}`),
  estimate: (id: number) =>
    api.get<{ estimate: AiVisibilityAuditEstimate }>(
      `/api/ai-visibility/projects/${id}/audits/estimate`,
    ),
  createAudit: (id: number) =>
    api.post<{
      audit: AiVisibilityAudit;
      creditsCharged: number;
      balanceAfter: number;
    }>(`/api/ai-visibility/projects/${id}/audits`),
  listAudits: (id: number) =>
    api.get<{ audits: AiVisibilityAudit[] }>(`/api/ai-visibility/projects/${id}/audits`),
  getAudit: (id: number) =>
    api.get<{ audit: AiVisibilityAudit }>(`/api/ai-visibility/audits/${id}`),
  cancelAudit: (id: number) =>
    api.post<{ audit: AiVisibilityAudit }>(`/api/ai-visibility/audits/${id}/cancel`),
  retryReport: (id: number) =>
    api.post<{ auditId: number; status: string }>(`/api/ai-visibility/audits/${id}/report/retry`),
  seo: (id: number, auditId?: number) =>
    api.get<{
      audit: AiVisibilityAudit | null;
      issues: SeoIssue[];
      pages: CrawlPage[];
      site?: SeoSiteSummary | null;
      /** Findings from older checks that the current checks show were wrong; not listed. */
      withdrawnFindings?: number;
    }>(`/api/ai-visibility/projects/${id}/seo${auditQuery(auditId)}`),
  gsc: (id: number, snapshotId?: number) =>
    api.get<AiVisibilityGscOverview>(
      `/api/ai-visibility/projects/${id}/gsc${snapshotId ? `?snapshotId=${snapshotId}` : ''}`,
    ),
  gscAuthUrl: (id: number) =>
    api.post<{ url: string }>(`/api/ai-visibility/projects/${id}/gsc/auth-url`),
  selectGscProperty: (id: number, propertyUri: string) =>
    api.put(`/api/ai-visibility/projects/${id}/gsc/property`, { propertyUri }),
  syncGsc: (id: number, range?: { startDate: string; endDate: string; compare?: boolean }) =>
    api.post<{ snapshot: GscSnapshot }>(`/api/ai-visibility/projects/${id}/gsc/sync`, range || {}),
  disconnectGsc: (id: number) => api.delete(`/api/ai-visibility/projects/${id}/gsc`),
  prompts: (id: number, kind: 'aeo' | 'geo', auditId?: number) =>
    api.get<{
      audit: AiVisibilityAudit | null;
      prompts: VisibilityPrompt[];
      runs: ProviderPromptRun[];
    }>(`/api/ai-visibility/projects/${id}/${kind}${auditQuery(auditId)}`),
  aeoQuestions: (id: number) =>
    api.get<{
      questions: Array<{
        id: number;
        question: string;
        intent: string;
        targetPage: string | null;
        active: boolean;
      }>;
    }>(`/api/ai-visibility/projects/${id}/aeo/questions`),
  aeoCoverage: (id: number, auditId?: number) =>
    api.get<{
      audit: AiVisibilityAudit | null;
      available: boolean;
      unavailableReason: string | null;
      summary: {
        total: number;
        answered: number;
        partial: number;
        uncovered: number;
      };
      coverage: AeoQuestionCoverage[];
    }>(`/api/ai-visibility/projects/${id}/aeo/coverage${auditQuery(auditId)}`),
  addAeoQuestion: (id: number, input: { question: string; intent: string; targetPage?: string }) =>
    api.post(`/api/ai-visibility/projects/${id}/aeo/questions`, input),
  updateAeoQuestion: (
    projectId: number,
    questionId: number,
    input: {
      question?: string;
      intent?: string;
      targetPage?: string | null;
      active?: boolean;
    },
  ) => api.patch(`/api/ai-visibility/projects/${projectId}/aeo/questions/${questionId}`, input),
  generateAeoAsset: (
    projectId: number,
    questionId: number,
    assetType: 'answer_block' | 'faq_page' | 'research_brief',
  ) =>
    api.post<{ asset: { id: number } }>(
      `/api/ai-visibility/projects/${projectId}/aeo/questions/${questionId}/assets`,
      { assetType },
    ),
  commerce: (id: number) =>
    api.get<{
      status: string;
      score: number | null;
      reason: string | null;
      latestSnapshot: CommerceSnapshot | null;
      snapshots: CommerceSnapshot[];
    }>(`/api/ai-visibility/projects/${id}/commerce`),
  uploadCommerceFeed: (id: number, file: File, mapping?: Record<string, string>) => {
    const form = new FormData();
    form.append('file', file);
    if (mapping) form.append('mapping', JSON.stringify(mapping));
    return api.upload(`/api/ai-visibility/projects/${id}/commerce/feeds`, form);
  },
  syncShopifyCatalog: (id: number) =>
    api.post<{ snapshot: Record<string, unknown> }>(
      `/api/ai-visibility/projects/${id}/commerce/shopify/sync`,
    ),
  syncWooCommerceCatalog: (id: number) =>
    api.post<{ snapshot: Record<string, unknown> }>(
      `/api/ai-visibility/projects/${id}/commerce/woocommerce/sync`,
    ),
  competitors: (id: number) =>
    api.get<{
      competitors: Array<{
        id: number;
        name: string;
        domain: string;
        aliases: string[];
        active: boolean;
      }>;
    }>(`/api/ai-visibility/projects/${id}/competitors`),
  suggestCompetitors: (id: number) =>
    api.post<{
      suggestions: CompetitorSuggestion[];
      sourcesUsed: string[];
      unavailableReason: string | null;
    }>(`/api/ai-visibility/projects/${id}/suggest-competitors`, {}),
  competitorIntelligence: (id: number, auditId?: number) =>
    api.get<{
      audit: AiVisibilityAudit | null;
      available: boolean;
      unavailableReason: string | null;
      intelligence: CompetitorIntelligence;
    }>(`/api/ai-visibility/projects/${id}/competitor-intelligence${auditQuery(auditId)}`),
  generateCompetitorBrief: (projectId: number, competitorId: number, gapKey: string) =>
    api.post<{ asset: { id: number } }>(
      `/api/ai-visibility/projects/${projectId}/competitor-intelligence/briefs`,
      { competitorId, gapKey },
    ),
  addCompetitor: (id: number, input: { name: string; domain: string; aliases?: string[] }) =>
    api.post(`/api/ai-visibility/projects/${id}/competitors`, input),
  lookupCompetitorWebsite: (id: number, name: string) =>
    api.post<CompetitorWebsiteLookup>(
      `/api/ai-visibility/projects/${id}/competitor-website-lookup`,
      { name },
    ),
  updateCompetitor: (
    projectId: number,
    competitorId: number,
    input: {
      name?: string;
      domain?: string;
      aliases?: string[];
      active?: boolean;
    },
  ) => api.patch(`/api/ai-visibility/projects/${projectId}/competitors/${competitorId}`, input),
  recommendations: (id: number, auditId?: number) =>
    api.get<{ recommendations: Recommendation[] }>(
      `/api/ai-visibility/projects/${id}/recommendations${auditQuery(auditId)}`,
    ),
  updateRecommendation: (
    projectId: number,
    recommendationId: number,
    status:
      | Recommendation['status']
      | {
          status?: Recommendation['status'];
          assigneeUserId?: number | null;
          dueDate?: string | null;
          resolutionEvidence?: string | null;
        },
  ) =>
    api.patch(
      `/api/ai-visibility/projects/${projectId}/recommendations/${recommendationId}`,
      typeof status === 'string' ? { status } : status,
    ),
  generateAsset: (projectId: number, recommendationId: number) =>
    api.post<{ asset: { id: number } }>(
      `/api/ai-visibility/projects/${projectId}/recommendations/${recommendationId}/assets`,
    ),
  correctPromptRun: (promptRunId: number, correction: ExtractionCorrection) =>
    api.post(`/api/ai-visibility/prompt-runs/${promptRunId}/corrections`, correction),
  assets: (id: number) =>
    api.get<{ assets: AiVisibilityGeneratedAsset[] }>(`/api/ai-visibility/projects/${id}/assets`),
  assetApprovals: (id: number) =>
    api.get<{ decisions: AiVisibilityAssetApprovalDecision[] }>(
      `/api/ai-visibility/projects/${id}/asset-approvals`,
    ),
  decideAsset: (
    projectId: number,
    generatedAssetLinkId: number,
    assetVersion: number,
    decision: 'approved' | 'rejected',
    comment?: string,
  ) =>
    api.patch(`/api/ai-visibility/projects/${projectId}/assets/${generatedAssetLinkId}/approval`, {
      assetVersion,
      decision,
      comment,
    }),
  cmsConnections: (id: number) =>
    api.get<{ connections: AiVisibilityCmsConnection[] }>(
      `/api/ai-visibility/projects/${id}/cms-connections`,
    ),
  saveCmsConnection: (
    projectId: number,
    input:
      | {
          platform: 'wordpress';
          siteUrl: string;
          username: string;
          applicationPassword: string;
        }
      | {
          platform: 'shopify';
          storeDomain: string;
          accessToken: string;
          blogId?: string;
          authorName?: string;
        },
  ) =>
    api.put<{ connection: AiVisibilityCmsConnection }>(
      `/api/ai-visibility/projects/${projectId}/cms-connections/${input.platform}`,
      input,
    ),
  deleteCmsConnection: (projectId: number, platform: AiVisibilityCmsPlatform) =>
    api.delete(`/api/ai-visibility/projects/${projectId}/cms-connections/${platform}`),
  cmsPublishAttempts: (id: number) =>
    api.get<{ attempts: AiVisibilityCmsPublishAttempt[] }>(
      `/api/ai-visibility/projects/${id}/cms-publish-attempts`,
    ),
  createCmsDraft: (
    projectId: number,
    generatedAssetLinkId: number,
    platform: AiVisibilityCmsPlatform,
    idempotencyKey: string,
    assetVersion: number,
    checkOutcomeOnly = false,
  ) =>
    api.post<{ attempt: AiVisibilityCmsPublishAttempt }>(
      `/api/ai-visibility/projects/${projectId}/assets/${generatedAssetLinkId}/cms-drafts`,
      { platform, idempotencyKey, assetVersion, ...(checkOutcomeOnly ? { checkOutcomeOnly: true } : {}) },
    ),
  alerts: (id: number) =>
    api.get<{ alerts: AiVisibilityAlert[] }>(`/api/ai-visibility/projects/${id}/alerts`),
  acknowledgeAlert: (projectId: number, alertId: number) =>
    api.patch(`/api/ai-visibility/projects/${projectId}/alerts/${alertId}`, {}),
  reports: (id: number) =>
    api.get<{ reports: AiVisibilityReport[] }>(`/api/ai-visibility/projects/${id}/reports`),
  reportDeliveries: (id: number) =>
    api.get<{ deliveries: AiVisibilityReportDelivery[] }>(
      `/api/ai-visibility/projects/${id}/report-deliveries`,
    ),
  sendReportEmail: (auditId: number, recipientEmail: string, idempotencyKey: string) =>
    api.post<{ delivery: AiVisibilityReportDelivery }>(
      `/api/ai-visibility/audits/${auditId}/report-deliveries`,
      { recipientEmail, idempotencyKey },
    ),
  reportShares: (id: number) =>
    api.get<{ shares: AiVisibilityReportShare[] }>(
      `/api/ai-visibility/projects/${id}/report-shares`,
    ),
  createReportShare: (auditId: number, expiresInDays: 1 | 7 | 30 = 7) =>
    api.post<{ share: AiVisibilityReportShare; token: string }>(
      `/api/ai-visibility/audits/${auditId}/report-shares`,
      { expiresInDays },
    ),
  revokeReportShare: (projectId: number, shareId: number) =>
    api.delete<{ share: AiVisibilityReportShare }>(
      `/api/ai-visibility/projects/${projectId}/report-shares/${shareId}`,
    ),
  reportUrl: (auditId: number) => buildApiUrl(`/api/ai-visibility/audits/${auditId}/report`),
  reportEvidenceUrl: (auditId: number) =>
    buildApiUrl(`/api/ai-visibility/audits/${auditId}/export.json`),
  reportCsvUrl: (auditId: number) => buildApiUrl(`/api/ai-visibility/audits/${auditId}/export.csv`),
  sharedReportUrl: (token: string) => buildApiUrl(`/api/ai-visibility/shared-reports/${token}`),
  updateMonitoring: (id: number, enabled: boolean) =>
    api.patch(`/api/ai-visibility/projects/${id}/monitoring`, { enabled }),
};
