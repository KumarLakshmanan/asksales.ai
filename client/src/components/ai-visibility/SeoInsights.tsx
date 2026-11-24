'use client';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  CrawlPage,
  SeoCrawlerAccess,
  SeoIssue,
  SeoSiteSummary,
  SeoSitemapSource,
} from '@/lib/ai-visibility';
import { cn } from '@/lib/utils';
import {
  Bot,
  CircleAlert,
  CircleArrowDown,
  CircleCheck,
  CircleX,
  FileCode2,
  Gauge,
  Info,
  Network,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { SEO_GROUP_LABELS, seoRuleLabel } from './workspace-ui';

/*
 * Colour roles. Severity uses the fixed status palette (critical / serious / warning)
 * plus the sequential blue for "low" and neutral ink for "informational"; every
 * colour is paired with an icon and a text label, so colour never carries meaning alone.
 * Score bars use one hue (magnitude). Text always stays in foreground / muted ink.
 */
export const SEVERITY_META: Record<
  string,
  { label: string; fill: string; icon: LucideIcon; iconClass: string }
> = {
  critical: {
    label: 'Critical',
    fill: 'bg-[#d03b3b]',
    icon: OctagonAlert,
    iconClass: 'text-[#d03b3b]',
  },
  high: {
    label: 'High',
    fill: 'bg-[#ec835a]',
    icon: TriangleAlert,
    iconClass: 'text-[#c4582f] dark:text-[#ec835a]',
  },
  medium: {
    label: 'Medium',
    fill: 'bg-[#fab219]',
    icon: CircleAlert,
    iconClass: 'text-[#a8720a] dark:text-[#fab219]',
  },
  low: {
    label: 'Low',
    fill: 'bg-[#2a78d6] dark:bg-[#3987e5]',
    icon: CircleArrowDown,
    iconClass: 'text-[#2a78d6] dark:text-[#3987e5]',
  },
  info: {
    label: 'Informational',
    fill: 'bg-muted-foreground/45',
    icon: Info,
    iconClass: 'text-muted-foreground',
  },
};
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

const SCORE_FILL = 'bg-[#2a78d6] dark:bg-[#3987e5]';

export function scoreBand(score: number) {
  if (score >= 80)
    return { label: 'Healthy', stroke: '#0ca30c', icon: CircleCheck, iconClass: 'text-[#0a8a0a] dark:text-[#0ca30c]' };
  if (score >= 50)
    return { label: 'Needs work', stroke: '#fab219', icon: CircleAlert, iconClass: 'text-[#a8720a] dark:text-[#fab219]' };
  return { label: 'Poor', stroke: '#d03b3b', icon: OctagonAlert, iconClass: 'text-[#d03b3b]' };
}

function Hover({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip delayDuration={80}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

function SectionTitle({ icon: Icon, children, hint }: { icon: LucideIcon; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <h2 className="inline-flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        {children}
      </h2>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** Headline score: a ring meter whose colour and label come from the score band. */
export function ScoreHero({
  score,
  pages,
  issues,
  site,
}: {
  score: number | null;
  pages: CrawlPage[];
  issues: SeoIssue[];
  site: SeoSiteSummary | null | undefined;
}) {
  const crawled = pages.filter((page) => page.crawlStatus === 'completed').length;
  const affected = new Set(issues.map((item) => item.affectedUrl).filter(Boolean)).size;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const band = score === null ? null : scoreBand(score);
  const BandIcon = band?.icon;
  return (
    <Card className="h-full overflow-hidden">
      <CardContent className="flex h-full flex-col gap-5 p-6">
        <SectionTitle icon={Gauge}>SEO score</SectionTitle>
        <div className="flex flex-1 items-center gap-6">
          <div className="relative h-32 w-32 shrink-0">
            <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" role="img" aria-label={score === null ? 'SEO score not available' : `SEO score ${score} out of 100`}>
              <circle cx="60" cy="60" r={radius} fill="none" className="stroke-muted" strokeWidth="10" />
              {score !== null && band && (
                <circle
                  cx="60"
                  cy="60"
                  r={radius}
                  fill="none"
                  stroke={band.stroke}
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray={`${(Math.max(score, 1) / 100) * circumference} ${circumference}`}
                  className="transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
                />
              )}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-4xl font-semibold tracking-tight">{score ?? '—'}</span>
              <span className="text-[11px] text-muted-foreground">of 100</span>
            </div>
          </div>
          <div className="min-w-0 space-y-2">
            {band && BandIcon ? (
              <p className="inline-flex items-center gap-1.5 text-sm font-medium">
                <BandIcon className={cn('h-4 w-4', band.iconClass)} aria-hidden />
                {band.label}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Score unavailable for this analysis</p>
            )}
          </div>
        </div>
        <dl className="mt-auto grid grid-cols-3 gap-3 border-t pt-4 text-xs text-muted-foreground">
          <div>
            <dt>Pages crawled</dt>
            <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
              {crawled}
              <span className="text-xs font-normal text-muted-foreground">/{pages.length}</span>
            </dd>
            {Boolean(site?.discoveredPages) && (
              <dd className="mt-0.5">{site?.discoveredPages?.toLocaleString()} found on the site</dd>
            )}
          </div>
          <div>
            <dt>Pages with findings</dt>
            <dd className="mt-1 font-mono text-lg font-semibold text-foreground">{affected}</dd>
          </div>
          <div>
            <dt>Links checked</dt>
            <dd className="mt-1 font-mono text-lg font-semibold text-foreground">{site?.checkedLinks ?? '—'}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Six area scores as one-hue magnitude bars; each bar filters the findings to its area. */
export function AreaScores({
  subScores,
  issues,
  active,
  onSelect,
}: {
  subScores: Record<string, number> | null | undefined;
  issues: SeoIssue[];
  active: string | null;
  onSelect: (group: string | null) => void;
}) {
  const groups = Object.keys(SEO_GROUP_LABELS);
  return (
    <Card className="h-full">
      <CardContent className="p-6">
        <SectionTitle icon={Network}>Score by area</SectionTitle>
        {!subScores ? (
          <p className="text-sm text-muted-foreground">Area scores are recorded from the next analysis onward.</p>
        ) : (
          <ul className="space-y-1">
            {groups.map((group) => {
              const value = Math.max(0, Math.min(100, Math.round(subScores[group] ?? 0)));
              const count = issues.filter((item) => item.group === group).length;
              const selected = active === group;
              return (
                <li key={group}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : group)}
                    className={cn(
                      'grid w-full grid-cols-[7.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected && 'bg-primary/10 ring-1 ring-primary',
                    )}
                  >
                    <span className="truncate">
                      {SEO_GROUP_LABELS[group]}
                      <span className="block text-[11px] text-muted-foreground">
                        {count} finding{count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <Hover label={`${SEO_GROUP_LABELS[group]}: ${value}/100 · ${count} finding${count === 1 ? '' : 's'}`}>
                      <span className="relative block h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <span
                          className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 motion-reduce:transition-none', SCORE_FILL)}
                          style={{ width: `${Math.max(value, 1)}%` }}
                        />
                      </span>
                    </Hover>
                    <span className="text-right font-mono text-sm font-semibold tabular-nums">{value}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Part-to-whole bar with 2px gaps; legend chips double as filters. */
export function SeverityBreakdown({
  issues,
  active,
  onSelect,
}: {
  issues: SeoIssue[];
  active: string;
  onSelect: (severity: string) => void;
}) {
  const counts = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: issues.filter((item) => item.severity === severity).length,
  }));
  const total = issues.length;
  return (
    <Card className="h-full">
      <CardContent className="p-6">
        <SectionTitle icon={TriangleAlert} hint={`${total} finding${total === 1 ? '' : 's'}`}>
          Findings by severity
        </SectionTitle>
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          {total > 0 &&
            counts
              .filter((item) => item.count)
              .map((item) => (
                <Hover key={item.severity} label={`${SEVERITY_META[item.severity].label}: ${item.count} (${Math.round((item.count / total) * 100)}%)`}>
                  <span
                    className={cn('h-full first:rounded-l-full last:rounded-r-full', SEVERITY_META[item.severity].fill, active !== 'all' && active !== item.severity && 'opacity-30')}
                    style={{ width: `${(item.count / total) * 100}%` }}
                  />
                </Hover>
              ))}
        </div>
        <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(5.25rem,1fr))] gap-2">
          {counts.map(({ severity, count }) => {
            const meta = SEVERITY_META[severity];
            const Icon = meta.icon;
            return (
              <button
                key={severity}
                type="button"
                aria-pressed={active === severity}
                onClick={() => onSelect(active === severity ? 'all' : severity)}
                className={cn(
                  'rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active === severity && 'border-primary bg-primary/10',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={meta.label}>
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.iconClass)} aria-hidden />
                  {severity === 'info' ? 'Info' : meta.label}
                </span>
                <strong className="mt-1 block font-mono text-xl font-semibold tabular-nums">{count}</strong>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

const CRAWL_META: Record<string, { label: string; fill: string }> = {
  completed: { label: 'Crawled', fill: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  blocked: { label: 'Blocked', fill: 'bg-[#d03b3b]' },
  failed: { label: 'Failed', fill: 'bg-[#ec835a]' },
  timed_out: { label: 'Timed out', fill: 'bg-[#fab219]' },
  uncrawlable: { label: 'Not HTML', fill: 'bg-muted-foreground/45' },
};

export function CrawlCoverage({
  pages,
  site,
  onShowUnavailable,
}: {
  pages: CrawlPage[];
  site: SeoSiteSummary | null | undefined;
  onShowUnavailable: () => void;
}) {
  const total = pages.length;
  const rows = Object.keys(CRAWL_META)
    .map((status) => ({ status, count: pages.filter((page) => page.crawlStatus === status).length }))
    .filter((row) => row.count > 0);
  const unavailable = pages.filter((page) => page.crawlStatus !== 'completed').length;
  return (
    <Card className="h-full">
      <CardContent className="p-6">
        <SectionTitle
          icon={Network}
          hint={site?.discoveredPages ? `${site.discoveredPages} URLs discovered · limit ${site.pageLimit ?? total}` : undefined}
        >
          Crawl coverage
        </SectionTitle>
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          {rows.map((row) => (
            <Hover key={row.status} label={`${CRAWL_META[row.status].label}: ${row.count} of ${total} pages`}>
              <span
                className={cn('h-full first:rounded-l-full last:rounded-r-full', CRAWL_META[row.status].fill)}
                style={{ width: `${(row.count / Math.max(total, 1)) * 100}%` }}
              />
            </Hover>
          ))}
        </div>
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {rows.map((row) => (
            <li key={row.status} className="inline-flex items-center gap-1.5">
              <span className={cn('h-2.5 w-2.5 rounded-sm', CRAWL_META[row.status].fill)} aria-hidden />
              {CRAWL_META[row.status].label}
              <strong className="font-mono text-foreground">{row.count}</strong>
            </li>
          ))}
          {!rows.length && <li>No pages were sampled.</li>}
        </ul>
        {unavailable > 0 && (
          <button
            type="button"
            onClick={onShowUnavailable}
            className="mt-4 inline-flex items-baseline gap-2 rounded-md text-left text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <strong className="font-mono text-2xl">{unavailable}</strong>{' '}
            <span className="text-xs text-muted-foreground">
              page{unavailable === 1 ? '' : 's'} not crawled
            </span>
          </button>
        )}
      </CardContent>
    </Card>
  );
}

/** Rules ranked by the share of crawled pages they affect. Selecting one filters the list. */
export function TopIssues({
  issues,
  pageCount,
  active,
  onSelect,
}: {
  issues: SeoIssue[];
  pageCount: number;
  active: string | null;
  onSelect: (ruleId: string | null) => void;
}) {
  const byRule = new Map<string, { pages: Set<string>; findings: number; severity: string }>();
  for (const item of issues) {
    const entry = byRule.get(item.ruleId) || { pages: new Set<string>(), findings: 0, severity: item.severity };
    entry.findings += 1;
    entry.pages.add(item.affectedUrl || 'site');
    if (SEVERITY_ORDER.indexOf(item.severity) < SEVERITY_ORDER.indexOf(entry.severity)) entry.severity = item.severity;
    byRule.set(item.ruleId, entry);
  }
  const ranked = [...byRule.entries()]
    // Informational checks could not be verified; they are not fixes.
    .filter(([, entry]) => entry.severity !== 'info')
    .sort(
      ([, a], [, b]) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.pages.size - a.pages.size,
    )
    .slice(0, 8);
  if (!ranked.length) return null;
  return (
    <Card>
      <CardContent className="p-6">
        <SectionTitle icon={CircleAlert}>Top issues to fix</SectionTitle>
        <ul className="divide-y">
          {ranked.map(([ruleId, entry]) => {
            const siteWide = entry.pages.has('site');
            const share = entry.pages.size / Math.max(pageCount, 1);
            const meta = SEVERITY_META[entry.severity] || SEVERITY_META.info;
            const Icon = meta.icon;
            const selected = active === ruleId;
            return (
              <li key={ruleId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(selected ? null : ruleId)}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_6.5rem]',
                    selected && 'bg-primary/10 ring-1 ring-primary',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <Icon className={cn('h-4 w-4 shrink-0', meta.iconClass)} aria-label={meta.label} />
                    {/* Wrap on phones so long rule names stay readable; one line from sm up. */}
                    <span className="break-words sm:truncate" title={seoRuleLabel(ruleId)}>
                      {seoRuleLabel(ruleId)}
                    </span>
                  </span>
                  {/* A site-wide finding has no page share, so it gets an outlined track instead of a full bar. */}
                  <span
                    className={cn(
                      'order-3 col-span-2 block h-2 overflow-hidden rounded-full sm:order-none sm:col-span-1',
                      siteWide ? 'border border-dashed border-muted-foreground/40' : 'bg-muted',
                    )}
                    aria-hidden
                  >
                    {!siteWide && (
                      <span className={cn('block h-full rounded-full', meta.fill)} style={{ width: `${Math.max(share * 100, 2)}%` }} />
                    )}
                  </span>
                  <span className="text-right text-xs text-muted-foreground">
                    {siteWide ? (
                      'Site-wide'
                    ) : (
                      <>
                        <strong className="font-mono text-foreground">{entry.pages.size}</strong> of {pageCount} pages
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function YesNo({ ok, yes, no }: { ok: boolean | null; yes: string; no: string }) {
  if (ok === null) return <span className="text-muted-foreground">Not recorded</span>;
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className={cn('h-4 w-4', ok ? 'text-[#0a8a0a] dark:text-[#0ca30c]' : 'text-[#d03b3b]')} aria-hidden />
      {ok ? yes : no}
    </span>
  );
}

const SITEMAP_KIND: Record<SeoSitemapSource['kind'], string> = {
  urlset: 'URL list',
  sitemapindex: 'Sitemap index',
  invalid: 'Invalid',
  unreachable: 'Unreachable',
  skipped: 'Not read',
};

/**
 * Older measurements stored no robots rules, so crawler access can't be shown either.
 * SeoView then shows this card alone, with one line saying what the next analysis adds.
 */
export function robotsDetailsMissing(site: SeoSiteSummary) {
  return site.robots.available && (site.robots.groups === null || site.robots.rules === null) && !site.crawlerAccess;
}

export function SiteFiles({ site }: { site: SeoSiteSummary }) {
  const missingRules = site.robots.available && (site.robots.groups === null || site.robots.rules === null);
  return (
    <Card className="h-full">
      <CardContent className="space-y-5 p-6">
        <SectionTitle icon={FileCode2}>robots.txt and sitemap</SectionTitle>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">robots.txt</dt>
            <dd className="mt-1">
              <YesNo ok={site.robots.available} yes="Reachable" no="Unavailable" />
              {site.robots.available && !missingRules && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {site.robots.groups} groups · {site.robots.rules} rules
                </span>
              )}
              {site.robots.error && <p className="mt-1 text-xs text-muted-foreground">{site.robots.error}</p>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">XML sitemap</dt>
            <dd className="mt-1">
              <YesNo ok={site.sitemap.available} yes="Readable" no="Unavailable" />
              {site.sitemap.available && (
                <span className="ml-2 text-xs text-muted-foreground">
                  <strong className="font-mono text-foreground">{site.sitemap.urlCount.toLocaleString()}</strong> URLs
                </span>
              )}
            </dd>
          </div>
          {/* Older measurements didn't record these; leave them out rather than show "Not recorded". */}
          {site.sitemap.declaredInRobots !== null && (
            <div>
              <dt className="text-xs text-muted-foreground">Sitemap listed in robots.txt</dt>
              <dd className="mt-1">
                <YesNo ok={site.sitemap.declaredInRobots} yes="Yes" no="No" />
              </dd>
            </div>
          )}
          {site.sitemap.available && site.sitemap.complete !== null && (
            <div>
              <dt className="text-xs text-muted-foreground">Every sitemap file read</dt>
              <dd className="mt-1">
                <YesNo ok={site.sitemap.complete} yes="Yes" no="Partial" />
              </dd>
            </div>
          )}
        </dl>
        {missingRules && (
          <p className="text-xs text-muted-foreground">
            Robots rules and crawler access are recorded from the next analysis.
          </p>
        )}
        {site.sitemap.sources.length > 0 && (
          <details className="text-sm" open>
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Sitemap files checked ({site.sitemap.sources.length})
            </summary>
            <ul className="mt-2 divide-y rounded-md border">
              {site.sitemap.sources.map((source) => (
                <li key={source.url} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="min-w-0 break-all">{source.url}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {SITEMAP_KIND[source.kind]}
                    {source.kind === 'urlset' || source.kind === 'sitemapindex'
                      ? ` · ${source.urlCount} ${source.kind === 'urlset' ? 'URLs' : 'files'}`
                      : source.error
                        ? ` · ${source.error}`
                        : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

const PURPOSE_LABEL: Record<SeoCrawlerAccess['purpose'], string> = {
  search: 'Search engines',
  ai_search: 'AI search and answers',
  ai_user: 'AI search and answers',
  ai_training: 'AI model training',
};

/** Which search and AI crawlers robots.txt lets read the homepage, with the deciding rule. */
export function CrawlerAccessPanel({ site }: { site: SeoSiteSummary }) {
  const access = site.crawlerAccess;
  const sections = ['Search engines', 'AI search and answers', 'AI model training'];
  return (
    <Card className="h-full">
      <CardContent className="p-6">
        <SectionTitle icon={Bot} hint={access ? `Evaluated for ${site.crawlerAccessUrl}` : undefined}>
          Crawler access
        </SectionTitle>
        {!access ? (
          <p className="text-sm text-muted-foreground">
            {site.robots.available
              ? 'Crawler access is recorded from the next analysis onward.'
              : 'No usable robots.txt, so every crawler is allowed by default.'}
          </p>
        ) : (
          <div className="space-y-4">
            {sections.map((section) => {
              const rows = access.filter((item) => PURPOSE_LABEL[item.purpose] === section);
              return (
                <div key={section}>
                  <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{section}</h3>
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {rows.map((item) => (
                      <li key={item.crawler}>
                        <Hover
                          label={
                            item.rule
                              ? `${item.rule}${item.line ? ` (robots.txt line ${item.line})` : ''} · group: ${item.group.join(', ')}`
                              : 'No matching rule, so access is allowed by default.'
                          }
                        >
                          <span
                            tabIndex={0}
                            className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{item.crawler}</span>
                              <span className="block text-[11px] text-muted-foreground">{item.owner}</span>
                            </span>
                            <YesNo ok={item.allowed} yes="Allowed" no="Blocked" />
                          </span>
                        </Hover>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Length against its recommended range, so "16 characters" reads as "too short" at a glance. */
export function LengthMeter({ length, range }: { length: number; range: string }) {
  const match = /(\d+)\D+(\d+)/.exec(range);
  if (!match) return null;
  const [min, max] = [Number(match[1]), Number(match[2])];
  const scale = Math.max(length, max) * 1.15;
  const inRange = length >= min && length <= max;
  return (
    <div className="space-y-1.5">
      <div className="relative h-2.5 rounded-full bg-muted" aria-hidden>
        <span
          className="absolute inset-y-0 rounded-full bg-[#0ca30c]/25 ring-1 ring-inset ring-[#0ca30c]/40"
          style={{ left: `${(min / scale) * 100}%`, width: `${((max - min) / scale) * 100}%` }}
        />
        <span
          className={cn('absolute -top-1 h-[18px] w-1 -translate-x-1/2 rounded-full ring-2 ring-background', inRange ? 'bg-[#0ca30c]' : 'bg-[#d03b3b]')}
          style={{ left: `${Math.min((length / scale) * 100, 100)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        <strong className="font-mono text-foreground">{length}</strong> characters · recommended {range}
      </p>
    </div>
  );
}

/** Rule-specific evidence presented visually above the raw captured fields. */
/** Absolute URL for an image or link found on `page`, or null when it can't be resolved safely. */
function resolveOnPage(value: unknown, page: string | null | undefined) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, page || undefined);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const listOf = (value: unknown) => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []);

/**
 * Plain-language evidence for the common rules, and the evidence keys it already covers.
 * The raw evidence list below it then shows only what is left.
 */
export function evidenceSummary(issue: SeoIssue): { node: ReactNode; covered: string[] } | null {
  const evidence = issue.evidence || {};
  const page = issue.affectedUrl;
  const box = (children: ReactNode) => (
    <div className="mb-4 space-y-2 rounded-md border bg-background p-3 text-sm">{children}</div>
  );
  switch (issue.ruleId) {
    case 'images.missing_alt': {
      const elements = listOf(evidence.elements);
      return {
        covered: ['imageCount', 'missingAlt', 'elements', 'evidenceComplete'],
        node: box(
          <>
            <p>
              <strong className="font-mono">{String(evidence.missingAlt ?? '?')}</strong> of{' '}
              <strong className="font-mono">{String(evidence.imageCount ?? '?')}</strong> images have no alt text.
            </p>
            {elements.length ? (
              <ol className="max-h-64 space-y-1 overflow-auto text-xs">
                {elements.slice(0, 50).map((element, index) => {
                  const href = resolveOnPage(element.source, page);
                  return (
                    <li key={index} className="break-all">
                      <span className="text-muted-foreground">Image {String(element.index ?? index + 1)} · </span>
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
                          {String(element.source)}
                        </a>
                      ) : (
                        <span>{String(element.source || 'Image without a source')}</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-xs text-muted-foreground">
                The list of images is recorded from the next analysis.
              </p>
            )}
          </>,
        ),
      };
    }
    case 'links.broken': {
      const checks = listOf(evidence.checks);
      if (!checks.length) return null;
      return {
        covered: ['links', 'checks'],
        node: box(
          <ul className="space-y-2 text-xs">
            {checks.map((check, index) => {
              const href = resolveOnPage(check.url, page);
              return (
                <li key={index} className="break-all">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
                      {String(check.url)}
                    </a>
                  ) : (
                    String(check.url)
                  )}
                  <span className="block text-muted-foreground">
                    {check.statusCode ? `Responded ${String(check.statusCode)}` : 'No response'}
                    {check.finalUrl && check.finalUrl !== check.url ? ` after redirecting to ${String(check.finalUrl)}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>,
        ),
      };
    }
    case 'metadata.missing_title':
      return { covered: ['source'], node: box(<p>The page has no title tag.</p>) };
    case 'metadata.missing_description':
      return { covered: ['source'], node: box(<p>The page has no meta description tag.</p>) };
    case 'headings.missing_h1': {
      const other = (evidence.otherHeadings || {}) as Record<string, number>;
      return {
        covered: ['source', 'h1Count', 'otherHeadings'],
        node: box(
          <p>
            The page has no H1 heading
            {typeof other.h2 === 'number' ? ` (it has ${other.h2} H2 and ${other.h3 ?? 0} H3 headings)` : ''}.
          </p>,
        ),
      };
    }
    case 'schema.missing': {
      const formats = Array.isArray(evidence.formatsChecked)
        ? (evidence.formatsChecked as string[])
        : ['JSON-LD', 'Microdata', 'RDFa'];
      return {
        covered: ['source', 'formatsChecked'],
        node: box(<p>No structured data found. Checked {formats.join(', ')}.</p>),
      };
    }
    case 'canonical.missing':
      return { covered: [], node: box(<p>The page has no canonical link tag.</p>) };
    case 'links.no_internal_links':
      return { covered: [], node: box(<p>The page links to no other page on this site.</p>) };
    default:
      return null;
  }
}

export function EvidenceHighlights({ issue }: { issue: SeoIssue }) {
  const evidence = issue.evidence || {};
  const summary = evidenceSummary(issue);
  if (summary) return <>{summary.node}</>;
  if (typeof evidence.length === 'number' && typeof evidence.recommendedRange === 'string')
    return (
      <div className="mb-4 rounded-md border bg-background p-3">
        <LengthMeter length={evidence.length} range={evidence.recommendedRange} />
      </div>
    );
  if (issue.ruleId === 'robots.disallowed_page' && typeof evidence.matchedRule === 'string')
    return (
      <div className="mb-4 space-y-2 rounded-md border bg-background p-3 text-xs">
        <p className="text-muted-foreground">
          Rule that blocks <strong className="text-foreground">{String(evidence.evaluatedAs)}</strong> from{' '}
          <code className="rounded bg-muted px-1">{String(evidence.testedPath)}</code>
        </p>
        <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono leading-5">
          {`User-agent: ${String(evidence.userAgentGroup || '*')}\n`}
          <mark className="rounded-sm bg-[#d03b3b]/15 px-0.5 text-foreground">{evidence.matchedRule}</mark>
          {typeof evidence.robotsTxtLine === 'number' && (
            <span className="text-muted-foreground">{`   ← line ${evidence.robotsTxtLine}`}</span>
          )}
        </pre>
      </div>
    );
  return null;
}

/** Per-page quick metrics for the inventory table. */
export function LengthChip({ value, min, max }: { value: string | null | undefined; min: number; max: number }) {
  if (!value) return <span className="text-xs text-[#d03b3b]">Missing</span>;
  const ok = value.length >= min && value.length <= max;
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-xs', !ok && 'text-[#b53030] dark:text-[#e66767]')}>
      {ok ? <CircleCheck className="h-3 w-3 text-[#0a8a0a] dark:text-[#0ca30c]" aria-hidden /> : <CircleAlert className="h-3 w-3" aria-hidden />}
      {value.length}
    </span>
  );
}
