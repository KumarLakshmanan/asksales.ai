'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { LoadingState } from '@/components/ui/loading-state';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  aiVisibilityApi,
  type AiVisibilityAuditEstimate,
  type AiVisibilityProject,
  type AuditStage,
} from '@/lib/ai-visibility';
import { ApiError } from '@/lib/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleGauge,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShoppingBag,
  SkipForward,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { AssetsView } from './AssetsView';
import { CommerceView } from './CommerceView';
import { CompetitorView } from './CompetitorView';
import { FixesView } from './FixesView';
import { PromptView } from './PromptView';
import { ReportsView } from './ReportsView';
import { SeoView } from './SeoView';
import {
  MeasurementContext,
  capabilities,
  refreshVisibility,
  useMeasurement,
} from './workspace-context';
import {
  Empty,
  InlineError,
  Loading,
  VIEW_COPY,
  WEBSITE_TABS,
  scoreState,
  showsCommerce,
  recommendationTitle,
  statusBadge,
  websiteHost,
  websiteWorkspacePath,
  type AiVisibilityView,
} from './workspace-ui';
import { MeasurementBar, WorkspaceSettings } from './WorkspaceSettings';
export { AiVisibilityPortfolio } from './Portfolio';
export type { AiVisibilityView } from './workspace-ui';
export function AiVisibilityWorkspace({
  view,
  projectId,
}: {
  view: AiVisibilityView;
  projectId: number;
}) {
  const searchParams = useSearchParams();
  const requestedAuditId = Number(searchParams.get('audit')) || undefined;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const projectQuery = useQuery({
    queryKey: ['ai-visibility-project', projectId],
    queryFn: () => aiVisibilityApi.getProject(projectId),
  });
  const project = projectQuery.data?.project;
  const overview = useQuery({
    queryKey: ['ai-visibility-overview', projectId, requestedAuditId],
    queryFn: () => aiVisibilityApi.overview(projectId, requestedAuditId),
    enabled: Boolean(project),
  });
  const audits = useQuery({
    queryKey: ['ai-visibility-audits', projectId],
    queryFn: () => aiVisibilityApi.listAudits(projectId),
    enabled: Boolean(project),
    refetchInterval: (query) =>
      (query.state.data?.audits || []).some((audit) => ['queued', 'running'].includes(audit.status))
        ? 5000
        : false,
  });
  const estimate = useQuery({
    queryKey: ['ai-visibility-audit-estimate', projectId],
    queryFn: () => aiVisibilityApi.estimate(projectId),
    enabled: Boolean(project),
  });
  const runAudit = useMutation({
    mutationFn: () => aiVisibilityApi.createAudit(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-audits', projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-overview', projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-website-searches'],
      });
      toast({
        title: 'Analysis started',
        description: 'Results will update automatically on this page.',
      });
    },
    onError: (error) =>
      toast({
        title:
          error instanceof ApiError && error.status === 402
            ? 'More wallet credits are needed'
            : 'Analysis could not start',
        description: error instanceof Error ? error.message : 'Try again.',
        variant: 'destructive',
      }),
  });
  const latestAudit = audits.data?.audits[0];
  useEffect(() => {
    if (
      !latestAudit ||
      !['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(latestAudit.status)
    )
      return;
    void refreshVisibility(queryClient, projectId);
  }, [latestAudit?.id, latestAudit?.status, latestAudit?.completedAt, projectId, queryClient]);

  if (projectQuery.isLoading)
    return (
      <LoadingState className="min-h-80 py-0" label="Loading website…" />
    );
  if (projectQuery.isError || !project)
    return (
      <div className="mx-auto w-full max-w-[900px] px-4 py-10">
        <InlineError message="This website workspace could not be loaded. It may not exist or you may not have access." />
        <Button asChild variant="outline" className="mt-4">
          <Link href="/dashboard/ai-visibility">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to websites
          </Link>
        </Button>
      </div>
    );

  const active = Boolean(
    audits.data?.audits.some((audit) => ['queued', 'running'].includes(audit.status)),
  );
  return (
    <MeasurementContext.Provider
      value={{
        project,
        overview: overview.data,
        auditId: overview.data?.measurementAudit?.id ?? requestedAuditId,
        historical: Boolean(
          requestedAuditId &&
          requestedAuditId !==
            audits.data?.audits.find((audit) =>
              ['completed', 'completed_with_warnings'].includes(audit.status),
            )?.id,
        ),
        can: capabilities(project.workspace?.role),
      }}
    >
      <section
        className="mx-auto w-full max-w-[1320px] space-y-3 px-4 pb-12 pt-3 sm:px-6 sm:pt-4 lg:px-10"
        aria-labelledby="ai-visibility-title"
      >
        <WebsiteWorkspaceHeader project={project} view={view} />
        <MeasurementBar
          project={project}
          data={overview.data}
          audits={audits.data?.audits || []}
          view={view}
          loading={overview.isLoading}
          error={overview.isError}
          onRetry={() => overview.refetch()}
        />
        <WorkspaceSettings key={`settings:${project.id}`} project={project} estimate={estimate.data?.estimate} />
        {view === 'overview' &&
          (overview.isLoading || audits.isLoading ? (
            <Loading />
          ) : overview.isError || audits.isError ? (
            <InlineError
              message="Visibility scores and analysis history could not be loaded."
              onRetry={() => {
                overview.refetch();
                audits.refetch();
              }}
            />
          ) : (
            <Overview
              projectId={project.id}
              data={overview.data}
              audits={audits.data?.audits || []}
              estimate={estimate.data?.estimate}
              onAnalyze={() => runAudit.mutate()}
              analysisPending={runAudit.isPending || active}
            />
          ))}
        {!overview.isLoading && !overview.isError && view === 'seo' && (
          <SeoView
            key={`${project.id}:${overview.data?.measurementAudit?.id || 0}`}
            projectId={project.id}
          />
        )}
        {!overview.isLoading && !overview.isError && (view === 'aeo' || view === 'geo') && (
          <PromptView
            key={`${project.id}:${overview.data?.measurementAudit?.id || 0}`}
            projectId={project.id}
            kind={view}
          />
        )}
        {!overview.isLoading && !overview.isError && view === 'commerce' && (
          <CommerceView
            key={`${project.id}:${overview.data?.measurementAudit?.id || 0}`}
            projectId={project.id}
          />
        )}
        {view === 'competitors' && <CompetitorView key={project.id} projectId={project.id} />}
        {!overview.isLoading && !overview.isError && view === 'fixes' && (
          <FixesView
            key={`${project.id}:${overview.data?.measurementAudit?.id || 0}`}
            projectId={project.id}
          />
        )}
        {!overview.isLoading && !overview.isError && view === 'assets' && (
          <AssetsView
            key={`${project.id}:${overview.data?.measurementAudit?.id || 0}`}
            projectId={project.id}
            role={project.workspace?.role || 'client_reviewer'}
          />
        )}
        {view === 'reports' && <ReportsView project={project} />}
      </section>
    </MeasurementContext.Provider>
  );
}

