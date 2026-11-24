export interface ReportExportInput {
  audit: {
    correctionRevision?: number;
    correctedAt?: Date | string | null;
    id: number;
    status: string;
    trigger: string;
    actualCredits: string | number;
    createdAt: Date | string;
    completedAt: Date | string | null;
  };
  project: { name: string; domain: string; scoringProfile: string };
  score: null | {
    overallScore: string | number;
    seoScore: string | number | null;
    aeoScore: string | number | null;
    geoScore: string | number | null;
    commerceScore: string | number | null;
    pillarStatuses: Record<string, string>;
    inputFingerprint: string;
    scoringVersion: number;
  };
  issues: Array<{
    ruleId: string;
    group: string;
    severity: string;
    affectedUrl: string | null;
    recommendation: string;
    evidence: unknown;
  }>;
  promptRuns: Array<{
    provider: string;
    model: string;
    status: string;
    fidelity: string;
    brandMentioned: boolean | null;
    brandRank: number | null;
    sentiment: string | null;
    citations: unknown;
    extractionStatus: string;
    error: string | null;
    extractionError: string | null;
    promptText: string;
    answer?: string | null;
  }>;
  recommendations: Array<{
    module: string;
    title: string;
    status: string;
    severity: string;
    impact: string;
    effort: string;
    affectedUrl: string | null;
    description: string;
  }>;
  competitors: Array<{
    name: string;
    domain: string;
    metrics: unknown;
    contentGaps: unknown;
  }>;
}

const COLUMNS = [
  'record_type',
  'section',
  'name',
  'status',
  'value',
  'provider',
  'url',
  'severity',
  'details',
] as const;
type ExportRow = Record<(typeof COLUMNS)[number], unknown>;

function safeSpreadsheetText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  return `"${safeSpreadsheetText(value).replaceAll('"', '""')}"`;
}

function details(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable evidence]';
  }
}

function row(input: Partial<ExportRow>): ExportRow {
  return Object.fromEntries(COLUMNS.map((column) => [column, input[column] ?? ''])) as ExportRow;
}

export function buildAiVisibilityCsv(input: ReportExportInput): string {
  const rows: ExportRow[] = [
    row({
      record_type: 'audit',
      section: 'summary',
      name: 'Audit ID',
      status: input.audit.status,
      value: input.audit.id,
      details: `Trigger: ${input.audit.trigger}`,
    }),
    row({
      record_type: 'audit',
      section: 'summary',
      name: 'Website',
      value: input.project.name,
      url: input.project.domain,
      details: `Scoring profile: ${input.project.scoringProfile}`,
    }),
    row({
      record_type: 'audit',
      section: 'summary',
      name: 'Actual wallet credits',
      value: input.audit.actualCredits,
    }),
    row({
      record_type: 'audit',
      section: 'summary',
      name: 'Started',
      value: new Date(input.audit.createdAt).toISOString(),
    }),
    row({
      record_type: 'audit',
      section: 'summary',
      name: 'Completed',
      value: input.audit.completedAt ? new Date(input.audit.completedAt).toISOString() : '',
    }),
  ];

  rows.push(
    row({
      record_type: 'audit',
      section: 'corrections',
      name: 'Correction policy',
      value: input.audit.correctionRevision || 0,
      details: `Scores are immutable historical snapshots. Observations include manual corrections as of ${input.audit.correctedAt || 'none'}. Raw provider answers remain unchanged.`,
    }),
  );
  if (input.score) {
    for (const [name, value, status] of [
      ['Overall', input.score.overallScore, 'scored'],
      ['SEO', input.score.seoScore, input.score.pillarStatuses.seo],
      ['AEO', input.score.aeoScore, input.score.pillarStatuses.aeo],
      ['GEO', input.score.geoScore, input.score.pillarStatuses.geo],
      ['Commerce', input.score.commerceScore, input.score.pillarStatuses.commerce],
    ] as const) {
      const resolvedStatus = status || 'unavailable';
      const statusReason =
        resolvedStatus === 'scored'
          ? 'Measured from verified inputs.'
          : name === 'Commerce'
            ? 'No real catalog snapshot was connected for this analysis.'
            : name === 'GEO'
              ? input.promptRuns.some((run) => run.status === 'completed')
                ? 'Provider answers could not be schema-validated.'
                : 'No live provider/API observation returned an answer.'
              : 'Required verified crawl inputs were unavailable.';
      rows.push(
        row({
          record_type: 'score',
          section: 'scores',
          name,
          status: resolvedStatus,
          value: value ?? '',
          details: statusReason,
        }),
      );
    }
    rows.push(
      row({
        record_type: 'score',
        section: 'methodology',
        name: 'Input fingerprint',
        value: input.score.inputFingerprint,
        details: `Scoring version: ${input.score.scoringVersion}`,
      }),
    );
  }

  for (const issue of input.issues)
    rows.push(
      row({
        record_type: 'seo_issue',
        section: issue.group,
        name: issue.ruleId,
        status: 'open',
        url: issue.affectedUrl,
        severity: issue.severity,
        details: `${issue.recommendation}\nEvidence: ${details(issue.evidence)}`,
      }),
    );
  for (const run of input.promptRuns)
    rows.push(
      row({
        record_type: 'provider_observation',
        section: 'geo',
        name: run.promptText,
        status: run.status,
        value:
          run.brandMentioned === null
            ? ''
            : run.brandMentioned
              ? `Brand mentioned${run.brandRank ? ` at #${run.brandRank}` : ''}`
              : 'Brand not mentioned',
        provider: `${run.provider}/${run.model}`,
        details: details({
          rawAnswer: run.answer,
          fidelity: run.fidelity,
          sentiment: run.sentiment,
          extractionStatus: run.extractionStatus,
          citations: run.citations,
          providerError: run.error,
          extractionError: run.extractionError,
        }),
      }),
    );
  for (const recommendation of input.recommendations)
    rows.push(
      row({
        record_type: 'recommendation',
        section: recommendation.module,
        name: recommendation.title,
        status: recommendation.status,
        value: `${recommendation.impact} impact / ${recommendation.effort} effort`,
        url: recommendation.affectedUrl,
        severity: recommendation.severity,
        details: recommendation.description,
      }),
    );
  for (const competitor of input.competitors)
    rows.push(
      row({
        record_type: 'competitor',
        section: 'competitive_visibility',
        name: competitor.name,
        url: competitor.domain,
        details: details({
          metrics: competitor.metrics,
          contentGaps: competitor.contentGaps,
        }),
      }),
    );
  if (!input.competitors.length)
    rows.push(
      row({
        record_type: 'competitor_status',
        section: 'competitive_visibility',
        name: 'Competitor analysis',
        status: 'not_measured',
        details:
          'No competitor snapshot was generated. Configure a verified competitor and complete an analysis to enable comparison metrics.',
      }),
    );

  return `${COLUMNS.map(csvCell).join(',')}\r\n${rows.map((item) => COLUMNS.map((column) => csvCell(item[column])).join(',')).join('\r\n')}\r\n`;
}
