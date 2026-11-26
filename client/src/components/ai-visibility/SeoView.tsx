'use client';
import { Button } from '@/components/ui/button';
import { OlderSeoChecksNotice } from './OlderSeoChecksNotice';
import { Input } from '@/components/ui/input';
import { TooltipProvider } from '@/components/ui/tooltip';
import { aiVisibilityApi, type SeoIssue } from '@/lib/ai-visibility';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { GscCard } from './GscCard';
import {
  AreaScores,
  CrawlCoverage,
  CrawlerAccessPanel,
  EvidenceHighlights,
  evidenceSummary,
  LengthChip,
  robotsDetailsMissing,
  ScoreHero,
  SEVERITY_META,
  SeverityBreakdown,
  SiteFiles,
  TopIssues,
} from './SeoInsights';
import { useDetailFocus } from './use-detail-focus';
import { useMeasurement } from './workspace-context';
import {
  Empty,
  formatScore,
  InlineError,
  Loading,
  Pager,
  safeCitationUrl,
  SEO_GROUP_LABELS,
  seoRuleLabel,
  statusBadge,
  websiteWorkspacePath,
} from './workspace-ui';

/** "sourcePage" → "Source page", "final_url" → "Final URL". */
export function evidenceLabel(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .trim()
    .toLowerCase()
    .replace(/\b(url|urls|http|html|h1|seo|id)\b/g, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function Evidence({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '')
    return <span className="text-muted-foreground">Not captured</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ol className="space-y-2">
        {value.map((item, index) => (
          <li key={index} className="border-l-2 pl-3">
            <Evidence value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="text-muted-foreground">None recorded</span>
    );
  if (typeof value === 'object')
    return (
      <dl className="space-y-2">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt className="text-xs font-medium text-muted-foreground">{evidenceLabel(key)}</dt>
            <dd className="break-words text-sm">
              <Evidence value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  const url = typeof value === 'string' && /^https?:/.test(value) ? safeCitationUrl(value) : null;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="break-all text-primary underline">
      {String(value)}
    </a>
  ) : typeof value === 'string' && /^\/\S*$/.test(value) ? (
    // A path such as a robots.txt rule: monospace, broken anywhere rather than at its hyphens.
    <code className="break-all font-mono text-xs">{value}</code>
  ) : (
    <span className="whitespace-pre-wrap break-words">{String(value)}</span>
  );
}
const severities = ['critical', 'high', 'medium', 'low', 'info'];
const PAGE_SIZE = 20;

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear filter ${label}`}
        className="rounded-full p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}

export function SeoView({ projectId }: { projectId: number }) {
  const { auditId, overview } = useMeasurement();
  const [severity, setSeverity] = useState('all');
  const [area, setArea] = useState<string | null>(null);
  const [rule, setRule] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState('rule');
  const [sort, setSort] = useState('priority');
  const [tab, setTab] = useState('issues');
  const [unavailableOnly, setUnavailableOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<SeoIssue | null>(null);
  const findingsRef = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ['ai-visibility-seo', projectId, auditId],
    queryFn: () => aiVisibilityApi.seo(projectId, auditId),
  });
  const fixes = useQuery({
    queryKey: ['ai-visibility-recommendations', projectId, auditId],
    queryFn: () => aiVisibilityApi.recommendations(projectId, auditId),
  });
  const issues = useMemo(() => query.data?.issues || [], [query.data]);
  const pages = useMemo(() => query.data?.pages || [], [query.data]);
  const site = query.data?.site;
  const filtered = useMemo(
    () =>
      issues
        .filter(
          (item) =>
            (severity === 'all' || item.severity === severity) &&
            (!area || item.group === area) &&
            (!rule || item.ruleId === rule) &&
            [
              item.ruleId,
              seoRuleLabel(item.ruleId),
              item.affectedUrl,
              item.recommendation,
              JSON.stringify(item.evidence),
            ]
              .join(' ')
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) =>
          sort === 'page'
            ? (a.affectedUrl || '').localeCompare(b.affectedUrl || '')
            : severities.indexOf(a.severity) - severities.indexOf(b.severity),
        ),
    [issues, severity, area, rule, search, sort],
  );
  const groups = useMemo(() => {
    const result = new Map<string, SeoIssue[]>();
    for (const issue of filtered) {
      const key =
        groupBy === 'rule'
          ? issue.ruleId
          : groupBy === 'page'
            ? issue.affectedUrl || 'Site-wide'
            : String(issue.id);
      result.set(key, [...(result.get(key) || []), issue]);
    }
    return [...result.entries()];
  }, [filtered, groupBy]);
  const issuesByPage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of issues)
      if (item.affectedUrl) counts.set(item.affectedUrl, (counts.get(item.affectedUrl) || 0) + 1);
    return counts;
  }, [issues]);
  const inventory = pages.filter(
    (item) =>
      (!unavailableOnly || item.crawlStatus !== 'completed') &&
      [item.url, item.title, item.crawlStatus, item.error]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const crawledCount = pages.filter((item) => item.crawlStatus === 'completed').length;
  const rows = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const total = tab === 'issues' ? groups.length : inventory.length;
  const relatedFix =
    selected &&
    fixes.data?.recommendations.find(
      (item) =>
        item.affectedUrl === selected.affectedUrl &&
        (item.evidence?.ruleId === selected.ruleId || item.description === selected.recommendation),
    );
  const detailRef = useDetailFocus(selected?.id);
  // Evidence the summary already explains (and the internal "source" note) isn't listed again.
  const remainingEvidence = useMemo(() => {
    if (!selected) return {};
    const covered = new Set(['source', ...(evidenceSummary(selected)?.covered || [])]);
    return Object.fromEntries(
      Object.entries(selected.evidence || {}).filter(([key]) => !covered.has(key)),
    );
  }, [selected]);
  // The evidence panel belongs to the findings list; the inventory table needs the full width.
  const showEvidence = Boolean(selected) && tab === 'issues';
  // An uncrawled site scores 0 in the engine but is "unavailable" everywhere else; show it that way.
  const seoPillar = overview?.latestScore?.pillarStatuses?.seo;
  const seoScore =
    crawledCount === 0 || (seoPillar && seoPillar !== 'scored')
      ? null
      : (site?.score ?? formatScore(overview?.latestScore?.seoScore));
  const showFindings = () => {
    setTab('issues');
    setPage(0);
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    findingsRef.current?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };
  if (query.isLoading) return <Loading />;
  if (query.isError)
    return (
      <InlineError message="SEO findings could not be loaded." onRetry={() => query.refetch()} />
    );
  const activeFilters = [
    severity !== 'all' && {
      label: `Severity: ${SEVERITY_META[severity]?.label || severity}`,
      clear: () => setSeverity('all'),
    },
    area && { label: `Area: ${SEO_GROUP_LABELS[area] || area}`, clear: () => setArea(null) },
    rule && { label: `Issue: ${seoRuleLabel(rule)}`, clear: () => setRule(null) },
  ].filter(Boolean) as Array<{ label: string; clear: () => void }>;
  return (
    <TooltipProvider>
      <div className="space-y-5">
        {site?.rulesOutdated && (
          <OlderSeoChecksNotice
            projectId={projectId}
            version={site.ruleVersion}
            current={site.currentRuleVersion}
            subject="findings"
          />
        )}
        {Boolean(query.data?.withdrawnFindings) && (
          <p className="text-xs text-muted-foreground">
            {query.data?.withdrawnFindings} “Page blocked by robots.txt” finding
            {query.data?.withdrawnFindings === 1 ? ' was' : 's were'} removed: an older check misread
            robots.txt, and the rules it cites don’t block these pages. The score still includes them
            until the next analysis.
          </p>
        )}
        <section
          aria-label="SEO summary"
          className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"
        >
          <ScoreHero score={seoScore} pages={pages} issues={issues} site={site} />
          <AreaScores
            subScores={site?.subScores}
            issues={issues}
            active={area}
            onSelect={(value) => {
              setArea(value);
              showFindings();
            }}
          />
        </section>
        {/* When every sampled page was crawled the score card already says so; the coverage card only adds a full bar. */}
        <section
          aria-label="Findings and crawl overview"
          className={cn('grid gap-4', crawledCount < pages.length && 'lg:grid-cols-2')}
        >
          <SeverityBreakdown
            issues={issues}
            active={severity}
            onSelect={(value) => {
              setSeverity(value);
              setTab('issues');
              setPage(0);
            }}
          />
          {crawledCount < pages.length && (
            <CrawlCoverage
              pages={pages}
              site={site}
              onShowUnavailable={() => {
                setTab('pages');
                setSearch('');
                setUnavailableOnly(true);
                setPage(0);
              }}
            />
          )}
        </section>
        <TopIssues
          issues={issues}
          pageCount={crawledCount}
          active={rule}
          onSelect={(value) => {
            setRule(value);
            showFindings();
          }}
        />
        {site && (
          <section
            aria-label="Crawler access and site files"
            className={cn('grid gap-4', !robotsDetailsMissing(site) && 'lg:grid-cols-2')}
          >
            <SiteFiles site={site} />
            {!robotsDetailsMissing(site) && <CrawlerAccessPanel site={site} />}
          </section>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">How the SEO score works</summary>
          <p className="mt-2 max-w-3xl leading-5">
            The score averages six area scores from a sample of pages, not the whole site. Checks read
            the HTML the server sends before JavaScript runs, so content added later by scripts may
            differ. Info findings are checks that could not be verified.
          </p>
        </details>
        <div ref={findingsRef} className="scroll-mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={tab === 'issues' ? 'default' : 'outline'}
              onClick={() => {
                setTab('issues');
                setPage(0);
              }}
            >
              Findings ({issues.length})
            </Button>
            <Button
              size="sm"
              variant={tab === 'pages' ? 'default' : 'outline'}
              onClick={() => {
                setTab('pages');
                setSearch('');
                setUnavailableOnly(false);
                setPage(0);
              }}
            >
              Page inventory ({pages.length})
            </Button>
            <div className="w-full sm:ml-auto sm:w-72">
              <Input
                aria-label="Search SEO evidence or pages"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
                placeholder="Search URL, rule or evidence"
              />
            </div>
          </div>
          {tab === 'pages' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={unavailableOnly}
                onChange={(event) => {
                  setUnavailableOnly(event.target.checked);
                  setPage(0);
                }}
              />
              Unavailable or blocked pages only
            </label>
          )}
          {tab === 'issues' && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs">
                Severity
                <select
                  className="ml-2 rounded border bg-background p-2"
                  value={severity}
                  onChange={(event) => {
                    setSeverity(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">All severities</option>
                  {severities.map((value) => (
                    <option key={value} value={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                Group by
                <select
                  className="ml-2 rounded border bg-background p-2"
                  value={groupBy}
                  onChange={(event) => {
                    setGroupBy(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="rule">Repeated rule</option>
                  <option value="page">Source page</option>
                  <option value="none">Individual finding</option>
                </select>
              </label>
              <label className="text-xs">
                Sort
                <select
                  className="ml-2 rounded border bg-background p-2"
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="priority">Priority</option>
                  <option value="page">Page URL</option>
                </select>
              </label>
              {activeFilters.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {activeFilters.map((filter) => (
                    <FilterChip
                      key={filter.label}
                      label={filter.label}
                      onClear={() => {
                        filter.clear();
                        setPage(0);
                      }}
                    />
                  ))}
                  {activeFilters.length > 1 && (
                    <button
                      type="button"
                      className="text-xs text-primary underline-offset-4 hover:underline"
                      onClick={() => {
                        setSeverity('all');
                        setArea(null);
                        setRule(null);
                        setPage(0);
                      }}
                    >
                      Clear all
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div
            className={`grid gap-5 ${showEvidence ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : ''}`}
          >
            <div className="min-w-0">
              {tab === 'issues' ? (
                rows.length ? (
                  <div className="divide-y rounded-lg border">
                    {rows.map(([key, items]) => {
                      const worst =
                        [...items].sort(
                          (a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity),
                        )[0]?.severity || 'info';
                      const meta = SEVERITY_META[worst] || SEVERITY_META.info;
                      const Icon = meta.icon;
                      const affected = new Set(items.map((item) => item.affectedUrl)).size;
                      const siteWide = items.every((item) => !item.affectedUrl);
                      // Within one rule every finding usually has the same advice: say it once, then list pages.
                      const sharedAdvice =
                        groupBy === 'rule' &&
                        items.every((item) => item.recommendation === items[0].recommendation)
                          ? items[0].recommendation
                          : null;
                      const countLabel = siteWide
                        ? 'Site-wide'
                        : items.length === affected
                          ? `${affected} page${affected === 1 ? '' : 's'}`
                          : `${items.length} findings on ${affected} page${affected === 1 ? '' : 's'}`;
                      return (
                        <details
                          key={key}
                          className="group px-3 py-3"
                          open={groupBy === 'none' ? true : undefined}
                        >
                          <summary className="flex cursor-pointer list-none items-center gap-3 text-sm [&::-webkit-details-marker]:hidden">
                            <Icon
                              className={cn('h-4 w-4 shrink-0', meta.iconClass)}
                              aria-label={meta.label}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="font-medium">
                                {groupBy === 'rule'
                                  ? seoRuleLabel(key)
                                  : groupBy === 'page'
                                    ? key
                                    : seoRuleLabel(items[0].ruleId)}
                              </span>
                              <span className="ml-3 text-xs text-muted-foreground">
                                {countLabel}
                              </span>
                            </span>
                            {groupBy === 'rule' && !siteWide && crawledCount > 0 && (
                              <span
                                className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-muted sm:block"
                                aria-hidden
                              >
                                <span
                                  className={cn('block h-full rounded-full', meta.fill)}
                                  style={{
                                    width: `${Math.min(100, Math.max(4, (affected / crawledCount) * 100))}%`,
                                  }}
                                />
                              </span>
                            )}
                            <span
                              className="text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
                              aria-hidden
                            >
                              ›
                            </span>
                          </summary>
                          {sharedAdvice && (
                            <p className="mt-2 pl-7 text-sm text-muted-foreground">{sharedAdvice}</p>
                          )}
                          <div className="mt-2 divide-y">
                            {items.map((item) => (
                              <button
                                key={item.id}
                                className={`flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-muted focus-visible:ring-2 ${selected?.id === item.id ? 'bg-muted ring-1 ring-primary' : ''}`}
                                aria-current={selected?.id === item.id ? 'true' : undefined}
                                onClick={() => setSelected(item)}
                              >
                                {statusBadge(item.severity)}
                                <span className="min-w-0 flex-1">
                                  {sharedAdvice ? (
                                    <span className="block break-all text-sm">
                                      {item.affectedUrl || 'Site-wide'}
                                    </span>
                                  ) : (
                                    <>
                                      <span className="block text-sm">
                                        {groupBy === 'page'
                                          ? seoRuleLabel(item.ruleId)
                                          : item.recommendation}
                                      </span>
                                      {groupBy !== 'page' && (
                                        <span className="block break-all text-xs text-muted-foreground">
                                          {item.affectedUrl || 'Site-wide'}
                                        </span>
                                      )}
                                    </>
                                  )}
                                </span>
                                <span
                                  className={cn(
                                    'shrink-0 text-xs',
                                    selected?.id === item.id
                                      ? 'font-medium text-foreground'
                                      : 'text-primary',
                                  )}
                                >
                                  {selected?.id === item.id ? 'Viewing' : 'Evidence →'}
                                </span>
                              </button>
                            ))}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                ) : (
                  <Empty
                    message={
                      issues.length
                        ? 'No findings match these filters.'
                        : query.data?.audit
                          ? 'No issues were found in this completed crawl.'
                          : 'Run an analysis to populate findings.'
                    }
                  />
                )
              ) : (
                <div className="overflow-auto rounded-lg border">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">All stored crawl pages and their results</caption>
                    <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                      <tr>
                        <th className="p-2">Page</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">HTTP</th>
                        <th className="p-2" title="Title length, recommended 20–65 characters">
                          Title
                        </th>
                        <th
                          className="p-2"
                          title="Meta description length, recommended 70–160 characters"
                        >
                          Description
                        </th>
                        <th className="p-2">H1</th>
                        <th className="p-2">Words</th>
                        <th className="p-2">Findings</th>
                        <th className="p-2">Metadata</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {inventory.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => {
                        const completed = item.crawlStatus === 'completed';
                        const h1Count = item.headings?.h1?.length ?? 0;
                        const findings = issuesByPage.get(item.finalUrl || item.url) || 0;
                        return (
                          <tr key={item.id} className="align-top">
                            <td className="max-w-xs break-words p-2">
                              <Evidence value={item.url} />
                              {item.title && (
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {item.title}
                                </p>
                              )}
                              {item.error && <p className="mt-1 text-destructive">{item.error}</p>}
                            </td>
                            <td className="p-2">{statusBadge(item.crawlStatus)}</td>
                            <td className="p-2 font-mono text-xs">{item.statusCode ?? 'Unavailable'}</td>
                            <td className="p-2">
                              {completed ? <LengthChip value={item.title} min={20} max={65} /> : '—'}
                            </td>
                            <td className="p-2">
                              {completed ? (
                                <LengthChip value={item.metaDescription} min={70} max={160} />
                              ) : (
                                '—'
                              )}
                            </td>
                            <td
                              className={cn(
                                'p-2 font-mono text-xs',
                                completed && h1Count !== 1 && 'text-[#b53030] dark:text-[#e66767]',
                              )}
                            >
                              {completed ? h1Count : '—'}
                            </td>
                            <td className="p-2 font-mono text-xs">
                              {completed ? (item.wordCount ?? 0).toLocaleString() : '—'}
                            </td>
                            <td className="p-2 font-mono text-xs">{findings}</td>
                            <td className="min-w-40 p-2">
                              <details>
                                <summary className="cursor-pointer">Inspect page</summary>
                                <Evidence
                                  value={{
                                    title: item.title,
                                    description: item.metaDescription,
                                    headings: item.headings,
                                    canonical: item.canonicalUrl,
                                    finalUrl: item.finalUrl,
                                    indexable: item.indexable,
                                    robotsDirective: item.robotsDirective,
                                    words: item.wordCount,
                                    images: item.imageCount,
                                    imagesMissingAlt: item.imagesMissingAlt,
                                    schemaTypes: item.schemaTypes,
                                  }}
                                />
                              </details>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!inventory.length && <Empty message="No pages match this search." />}
                </div>
              )}
              <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  {total ? page * PAGE_SIZE + 1 : 0}–{Math.min((page + 1) * PAGE_SIZE, total)} of{' '}
                  {total} {tab === 'issues' ? `groups · ${filtered.length} findings` : 'pages'}
                </span>
                <Pager
                  page={page}
                  total={total}
                  pageSize={PAGE_SIZE}
                  onPageChange={setPage}
                />
              </div>
            </div>
            {selected && showEvidence && (
              <aside
                ref={detailRef}
                tabIndex={-1}
                aria-label="Finding evidence"
                className="min-w-0 rounded-lg border bg-muted/20 p-4 lg:sticky lg:top-4 lg:max-h-[80vh] lg:self-start lg:overflow-auto"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold">{seoRuleLabel(selected.ruleId)}</h2>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelected(null)}
                    aria-label="Close evidence"
                  >
                    ×
                  </Button>
                </div>
                {/* The page comes first: rows in one group share the advice, so the page is what changes. */}
                <p className="mt-1 break-all text-sm">
                  {selected.affectedUrl ? (
                    <Evidence value={selected.affectedUrl} />
                  ) : (
                    <span className="text-muted-foreground">Site-wide</span>
                  )}
                </p>
                <div className="my-3 flex flex-wrap items-center gap-2">
                  {statusBadge(selected.severity)}
                  <span className="text-xs text-muted-foreground">
                    {SEO_GROUP_LABELS[selected.group] || selected.group}
                  </span>
                </div>
                <p className="mb-3 text-sm">{selected.recommendation}</p>
                <EvidenceHighlights issue={selected} />
                {Object.keys(remainingEvidence).length > 0 && <Evidence value={remainingEvidence} />}
                {typeof selected.evidence?.source === 'string' && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Checked in the page HTML before JavaScript runs.
                  </p>
                )}
                {fixes.isError ? (
                  <InlineError
                    message="Linked fixes are unavailable."
                    onRetry={() => fixes.refetch()}
                  />
                ) : (
                  <Button asChild size="sm" className="mt-4">
                    <Link
                      href={
                        websiteWorkspacePath(projectId, 'fixes') +
                        (relatedFix ? `?fix=${relatedFix.id}` : '')
                      }
                    >
                      {relatedFix ? 'Open linked fix' : 'Review fixes'}
                    </Link>
                  </Button>
                )}
              </aside>
            )}
          </div>
        </div>
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">
            Google Search Console
          </summary>
          <div className="mt-4">
            <GscCard projectId={projectId} />
          </div>
        </details>
      </div>
    </TooltipProvider>
  );
}
