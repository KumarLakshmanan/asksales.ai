import type { PillarStatus } from '../../models/aiVisibility/schema.js';

export type ReportPillarKey = 'seo' | 'aeo' | 'geo' | 'commerce';

export interface ReportMethodologyInput {
  generatedAt?: string;
  correctionRevision?: number;
  correctedAt?: Date | string | null;
  scoringProfile: string;
  scoringVersion: number;
  inputFingerprint: string;
  overallScore: number;
  pillarStatuses: Record<string, PillarStatus>;
  pillarScores: Record<ReportPillarKey, number | null>;
  normalizedWeights?: Record<string, number>;
  completedBrandPages: number;
  failedBrandPages: number;
  seoIssues: number;
  aeoQuestions: number;
  providerRuns: Array<{
    provider: string;
    model: string;
    fidelity: string;
    status: string;
    citations: Array<{ url: string; title?: string }>;
    brandMentioned: boolean | null;
    extractionStatus: string;
    error: string | null;
    extractionError: string | null;
  }>;
  trackedCompetitors: number;
  competitorSnapshots: number;
  commerceSnapshot: null | {
    sourceType: string;
    sourceName: string;
    itemCount: number;
    validItemCount: number;
    inputFingerprint: string;
  };
}

export interface AiVisibilityReportMethodology {
  methodologyVersion: 2;
  generatedAt: string;
  scoring: {
    profile: string;
    version: number;
    inputFingerprint: string;
    overallScore: number;
    normalizedWeights: Record<string, number>;
  };
  pillars: Array<{
    key: ReportPillarKey;
    label: string;
    status: PillarStatus;
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
}

const formulas: Record<ReportPillarKey, string> = {
  seo: 'Versioned deterministic crawl rules across technical, on-page, content, internal-linking, schema, and indexability signals.',
  aeo: '70% verified question coverage and 30% answer-ready page structure when editable AEO questions exist; otherwise structural answer readiness.',
  geo: '60% brand mention rate, 25% top-three recommendation rate, and 15% audited-domain citation rate across schema-validated provider answers.',
  commerce:
    '80% required catalog-field validity and 20% recommended commerce-signal validity from the latest real catalog snapshot.',
};

function unique(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim()),
    ),
  ];
}

function pillarReason(
  key: ReportPillarKey,
  status: PillarStatus,
  input: ReportMethodologyInput,
): string {
  if (status === 'scored') return 'Measured from the verified inputs listed in this report.';
  if (key === 'commerce')
    return 'Not applicable for this analysis because no real CSV, JSON, XML, or Shopify catalog snapshot is connected.';
  if (key === 'geo') {
    const successful = input.providerRuns.filter((run) => run.status === 'completed').length;
    if (!successful)
      return 'Unavailable because no live provider/API observation returned an answer.';
    return 'Unavailable because returned provider answers could not be schema-validated for brand visibility metrics.';
  }
  if (key === 'seo') return 'Unavailable because no brand page completed the crawl.';
  return 'Unavailable because no completed brand page was available for answer-readiness analysis.';
}

