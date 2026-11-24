'use client';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { LoadingState } from '@/components/ui/loading-state';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import {
  type AiVisibilityAudit,
  type AiVisibilityProject,
  type ScoreSnapshot,
} from '@/lib/ai-visibility';
import {
  SearchCheck,
} from 'lucide-react';

export type AiVisibilityView =
  | 'overview'
  | 'seo'
  | 'aeo'
  | 'geo'
  | 'commerce'
  | 'competitors'
  | 'fixes'
  | 'assets'
  | 'reports';

// AI Visibility statuses and severities the shared status map doesn't cover.
const aiVisibilityStatusTones: Record<string, StatusTone> = {
  critical: 'danger',
  high: 'warning',
  warning: 'warning',
  completed_with_warnings: 'warning',
  uncovered: 'warning',
  scored: 'success',
  answered: 'success',
  info: 'info',
};

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'ChatGPT (OpenAI)',
  gemini: 'Gemini (Google)',
  perplexity: 'Perplexity',
  claude: 'Claude (Anthropic)',
};

/** The AI engine's product name, as people know it, for a stored provider id. */
export function providerDisplayName(provider: string) {
  return PROVIDER_NAMES[provider] || provider;
}

export function statusBadge(status: string) {
  return <StatusBadge status={status} toneOverrides={aiVisibilityStatusTones} />;
}

