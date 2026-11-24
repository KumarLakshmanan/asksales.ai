export interface VisibilityAlertCandidate {
  type: 'score_decline' | 'mention_loss' | 'schema_regression' | 'new_competitor' | 'unresolved_high_impact_fixes';
  severity: 'medium' | 'high';
  title: string;
  message: string;
  evidence: Record<string, unknown>;
}

interface VisibilityRun {
  provider?: string;
  brandMentioned: boolean | null;
  competitors: string[];
}

/**
 * Answers from AI engines asked in both analyses. When an engine is added (or drops out),
 * its answers would otherwise read as more mentions, fewer mentions or "new" competitors.
 */
function sharedEngineRuns(current: VisibilityRun[], previous: VisibilityRun[]) {
  const before = new Set(previous.map((run) => run.provider));
  const now = new Set(current.map((run) => run.provider));
  return {
    current: current.filter((run) => before.has(run.provider)),
    previous: previous.filter((run) => now.has(run.provider)),
  };
}

interface VisibilityIssue {
  ruleId: string;
  /** SEO rule-set version; a different version means the findings were produced by different checks. */
  ruleVersion?: number;
  affectedUrl?: string | null;
}

function pageKey(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return value;
  }
}

/**
 * Pages crawled in both analyses. Two analyses that sampled mostly different pages are not
 * comparable: more pages means more findings, which would read as a regression.
 */
function sharedPages(current?: string[], previous?: string[]) {
  if (!current?.length || !previous?.length) return null;
  const before = new Set(previous.map(pageKey));
  const now = new Set(current.map(pageKey));
  const shared = new Set([...now].filter((key) => before.has(key)));
  return { shared, comparable: shared.size >= Math.max(now.size, before.size) / 2 };
}

/** Findings from different rule versions are not comparable: new checks would read as regressions. */
function sameRuleVersions(current: VisibilityIssue[], previous: VisibilityIssue[]): boolean {
  const versions = (issues: VisibilityIssue[]) =>
    new Set(issues.map((issue) => issue.ruleVersion).filter((value): value is number => typeof value === 'number'));
  const [a, b] = [versions(current), versions(previous)];
  if (!a.size || !b.size) return true;
  return a.size === b.size && [...a].every((value) => b.has(value));
}

interface VisibilityRecommendation {
  id: number;
  title: string;
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function deriveVisibilityAlerts(input: {
  currentScore?: number | null;
  previousScore?: number | null;
  currentRuns: VisibilityRun[];
  previousRuns?: VisibilityRun[];
  currentIssues: VisibilityIssue[];
  previousIssues?: VisibilityIssue[];
  highImpactRecommendations: VisibilityRecommendation[];
  auditedNames: string[];
  hasPreviousAudit: boolean;
  /** Brand pages crawled in each analysis, to compare like with like. */
  currentPageUrls?: string[];
  previousPageUrls?: string[];
}): VisibilityAlertCandidate[] {
  const alerts: VisibilityAlertCandidate[] = [];
  if (input.highImpactRecommendations.length) {
    alerts.push({
      type: 'unresolved_high_impact_fixes',
      severity: 'high',
      title: 'High-impact fixes need attention',
      message: `${input.highImpactRecommendations.length} high-impact recommendation${input.highImpactRecommendations.length === 1 ? '' : 's'} remain open after this analysis.`,
      evidence: {
        count: input.highImpactRecommendations.length,
        recommendationIds: input.highImpactRecommendations.slice(0, 20).map((item) => item.id),
        titles: input.highImpactRecommendations.slice(0, 5).map((item) => item.title),
      },
    });
  }
  if (!input.hasPreviousAudit) return alerts;
  const pages = sharedPages(input.currentPageUrls, input.previousPageUrls);
  const comparableSeo =
    sameRuleVersions(input.currentIssues, input.previousIssues || []) && (pages?.comparable ?? true);
  // Schema findings are compared only on pages both analyses crawled (and site-wide findings).
  const onSharedPages = (issue: VisibilityIssue) =>
    !pages || !issue.affectedUrl || pages.shared.has(pageKey(issue.affectedUrl));

  if (comparableSeo && input.currentScore !== null && input.currentScore !== undefined && input.previousScore !== null && input.previousScore !== undefined && input.currentScore <= input.previousScore - 8) {
    alerts.push({ type: 'score_decline', severity: 'high', title: 'AI Visibility score declined', message: `Overall score declined from ${input.previousScore} to ${input.currentScore}.`, evidence: { previous: input.previousScore, current: input.currentScore, threshold: 8 } });
  }
  const runs = sharedEngineRuns(input.currentRuns, input.previousRuns || []);
  const currentMentions = runs.current.filter((run) => run.brandMentioned).length;
  const previousMentions = runs.previous.filter((run) => run.brandMentioned).length;
  if (previousMentions > 0 && currentMentions < previousMentions) {
    alerts.push({ type: 'mention_loss', severity: 'medium', title: 'AI answer mentions declined', message: `Verified mentions decreased from ${previousMentions} to ${currentMentions}.`, evidence: { previous: previousMentions, current: currentMentions } });
  }
  const currentSchemaIssues = input.currentIssues.filter((issue) => issue.ruleId.startsWith('schema.') && onSharedPages(issue)).length;
  const previousSchemaIssues = (input.previousIssues || []).filter((issue) => issue.ruleId.startsWith('schema.') && onSharedPages(issue)).length;
  if (comparableSeo && currentSchemaIssues > previousSchemaIssues) {
    alerts.push({ type: 'schema_regression', severity: 'high', title: 'Structured-data coverage regressed', message: `Verified schema issues increased from ${previousSchemaIssues} to ${currentSchemaIssues}.`, evidence: { previous: previousSchemaIssues, current: currentSchemaIssues } });
  }
  const auditedNames = new Set(input.auditedNames.map(normalizedName).filter(Boolean));
  const previousCompetitors = new Set(runs.previous.flatMap((run) => run.competitors).map(normalizedName).filter(Boolean));
  const currentCompetitorNames = new Map<string, string>();
  for (const competitor of runs.current.flatMap((run) => run.competitors)) {
    const normalized = normalizedName(competitor);
    if (normalized && !auditedNames.has(normalized) && !previousCompetitors.has(normalized)) currentCompetitorNames.set(normalized, competitor.trim());
  }
  const newCompetitors = [...currentCompetitorNames.values()].slice(0, 20);
  if (newCompetitors.length) {
    alerts.push({ type: 'new_competitor', severity: 'medium', title: 'New competitors appeared in AI answers', message: `${newCompetitors.length} new competitor${newCompetitors.length === 1 ? '' : 's'} appeared in schema-validated provider observations.`, evidence: { competitors: newCompetitors } });
  }
  return alerts;
}