export function buildReportMethodology(
  input: ReportMethodologyInput,
): AiVisibilityReportMethodology {
  const successfulRuns = input.providerRuns.filter((run) => run.status === 'completed');
  const extractedRuns = successfulRuns.filter((run) =>
    ['completed', 'corrected', 'cached'].includes(run.extractionStatus),
  );
  const providers = unique(input.providerRuns.map((run) => run.provider)).map((provider) => {
    const runs = input.providerRuns.filter((run) => run.provider === provider);
    const completed = runs.filter((run) => run.status === 'completed');
    const extracted = completed.filter((run) =>
      ['completed', 'corrected', 'cached'].includes(run.extractionStatus),
    );
    return {
      provider,
      models: unique(runs.map((run) => run.model)),
      fidelity: unique(runs.map((run) => run.fidelity)),
      observations: runs.filter((run) => run.status !== 'excluded').length,
      successful: completed.length,
      failed: runs.filter((run) => ['failed', 'skipped'].includes(run.status)).length,
      extracted: extracted.length,
      citations: completed.reduce((sum, run) => sum + run.citations.length, 0),
      failureReasons: unique(runs.flatMap((run) => [run.error, run.extractionError])).slice(0, 10),
    };
  });
  const citationCount = successfulRuns.reduce((sum, run) => sum + run.citations.length, 0);
  const extractedMentions = extractedRuns.filter((run) => run.brandMentioned === true).length;
  const competitorStatus =
    input.trackedCompetitors === 0
      ? 'not_applicable'
      : extractedRuns.length === 0
        ? 'unavailable'
        : 'measured';
  const competitorReason =
    competitorStatus === 'not_applicable'
      ? 'No competitors were tracked for this analysis.'
      : competitorStatus === 'unavailable'
        ? 'Competitors are tracked, but no provider answer was successfully extracted for comparison.'
        : 'Calculated from tracked competitors, extracted provider answers, citations, and verified crawled-page coverage.';
  const pillarKeys: ReportPillarKey[] = ['seo', 'aeo', 'geo', 'commerce'];
  return {
    methodologyVersion: 2,
    generatedAt: input.generatedAt || new Date().toISOString(),
    scoring: {
      profile: input.scoringProfile,
      version: input.scoringVersion,
      inputFingerprint: input.inputFingerprint,
      overallScore: input.overallScore,
      normalizedWeights: input.normalizedWeights || {},
    },
    pillars: pillarKeys.map((key) => {
      const status = input.pillarStatuses[key] || 'unavailable';
      return {
        key,
        label: key.toUpperCase(),
        status,
        score: input.pillarScores[key],
        reason: pillarReason(key, status, input),
        formula:
          key === 'seo' && input.scoringVersion >= 2
            ? 'Version 2: each of six group scores is 100 minus average page-level severity penalties across sampled pages, minus site-wide penalties, floored at zero. SEO is the mean of group scores. Informational issues have no score penalty.'
            : formulas[key],
      };
    }),
    coverage: {
      completedBrandPages: input.completedBrandPages,
      failedBrandPages: input.failedBrandPages,
      seoIssues: input.seoIssues,
      aeoQuestions: input.aeoQuestions,
      providerObservations: input.providerRuns.filter((run) => run.status !== 'excluded').length,
      successfulProviderAnswers: successfulRuns.length,
      extractedProviderAnswers: extractedRuns.length,
      citations: citationCount,
      trackedCompetitors: input.trackedCompetitors,
      competitorSnapshots: input.competitorSnapshots,
    },
    providers,
    competitors: {
      status: competitorStatus,
      tracked: input.trackedCompetitors,
      analyzed: input.competitorSnapshots,
      extractedMentions,
      reason: competitorReason,
    },
    commerce: input.commerceSnapshot
      ? {
          status: 'measured',
          sourceType: input.commerceSnapshot.sourceType,
          sourceName: input.commerceSnapshot.sourceName,
          itemCount: input.commerceSnapshot.itemCount,
          validItemCount: input.commerceSnapshot.validItemCount,
          inputFingerprint: input.commerceSnapshot.inputFingerprint,
          reason: 'Measured from the latest real catalog snapshot.',
        }
      : {
          status: 'not_applicable',
          sourceType: null,
          sourceName: null,
          itemCount: 0,
          validItemCount: 0,
          inputFingerprint: null,
          reason:
            'No real product catalog is connected. Upload CSV, JSON, or XML data, or sync Shopify to enable Commerce scoring.',
        },
    disclosures: [
      'AI measurements are provider/API observations and do not claim to reproduce a provider consumer application exactly.',
      'Failed provider and crawl requests remain visible and are never replaced with simulated or synthetic measurements.',
      'All SEO findings and action-plan entries are included; scoring reflects a sampled crawl, not a whole-site certification.',
      ...(input.correctionRevision
        ? [
            `Manual evidence correction revision ${input.correctionRevision}, saved ${input.correctedAt}. Scores remain immutable historical snapshots; observation evidence in this PDF includes corrections available when the PDF was generated.`,
          ]
        : []),
      'Unavailable and not-applicable pillars are excluded before the remaining scoring weights are re-normalized.',
    ],
  };
}

export function reportPillarDisplay(
  pillar: AiVisibilityReportMethodology['pillars'][number],
): string {
  if (pillar.status === 'scored' && pillar.score !== null)
    return String(Math.round(pillar.score * 100) / 100);
  return pillar.status === 'not_applicable' ? 'Not applicable' : 'Unavailable';
}