export function formatScore(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

export function websiteHost(domain: string) {
  try {
    return new URL(domain).hostname;
  } catch {
    return domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
}

/** Page titles. The tabs and the content explain each page, so there is no description line. */
export const VIEW_COPY: Record<AiVisibilityView, { title: string }> = {
  overview: { title: 'Visibility overview' },
  seo: { title: 'SEO health' },
  aeo: { title: 'AEO coverage' },
  geo: { title: 'GEO observations' },
  commerce: { title: 'Commerce readiness' },
  competitors: { title: 'Competitors' },
  fixes: { title: 'Prioritized fixes' },
  assets: { title: 'Generated assets' },
  reports: { title: 'Reports' },
};

export const SEO_RULE_LABELS: Record<string, string> = {
  'crawl.page_unavailable': 'Page could not be crawled',
  'metadata.missing_title': 'Missing page title',
  'metadata.title_length': 'Page title length',
  'metadata.missing_description': 'Missing meta description',
  'headings.missing_h1': 'Missing primary heading',
  'headings.multiple_h1': 'Multiple primary headings',
  'content.thin': 'Limited page content',
  'content.duplicate': 'Repeated page content',
  'canonical.missing': 'Missing canonical URL',
  'canonical.mismatch': 'Canonical points to another page',
  'indexability.noindex': 'Page excluded from indexing',
  'images.missing_alt': 'Images missing alt text',
  'schema.missing': 'No structured data detected',
  'links.no_internal_links': 'No internal links detected',
  'links.orphan_page': 'No inbound links in this crawl',
  'redirect.chain': 'Page redirect chain',
  'site.robots_unavailable': 'Robots policy unavailable',
  'site.sitemap_unavailable': 'Sitemap unavailable',
  'links.broken': 'Broken links',
  'links.redirecting': 'Redirecting links',
  'links.redirect_chain': 'Link redirect chains',
  'links.unverified': 'Links could not be verified',
  'schema.invalid_json_ld': 'Invalid structured data',
  'sitemap.noindex_url': 'Noindexed URL in sitemap',
  'sitemap.missing_indexable_page': 'Indexable page missing from sitemap',
  'robots.disallowed_page': 'Page blocked by robots.txt',
  'robots.ai_crawler_blocked': 'AI crawlers blocked by robots.txt',
  'metadata.description_length': 'Meta description length',
  'metadata.duplicate_title': 'Title reused on other pages',
  'metadata.duplicate_description': 'Meta description reused on other pages',
  'schema.incomplete': 'Structured data missing key properties',
  'sitemap.redirecting_url': 'Sitemap URL redirects',
  'sitemap.non_canonical_url': 'Non-canonical URL in sitemap',
  'sitemap.error_url': 'Sitemap URL returns an error',
  'site.sitemap_partial': 'Some sitemap files unreadable',
  'site.sitemap_not_in_robots': 'Sitemap not listed in robots.txt',
};

export const SEO_GROUP_LABELS: Record<string, string> = {
  technical: 'Technical',
  on_page: 'On-page',
  content: 'Content',
  internal_linking: 'Internal linking',
  schema: 'Structured data',
  indexability: 'Indexability',
};

export function seoRuleLabel(ruleId: unknown) {
  const value = String(ruleId || 'SEO finding');
  return SEO_RULE_LABELS[value] || value.replaceAll('.', ' · ').replaceAll('_', ' ');
}

/**
 * Readable title for a fix. SEO fixes from older analyses have no evidence.ruleId and a
 * title generated from the rule id ("headings · missing h1"); recover the rule from it.
 */
export function recommendationTitle(item: {
  module: string;
  title: string;
  evidence?: Record<string, unknown> | null;
}) {
  if (item.module !== 'seo') return item.title;
  const stored = item.evidence?.ruleId;
  const ruleId =
    typeof stored === 'string' && stored
      ? stored
      : /^[a-z0-9 ]+( · [a-z0-9 ]+)+$/.test(item.title)
        ? item.title
            .split(' · ')
            .map((part) => part.trim().replaceAll(' ', '_'))
            .join('.')
        : null;
  return ruleId ? seoRuleLabel(ruleId) : item.title;
}

export function scoreState(
  label: string,
  value: string | number | null | undefined,
  pillarStatus: string | undefined,
  auditStatus: string | undefined,
) {
  const score = formatScore(value);
  if (score !== null)
    return {
      value: String(score),
      // A number already says it was scored; only an unusual status needs a note.
      note: pillarStatus && pillarStatus !== 'scored' ? pillarStatus.replaceAll('_', ' ') : '',
    };
  if (pillarStatus === 'not_applicable')
    return {
      value: '—',
      note:
        label === 'Commerce'
          ? 'Add a product feed to enable this score'
          : 'This score does not apply',
    };
  if (auditStatus === 'queued' || auditStatus === 'running')
    return { value: '…', note: 'Analysis in progress' };
  if (auditStatus === 'completed' || auditStatus === 'completed_with_warnings')
    return { value: '—', note: 'This measurement could not be verified' };
  if (auditStatus === 'failed') return { value: '—', note: 'The latest analysis did not complete' };
  return { value: '—', note: 'Analysis has not run yet' };
}

export type WebsiteSummary = {
  project: AiVisibilityProject;
  auditCount: number;
  latestAudit: AiVisibilityAudit | null;
  latestScore: ScoreSnapshot | null;
};

export const WEBSITE_TABS: Array<{ view: AiVisibilityView; label: string }> = [
  { view: 'overview', label: 'Overview' },
  { view: 'seo', label: 'SEO' },
  { view: 'aeo', label: 'AEO' },
  { view: 'geo', label: 'GEO' },
  { view: 'commerce', label: 'Commerce' },
  { view: 'competitors', label: 'Competitors' },
  { view: 'fixes', label: 'Fixes' },
  { view: 'assets', label: 'Assets' },
  { view: 'reports', label: 'Reports' },
];

/**
 * Commerce checks a product catalog, which only an online store has. It counts toward the
 * score only for the "ecommerce" business type, so other sites see it only once a catalog
 * has been measured.
 */
export function showsCommerce(
  project: Pick<AiVisibilityProject, 'scoringProfile'>,
  score?: Pick<ScoreSnapshot, 'pillarStatuses'> | null,
) {
  return project.scoringProfile === 'ecommerce' || score?.pillarStatuses?.commerce === 'scored';
}

export const BUSINESS_TYPES: Array<{ value: AiVisibilityProject['scoringProfile']; label: string }> = [
  { value: 'ecommerce', label: 'Online store (sells products on the website)' },
  { value: 'local_business', label: 'Local business (visited or booked locally)' },
  { value: 'b2b_saas', label: 'Software or B2B services' },
  { value: 'general', label: 'Other business' },
];

export function websiteWorkspacePath(projectId: number, view: AiVisibilityView = 'overview') {
  const base = `/dashboard/ai-visibility/websites/${projectId}`;
  return view === 'overview' ? base : `${base}/${view}`;
}

export function safeCitationUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function Loading() {
  return (
    <LoadingState className="min-h-64 py-0" label="Loading AI Visibility data" />
  );
}
export function Empty({ message }: { message: string }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
        <SearchCheck className="h-4 w-4" />
      </span>
      {message}
    </div>
  );
}
export function InlineError({
  message,
  onRetry,
  title = 'This section could not be loaded',
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Callout
      tone="danger"
      className="min-h-24"
      title={title}
      actions={
        onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )
      }
    >
      {message}
    </Callout>
  );
}