function WebsiteWorkspaceHeader({
  project,
  view,
}: {
  project: AiVisibilityProject;
  view: AiVisibilityView;
}) {
  const copy = VIEW_COPY[view];
  const router = useRouter();
  const { historical, auditId, overview } = useMeasurement();
  const suffix = historical && auditId ? `?audit=${auditId}` : '';
  // Commerce stays reachable while it is open, e.g. from a direct link.
  const tabs = WEBSITE_TABS.filter(
    (tab) =>
      tab.view !== 'commerce' || view === 'commerce' || showsCommerce(project, overview?.latestScore),
  );
  return (
    <div className="space-y-3">
      <header>
        <Link
          href="/dashboard/ai-visibility"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          All websites
        </Link>
        <div className="mt-2 flex items-start gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <span>{websiteHost(project.domain)}</span>
              {project.source === 'business_profile' && (
                <Badge variant="secondary" className="normal-case tracking-normal">
                  Business Profile
                </Badge>
              )}
            </div>
            <h1
              id="ai-visibility-title"
              className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl"
            >
              {copy.title}
            </h1>
          </div>
        </div>
      </header>
      <label className="block text-sm sm:hidden">
        Section
        <select
          aria-label="Visibility section"
          className="mt-1 block w-full rounded-md border bg-background p-2"
          value={view}
          onChange={(event) =>
            router.push(
              websiteWorkspacePath(project.id, event.target.value as AiVisibilityView) + suffix,
            )
          }
        >
          {tabs.map((tab) => (
            <option key={tab.view} value={tab.view}>
              {tab.label}
            </option>
          ))}
        </select>
      </label>
      <nav aria-label={`${project.name} visibility sections`} className="hidden sm:block">
        <div className="flex flex-wrap gap-1 border-b pb-2">
          {[
            { label: 'Summary', views: ['overview'] },
            { label: 'Analyze', views: ['seo', 'aeo', 'geo', 'commerce'] },
            { label: 'Compare', views: ['competitors'] },
            { label: 'Act', views: ['fixes', 'assets'] },
            { label: 'Report', views: ['reports'] },
          ].map((group) => (
            <div
              key={group.label}
              className="mr-2 border-r pr-2 last:mr-0 last:border-r-0 last:pr-0"
            >
              {/* Dividers group the tabs; the group name stays for screen readers only. */}
              <span className="sr-only">{group.label}</span>
              <div className="flex gap-1">
                {tabs.filter((tab) => group.views.includes(tab.view)).map((tab) => (
                  <Link
                    key={tab.view}
                    href={websiteWorkspacePath(project.id, tab.view) + suffix}
                    aria-current={view === tab.view ? 'page' : undefined}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === tab.view ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                  >
                    {tab.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}

function Overview({
  projectId,
  data,
  audits,
  estimate,
  onAnalyze,
  analysisPending,
}: {
  projectId: number;
  data: Awaited<ReturnType<typeof aiVisibilityApi.overview>> | undefined;
  audits: Awaited<ReturnType<typeof aiVisibilityApi.listAudits>>['audits'];
  estimate: AiVisibilityAuditEstimate | undefined;
  onAnalyze: () => void;
  analysisPending: boolean;
}) {
  const { can, project } = useMeasurement();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const alertsQuery = useQuery({
    queryKey: ['ai-visibility-alerts', projectId],
    queryFn: () => aiVisibilityApi.alerts(projectId),
  });
  const acknowledge = useMutation({
    mutationFn: (alertId: number) => aiVisibilityApi.acknowledgeAlert(projectId, alertId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-alerts', projectId],
      }),
    onError: (error) =>
      toast({
        title: 'Alert could not be acknowledged',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const score = data?.latestScore;
  const auditStatus = data?.measurementAudit?.status;
  const overall = scoreState(
    'Overall',
    score?.overallScore,
    score ? 'scored' : undefined,
    auditStatus,
  );
  const scoreCards = [
    {
      label: 'SEO',
      value: score?.seoScore,
      status: score?.pillarStatuses.seo,
      href: websiteWorkspacePath(projectId, 'seo'),
      icon: <Search className="h-4 w-4" />,
    },
    {
      label: 'AEO',
      value: score?.aeoScore,
      status: score?.pillarStatuses.aeo,
      href: websiteWorkspacePath(projectId, 'aeo'),
      icon: <MessageCircle className="h-4 w-4" />,
    },
    {
      label: 'GEO',
      value: score?.geoScore,
      status: score?.pillarStatuses.geo,
      href: websiteWorkspacePath(projectId, 'geo'),
      icon: <Bot className="h-4 w-4" />,
    },
    {
      label: 'Commerce',
      value: score?.commerceScore,
      status: score?.pillarStatuses.commerce,
      href: websiteWorkspacePath(projectId, 'commerce'),
      icon: <ShoppingBag className="h-4 w-4" />,
    },
  ]
    .filter((item) => item.label !== 'Commerce' || !project || showsCommerce(project, score))
    .map((item) => ({
      ...item,
      ...scoreState(item.label, item.value, item.status, auditStatus),
    }));
  const current = audits.find((audit) => ['queued', 'running'].includes(audit.status));
  const [visibleAudits, setVisibleAudits] = useState(10);
  const actionsQuery = useQuery({
    queryKey: ['ai-visibility-recommendations', projectId, data?.measurementAudit?.id],
    queryFn: () => aiVisibilityApi.recommendations(projectId, data?.measurementAudit?.id),
  });
  const severityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  const nextActions = (actionsQuery.data?.recommendations || [])
    .filter((item) => ['open', 'in_progress'].includes(item.status))
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))
    .slice(0, 3);
  const previousMeasurement = data?.scoreHistory?.find(
    (item) =>
      item.audit.id !== data.measurementAudit?.id &&
      item.score.scoringVersion === score?.scoringVersion &&
      item.audit.inputSnapshot?.project?.configurationRevision ===
        data.measurementAudit?.inputSnapshot?.project?.configurationRevision,
  );
  // A change in SEO checks moves the score without the site changing, so never present it as a gain or loss.
  const seoChecksChanged = Boolean(
    previousMeasurement &&
      typeof previousMeasurement.seoRuleVersion === 'number' &&
      typeof data?.measurementSeoRuleVersion === 'number' &&
      previousMeasurement.seoRuleVersion !== data.measurementSeoRuleVersion,
  );
  const previousScore = seoChecksChanged ? undefined : previousMeasurement?.score;
  const seoRuleByAudit = new Map(
    (data?.scoreHistory || []).map((item) => [item.audit.id, item.seoRuleVersion] as const),
  );
  const olderSeoChecks = (auditId: number) => {
    const version = seoRuleByAudit.get(auditId);
    return (
      typeof version === 'number' &&
      typeof data?.currentSeoRuleVersion === 'number' &&
      version < data.currentSeoRuleVersion
    );
  };
  const scoreChange =
    previousScore && score
      ? Math.round(Number(score.overallScore) - Number(previousScore.overallScore))
      : null;
  // Each analysis raises the same kinds of alert again; the newest of each kind is the one that matters.
  const recentAlerts = (alertsQuery.data?.alerts || [])
    .filter(
      (alert, index, all) => all.findIndex((other) => other.title === alert.title) === index,
    )
    .slice(0, 5);
  const providerCredits = estimate?.lineItems.find(
    (item) => item.key === 'ai_visibility_provider_prompt',
  )?.maximumCredits;
  return (
    <div className="space-y-5">
      {current && (
        <Link
          href={`/dashboard/ai-visibility/audits/${current.id}`}
          className="group block rounded-2xl border border-primary/30 bg-primary/5 transition-colors hover:bg-primary/10"
        >
          <div className="flex items-center gap-3 p-4 sm:p-5">
            <Spinner size="md" label={null} className="shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Analyzing this website</div>
              <div className="text-sm text-muted-foreground">Open live progress</div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
          </div>
        </Link>
      )}
      <section aria-label="Visibility scores" className="grid gap-4 lg:grid-cols-[1.25fr_2fr]">
        <Card className="overflow-hidden">
          <CardContent className="flex h-full min-h-36 flex-col justify-between p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 text-sm font-medium">
                <CircleGauge className="h-4 w-4 text-muted-foreground" />
                Overall visibility
              </div>
              {data?.measurementAudit && statusBadge(data.measurementAudit.status)}
            </div>
            <div className="mt-4 flex items-end justify-between gap-4">
              <div>
                <div className="font-mono text-4xl font-semibold tracking-tight">
                  {overall.value}
                </div>
                {overall.note && (
                  <div className="mt-2 text-sm text-muted-foreground">{overall.note}</div>
                )}
                {/* Only measurements with the same scoring version and settings are compared. */}
                {scoreChange !== null && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        'font-mono font-semibold',
                        scoreChange > 0 && 'text-[#0a8a0a] dark:text-[#0ca30c]',
                        scoreChange < 0 && 'text-[#d03b3b]',
                      )}
                    >
                      {scoreChange > 0 ? '+' : ''}
                      {scoreChange}
                    </span>{' '}
                    since last comparable measurement
                  </p>
                )}
                {seoChecksChanged && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Not compared: SEO checks changed since the last measurement.
                  </p>
                )}
              </div>
              <div className="text-right text-xs text-muted-foreground">
                {typeof data?.openRecommendations === 'number' && (
                  <>
                    <strong className="block font-mono text-2xl font-semibold text-foreground">
                      {data.openRecommendations}
                    </strong>
                    open fix{data.openRecommendations === 1 ? '' : 'es'}
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-2">
          {scoreCards.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="group rounded-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Card className="h-full overflow-hidden transition-colors hover:bg-muted/30">
                <CardContent className="flex min-h-24 items-center justify-between gap-4 p-5">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      {item.icon}
                      {item.label}
                    </div>
                    {item.note && (
                      <div className="mt-2 text-xs text-muted-foreground">{item.note}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-3xl font-semibold tracking-tight">
                      {item.value}
                    </span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>
      <section aria-label="Three next actions" className="border-y py-4">
        <h2 className="font-semibold">Next actions</h2>
        {actionsQuery.isLoading ? (
          <p role="status">Loading actions…</p>
        ) : actionsQuery.isError ? (
          <InlineError
            message="Recommended next actions could not be loaded."
            onRetry={() => actionsQuery.refetch()}
          />
        ) : nextActions.length ? (
          <ol className="mt-2 divide-y">
            {nextActions.map((item, index) => (
              <li key={item.id}>
                <Link
                  className="flex items-start gap-3 py-3 text-sm hover:bg-muted"
                  href={websiteWorkspacePath(projectId, 'fixes') + `?fix=${item.id}`}
                >
                  <span className="font-mono text-muted-foreground">0{index + 1}</span>
                  <span className="flex-1">
                    <strong className="font-medium">
                      {recommendationTitle(item)}
                    </strong>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {item.module.toUpperCase()} · {item.effort} effort ·{' '}
                      {item.affectedUrl || 'Site-wide'}
                    </span>
                  </span>
                  {statusBadge(item.severity)}
                  <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {data?.measurementAudit
              ? 'No open actions in this measurement.'
              : 'Start an analysis to identify the next actions.'}
          </p>
        )}
      </section>
      {alertsQuery.isLoading ? (
        <p role="status">Loading alerts…</p>
      ) : alertsQuery.isError ? (
        <InlineError
          message="Visibility alerts could not be loaded."
          onRetry={() => alertsQuery.refetch()}
        />
      ) : null}
      {recentAlerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent visibility alerts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentAlerts.map((alert) => (
              <div
                key={alert.id}
                className={`rounded-lg border p-4 ${alert.acknowledgedAt ? 'opacity-65' : ''}`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{alert.title}</span>
                      {statusBadge(alert.severity)}
                      {alert.acknowledgedAt && <Badge variant="outline">Acknowledged</Badge>}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{alert.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {alert.auditId ? `Analysis #${alert.auditId} · ` : ''}
                      {new Date(alert.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {!alert.acknowledgedAt && can.edit && (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={acknowledge.isPending && acknowledge.variables === alert.id}
                      loadingText="Acknowledge"
                      onClick={() => acknowledge.mutate(alert.id)}
                    >
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Acknowledge
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader className="gap-4 border-b bg-muted/20 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Analysis history</CardTitle>
            {estimate && (
              <CardDescription
                className="mt-1.5"
                title={`Includes up to ${providerCredits ?? 0} credits for ${estimate.assumptions.providerRequests} AI provider requests across ${estimate.assumptions.providers} providers${estimate.assumptions.automaticCompetitorLimit ? ` and up to ${estimate.assumptions.automaticCompetitorLimit} discovered competitors` : ''}.`}
              >
                A new analysis costs up to {estimate.estimatedMaximum} credits.
              </CardDescription>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            loading={analysisPending}
            loadingText="Analyzing"
            disabled={!can.bill || !estimate}
            onClick={onAnalyze}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {audits.length ? 'Analyze again' : 'Analyze website'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 p-3 sm:p-4">
          {audits.length ? (
            audits.slice(0, visibleAudits).map((audit) => (
              <Link
                key={audit.id}
                href={`/dashboard/ai-visibility/audits/${audit.id}`}
                className="group flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="font-medium">{new Date(audit.createdAt).toLocaleString()}</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {!['completed', 'completed_with_warnings'].includes(audit.status)
                      ? audit.status === 'failed'
                        ? audit.error || 'Analysis failed before completion'
                        : `Analysis ${audit.status}`
                      : audit.warningCount
                        ? `${audit.warningCount} warning${audit.warningCount === 1 ? '' : 's'}`
                        : 'No warnings'}
                    {olderSeoChecks(audit.id) && (
                      <span className="ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        Older SEO checks
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {statusBadge(audit.status)}
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            ))
          ) : (
            <Empty message="No analyses yet. Use Analyze website when you are ready to spend credits and create a verified report." />
          )}
          {visibleAudits < audits.length && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVisibleAudits((count) => count + 10)}
            >
              Show more analyses
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function auditStageWarning(stage: { stageKey: string; warning: string | null }) {
  if (
    stage.stageKey === 'report_generation' &&
    stage.warning &&
    /EACCES|permission denied|not writable/i.test(stage.warning)
  ) {
    return 'The PDF could not be saved because report storage is temporarily unavailable. The analysis results are safe; repair the uploads volume and retry the PDF without another analysis charge.';
  }
  return stage.warning;
}

function StageOutputSummary({ stage, projectId }: { stage: AuditStage; projectId: number }) {
  const output = stage.output || {};
  const number = (key: string) =>
    typeof output[key] === 'number' ? (output[key] as number) : null;
  if (stage.stageKey === 'brand_crawl') {
    const stats = [
      ['Pages found', number('pages')],
      ['Crawled', number('successes')],
      ['Unavailable', number('failures')],
      ['Links checked', number('checkedLinks')],
    ].filter((item): item is [string, number] => item[1] !== null);
    return stats.length ? (
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-background px-3 py-2">
            <strong className="block text-lg">{value}</strong>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
    ) : null;
  }
  if (stage.stageKey === 'provider_collection') {
    const requests = number('requests');
    const failures = number('failures');
    const reasons =
      output.failureReasons &&
      typeof output.failureReasons === 'object' &&
      !Array.isArray(output.failureReasons)
        ? Object.entries(output.failureReasons as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          )
        : [];
    return (
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline">{requests ?? 0} requested</Badge>
          {number('excluded') !== undefined && (
            <Badge variant="outline">{number('excluded')} excluded (not configured)</Badge>
          )}
          <Badge variant={failures ? 'secondary' : 'outline'}>{failures ?? 0} failed</Badge>
        </div>
        {reasons.map(([provider, reason]) => (
          <div key={provider} className="rounded-lg border bg-background p-3 text-xs leading-5">
            <strong className="capitalize">{provider}</strong>
            <span className="ml-2 text-muted-foreground">{reason}</span>
          </div>
        ))}
      </div>
    );
  }
  if (
    stage.stageKey === 'competitor_analysis' &&
    Array.isArray(output.discoveredCompetitors) &&
    output.discoveredCompetitors.length > 0
  ) {
    return (
      <p className="mt-3 text-sm">
        {output.discoveredCompetitors.length} competitors discovered automatically and included in
        this analysis.
      </p>
    );
  }
  if (
    ['competitor_crawls', 'competitor_analysis'].includes(stage.stageKey) &&
    (stage.status === 'skipped' || number('competitors') === 0)
  ) {
    return (
      <Button asChild size="sm" variant="outline" className="mt-3">
        <Link href={websiteWorkspacePath(projectId, 'competitors')}>
          <Plus className="mr-2 h-4 w-4" />
          Add competitors
        </Link>
      </Button>
    );
  }
  return null;
}

function AuditStageIcon({ status, index }: { status: string; index: number }) {
  if (status === 'completed') return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (status === 'warning') return <ShieldAlert className="h-5 w-5 text-amber-500" />;
  if (status === 'running') return <Spinner size="md" label={null} className="text-primary" />;
  if (status === 'skipped') return <SkipForward className="h-5 w-5 text-muted-foreground" />;
  if (status === 'failed' || status === 'cancelled')
    return <XCircle className="h-5 w-5 text-destructive" />;
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border text-[10px] text-muted-foreground">
      {index + 1}
    </span>
  );
}

export function AiVisibilityAuditDetail({ auditId }: { auditId: number }) {
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [reportQueued, setReportQueued] = useState(false);
  const query = useQuery({
    queryKey: ['ai-visibility-audit', auditId],
    queryFn: () => aiVisibilityApi.getAudit(auditId),
    refetchInterval: (query) =>
      reportQueued ||
      ['queued', 'running'].includes(query.state.data?.audit.status || '') ||
      query.state.data?.audit.stages?.some((stage) => stage.status === 'running')
        ? 3000
        : false,
  });
  const cancel = useMutation({
    mutationFn: () => aiVisibilityApi.cancelAudit(auditId),
    onSuccess: () => query.refetch(),
    onError: (error) =>
      toast({
        title: 'Could not cancel audit',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const retryReport = useMutation({
    mutationFn: () => aiVisibilityApi.retryReport(auditId),
    onSuccess: () => {
      setReportQueued(true);
      query.refetch();
      toast({
        title: 'Report retry queued',
        description:
          'The PDF will be rebuilt from the completed analysis without another credit charge.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Could not retry report',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const audit = query.data?.audit;
  const projectQuery = useQuery({
    queryKey: ['ai-visibility-project', audit?.projectId],
    queryFn: () => aiVisibilityApi.getProject(audit!.projectId),
    enabled: Boolean(audit),
  });
  const can = capabilities(projectQuery.data?.project.workspace?.role);
  const reportStageStatus = audit?.stages?.find(
    (stage) => stage.stageKey === 'report_generation',
  )?.status;
  useEffect(() => {
    if (!audit?.projectId) return;
    if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(audit.status))
      void refreshVisibility(queryClient, audit.projectId);
    if (reportStageStatus === 'completed') setReportQueued(false);
  }, [audit?.id, audit?.status, reportStageStatus, queryClient]);
  useEffect(() => {
    if (!reportQueued) return;
    const timeout = setTimeout(() => setReportQueued(false), 180000);
    return () => clearTimeout(timeout);
  }, [reportQueued]);
  const progress = useMemo(
    () =>
      audit?.stages?.length
        ? Math.round(
            audit.stages.reduce(
              (sum, stage) =>
                sum +
                (['completed', 'warning', 'skipped'].includes(stage.status)
                  ? 100
                  : stage.progress || 0),
              0,
            ) / audit.stages.length,
          )
        : 0,
    [audit],
  );
  if (query.isLoading) return <Loading />;
  if (query.isError || !audit)
    return (
      <div className="mx-auto w-full max-w-[900px] px-4 py-10">
        <InlineError message="The analysis details could not be loaded. Return to AI Visibility and try again." />
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.push('/dashboard/ai-visibility')}
        >
          Back to AI Visibility
        </Button>
      </div>
    );
  const reportRetryAvailable =
    ['completed', 'completed_with_warnings'].includes(audit.status) &&
    audit.stages?.some(
      (stage) => stage.stageKey === 'report_generation' && stage.status === 'warning',
    );
  const warningCount = audit.stages?.filter((stage) => stage.status === 'warning').length || 0;
  const skippedCount = audit.stages?.filter((stage) => stage.status === 'skipped').length || 0;
  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-8 px-4 pb-12 pt-6 sm:px-6 sm:pt-8 lg:px-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Button
            variant="ghost"
            className="h-auto p-0 text-primary hover:bg-transparent hover:text-primary/80"
            onClick={() => router.push(websiteWorkspacePath(audit.projectId))}
          >
            ← Website overview
          </Button>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            Analysis #{audit.id}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {statusBadge(audit.status)}
            <span className="text-sm text-muted-foreground">
              Started {new Date(audit.createdAt).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can.edit && reportRetryAvailable && (
            <Button
              variant="outline"
              onClick={() => retryReport.mutate()}
              loading={retryReport.isPending}
              disabled={reportQueued}
            >
              Retry PDF report
            </Button>
          )}
          {can.edit && ['queued', 'running'].includes(audit.status) && (
            <Button
              variant="outline"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending || audit.cancellationRequested}
            >
              {audit.cancellationRequested ? 'Cancellation requested…' : 'Cancel analysis'}
            </Button>
          )}
        </div>
      </header>
      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/20">
          <div className="flex items-end justify-between gap-4">
            <div>
              <CardTitle>Analysis progress</CardTitle>
              <CardDescription className="mt-1.5">
                Completed stages are saved and will not repeat after a worker restart.
                {['queued', 'running'].includes(audit.status) &&
                  ' Cancellation takes effect between stages; an active stage may finish.'}
              </CardDescription>
            </div>
            <div className="text-3xl font-semibold tracking-tight">{progress}%</div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          <Progress value={progress} />
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
            <span>{audit.stages?.length || 0} stages</span>
            <span>
              {warningCount} warning{warningCount === 1 ? '' : 's'}
            </span>
            <span>{skippedCount} not applicable</span>
          </div>
        </CardContent>
      </Card>
      <section aria-label="Analysis stages" className="space-y-3">
        {audit.stages?.map((stage, index) => {
          const warning = auditStageWarning(stage);
          return (
            <Card
              key={stage.id}
              className={
                stage.status === 'warning'
                  ? 'border-amber-500/30'
                  : stage.status === 'failed'
                    ? 'border-destructive/30'
                    : ''
              }
            >
              <CardContent className="flex gap-4 p-4 sm:p-5">
                <div className="mt-0.5">
                  <AuditStageIcon status={stage.status} index={index} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-medium capitalize">
                      {stage.stageKey.replaceAll('_', ' ')}
                    </h2>
                    {statusBadge(stage.status)}
                  </div>
                  {warning && (
                    <Callout tone="warning" className="mt-3">
                      {warning}
                    </Callout>
                  )}
                  {stage.error && (
                    <Callout tone="danger" announce={false} className="mt-3">
                      {stage.error}
                    </Callout>
                  )}
                  {stage.status === 'skipped' && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      This optional stage did not apply to the current website configuration.
                    </p>
                  )}
                  <StageOutputSummary stage={stage} projectId={audit.projectId} />
                  <div className="mt-2 text-xs text-muted-foreground">
                    {stage.attemptCount} attempt
                    {stage.attemptCount === 1 ? '' : 's'}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}
