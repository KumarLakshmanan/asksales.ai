'use client';

import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  aiVisibilityApi,
  type AiVisibilityProject,
  type WebsiteSearchInput,
} from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Radar, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';

import {
  Empty,
  formatScore,
  InlineError,
  statusBadge,
  websiteHost,
  websiteWorkspacePath,
  type WebsiteSummary,
} from './workspace-ui';
export function AiVisibilityPortfolio() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const projectsQuery = useQuery({
    queryKey: ['ai-visibility-projects'],
    queryFn: aiVisibilityApi.listProjects,
  });
  const websitesQuery = useQuery({
    queryKey: ['ai-visibility-website-searches'],
    queryFn: aiVisibilityApi.listWebsiteSearches,
  });
  const [addWebsiteOpen, setAddWebsiteOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [health, setHealth] = useState('all');
  const [visible, setVisible] = useState(20);
  const [removeTarget, setRemoveTarget] = useState<AiVisibilityProject | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState('');
  const resolved = useQuery({
    queryKey: ['ai-visibility-resolved-project', 'default'],
    queryFn: () => aiVisibilityApi.resolveProject(null),
  });

  const websites = useMemo<WebsiteSummary[]>(() => {
    const summaries = websitesQuery.data?.websites || [];
    const summaryByProject = new Map(summaries.map((item) => [item.project.id, item]));
    const projects = projectsQuery.data?.projects || [];
    const merged = projects.map((project) => {
      const summary = summaryByProject.get(project.id);
      return summary
        ? { ...summary, project }
        : { project, auditCount: 0, latestAudit: null, latestScore: null };
    });
    for (const summary of summaries) {
      if (!merged.some((item) => item.project.id === summary.project.id)) merged.push(summary);
    }
    const profileProject = resolved.data?.project;
    if (profileProject && !merged.some((item) => item.project.id === profileProject.id)) {
      merged.unshift(
        summaryByProject.get(profileProject.id) || {
          project: profileProject,
          auditCount: 0,
          latestAudit: null,
          latestScore: null,
        },
      );
    }
    return merged.sort((a, b) => {
      if (a.project.source === 'business_profile' && b.project.source !== 'business_profile')
        return -1;
      if (b.project.source === 'business_profile' && a.project.source !== 'business_profile')
        return 1;
      return new Date(b.project.updatedAt).getTime() - new Date(a.project.updatedAt).getTime();
    });
  }, [projectsQuery.data?.projects, resolved.data?.project, websitesQuery.data?.websites]);

  const rememberProject = (added: AiVisibilityProject) => {
    queryClient.invalidateQueries({ queryKey: ['ai-visibility-projects'] });
    queryClient.invalidateQueries({
      queryKey: ['ai-visibility-website-searches'],
    });
    router.push(websiteWorkspacePath(added.id));
  };

  const removeWebsite = useMutation({
    mutationFn: (id: number) => aiVisibilityApi.archiveProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-visibility-projects'] });
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-website-searches'],
      });
      queryClient.invalidateQueries({ queryKey: ['ai-visibility-workspaces'] });
      setRemoveTarget(null);
      setRemoveConfirmation('');
      toast({
        title: 'Website removed',
        description: 'Its previous analyses remain archived and can be recovered by support.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Website could not be removed',
        description: error instanceof Error ? error.message : 'Try again.',
        variant: 'destructive',
      }),
  });

  const openRemoveDialog = (project: AiVisibilityProject) => {
    setRemoveTarget(project);
    setRemoveConfirmation('');
  };

  const hasPortfolioData = Boolean(projectsQuery.data || websitesQuery.data || resolved.data);
  if (!hasPortfolioData && (projectsQuery.isLoading || websitesQuery.isLoading || resolved.isLoading))
    return (
      <LoadingState className="min-h-80 py-0" label="Loading websites…" />
    );
  const loadErrors = [
    projectsQuery.isError
      ? `Accessible website list: ${projectsQuery.error instanceof Error ? projectsQuery.error.message : 'request failed.'}`
      : '',
    websitesQuery.isError
      ? `Website status summaries: ${websitesQuery.error instanceof Error ? websitesQuery.error.message : 'request failed.'}`
      : '',
    resolved.isError
      ? `Business Profile website match: ${resolved.error instanceof Error ? resolved.error.message : 'request failed.'}`
      : '',
  ].filter(Boolean);

  if (loadErrors.length > 0 && !hasPortfolioData)
    return (
      <InlineError
        title="AI Visibility website data could not be loaded"
        message={loadErrors.join(' ')}
        onRetry={() => {
          void projectsQuery.refetch();
          void websitesQuery.refetch();
          void resolved.refetch();
        }}
      />
    );

  const analyzedCount = websites.filter((item) => item.latestScore).length;
  const attentionCount = websites.filter(
    (item) =>
      item.latestAudit?.status === 'failed' ||
      item.latestAudit?.status === 'completed_with_warnings',
  ).length;

  const state = (item: WebsiteSummary) =>
    ['queued', 'running'].includes(item.latestAudit?.status || '')
      ? 'running'
      : item.latestAudit?.status === 'completed_with_warnings'
        ? 'partial'
        : item.latestAudit?.status === 'failed'
          ? 'failed'
          : item.latestScore
            ? 'complete'
            : 'never';
  const filtered = websites.filter(
    (item) =>
      [item.project.name, item.project.domain]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (health === 'all' || state(item) === health),
  );
  return (
    <div
      className="mx-auto w-full max-w-[1320px] space-y-5 px-4 pb-12 pt-6 sm:px-6 sm:pt-8 lg:px-10"
    >
      {loadErrors.length > 0 && (
        <InlineError
          title="Some AI Visibility website data is unavailable"
          message={loadErrors.join(' ')}
          onRetry={() => {
            void projectsQuery.refetch();
            void websitesQuery.refetch();
            void resolved.refetch();
          }}
        />
      )}
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Radar className="h-5 w-5" />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              SEO · AEO · GEO
            </div>
            <h1
              id="ai-visibility-title"
              className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              AI Visibility websites
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Manage websites for your selected business profile.
            </p>
          </div>
        </div>
        <Button className="h-11 w-full shrink-0 sm:w-auto" onClick={() => setAddWebsiteOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add website
        </Button>
      </header>
      <AddWebsiteDialog
        open={addWebsiteOpen}
        onOpenChange={setAddWebsiteOpen}
        onAdded={rememberProject}
      />
      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open && !removeWebsite.isPending) {
            setRemoveTarget(null);
            setRemoveConfirmation('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.name}?</DialogTitle>
            <DialogDescription>
              This website will disappear from AI Visibility and monitoring will stop. Its existing
              analyses, reports, and generated assets remain archived.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="remove-website-confirmation">
              Type{' '}
              <span className="font-semibold text-foreground">
                {removeTarget ? websiteHost(removeTarget.domain) : ''}
              </span>{' '}
              to confirm
            </Label>
            <Input
              id="remove-website-confirmation"
              value={removeConfirmation}
              onChange={(event) => setRemoveConfirmation(event.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={removeWebsite.isPending}
              onClick={() => {
                setRemoveTarget(null);
                setRemoveConfirmation('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                !removeTarget ||
                removeConfirmation.trim().toLowerCase() !==
                  websiteHost(removeTarget.domain).toLowerCase()
              }
              loading={removeWebsite.isPending}
              loadingText="Remove website"
              onClick={() => removeTarget && removeWebsite.mutate(removeTarget.id)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Remove website
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {websites.length > 0 && (
        <section
          aria-label="Website portfolio summary"
          className="grid grid-cols-3 divide-x border-y py-3"
        >
          <PortfolioStat
            value={websites.length}
            label={websites.length === 1 ? 'Website' : 'Websites'}
          />
          <PortfolioStat value={analyzedCount} label="Analyzed" />
          <PortfolioStat value={attentionCount} label="Need attention" />
        </section>
      )}
      <div className="flex flex-wrap gap-3">
        <Input
          className="sm:max-w-sm"
          aria-label="Search websites"
          placeholder="Search website or brand"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setVisible(20);
          }}
        />
        <label className="text-sm">
          Measurement state
          <select
            className="ml-2 rounded border bg-background p-2"
            value={health}
            onChange={(event) => {
              setHealth(event.target.value);
              setVisible(20);
            }}
          >
            <option value="all">All websites</option>
            <option value="never">Never analyzed</option>
            <option value="running">Analysis running</option>
            <option value="partial">Partial / warnings</option>
            <option value="complete">Complete</option>
            <option value="failed">Failed attempt</option>
          </select>
        </label>
      </div>
      {resolved.isError && (
        <InlineError
          message="The Business Profile website could not be loaded. Saved websites are shown below."
          onRetry={() => resolved.refetch()}
        />
      )}
      <section aria-labelledby="ai-visibility-title" className="space-y-3">
        {filtered.length ? (
          filtered
            .slice(0, visible)
            .map((website) => (
              <WebsitePortfolioCard
                key={website.project.id}
                website={website}
                onRemove={openRemoveDialog}
              />
            ))
        ) : (
          <Card>
            <CardContent className="py-12">
              <Empty
                message={
                  websites.length
                    ? 'No websites match these filters.'
                    : resolved.data?.missingWebsite
                      ? 'Your Business Profile has no public website yet. Add a website here or update the Business Profile.'
                      : 'Add a website to start your first analysis.'
                }
              />
            </CardContent>
          </Card>
        )}
      </section>
      {visible < filtered.length && (
        <Button variant="outline" onClick={() => setVisible((count) => count + 20)}>
          Show more websites
        </Button>
      )}
    </div>
  );
}

export function PortfolioStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0 px-3 sm:px-5">
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs font-medium text-muted-foreground">{label}</div>
    </div>
  );
}

export function WebsitePortfolioCard({
  website,
  onRemove,
}: {
  website: WebsiteSummary;
  onRemove: (project: AiVisibilityProject) => void;
}) {
  const { project, latestAudit, latestScore, auditCount } = website;
  const running = ['queued', 'running'].includes(latestAudit?.status || '');
  return (
    <article className="flex flex-col gap-4 border-b py-4 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">
          <Link
            href={websiteWorkspacePath(project.id)}
            className="hover:text-primary hover:underline"
          >
            {project.name}
          </Link>
        </h2>
        {project.workspace?.workspaceKind === 'client' && (
          <p className="mt-1 text-xs text-muted-foreground">Client workspace</p>
        )}
        <p className="mt-1 break-all text-sm text-muted-foreground">
          {websiteHost(project.domain)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {project.locale} · {project.targetGeography || project.country} · {auditCount} analyses
          {latestScore?.createdAt &&
            ` · Measured ${new Date(latestScore.createdAt).toLocaleDateString()}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-5">
        <div>
          <strong className="font-mono text-2xl">
            {formatScore(latestScore?.overallScore) ?? '—'}
          </strong>
          <p className="text-xs text-muted-foreground">Overall</p>
        </div>
        {[
          { label: 'SEO', score: latestScore?.seoScore },
          { label: 'AEO', score: latestScore?.aeoScore },
          { label: 'GEO', score: latestScore?.geoScore },
        ].map((item) => (
          <div key={item.label}>
            <strong className="font-mono text-lg">{formatScore(item.score) ?? '—'}</strong>
            <p className="text-xs text-muted-foreground">{item.label}</p>
          </div>
        ))}
        <div>
          {statusBadge(
            running
              ? 'running'
              : latestAudit?.status === 'completed_with_warnings'
                ? 'partial'
                : latestAudit?.status === 'failed'
                  ? 'failed'
                  : latestScore
                    ? 'complete'
                    : 'never_analyzed',
          )}
          {running && latestScore && (
            <p className="mt-1 text-xs text-muted-foreground">Previous scores retained</p>
          )}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={websiteWorkspacePath(project.id)}>Open website →</Link>
        </Button>
        {['owner', 'billing_admin'].includes(project.workspace?.role || '') && project.source !== 'business_profile' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={running}
            onClick={() => onRemove(project)}
            aria-label={`Remove ${project.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </article>
  );
}

export function AddWebsiteDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (project: AiVisibilityProject) => void;
}) {
  const { toast } = useToast();
  const [website, setWebsite] = useState('');
  const [name, setName] = useState('');
  const [scoringProfile, setScoringProfile] =
    useState<WebsiteSearchInput['scoringProfile']>('general');
  const [country, setCountry] = useState('US');
  const [locale, setLocale] = useState('en-US');
  const [targetGeography, setTargetGeography] = useState('');
  const add = useMutation({
    mutationFn: async () => {
      const target = await aiVisibilityApi.resolveWebsiteSearch({
        website,
        name: name.trim() || undefined,
        scoringProfile,
        country,
        locale,
        targetGeography: targetGeography.trim() || undefined,
      });
      return { target };
    },
    onSuccess: ({ target }) => {
      onAdded(target.project);
      onOpenChange(false);
      setWebsite('');
      setName('');
      setScoringProfile('general');
      setCountry('US');
      setLocale('en-US');
      setTargetGeography('');
      toast({
        title: 'Website added',
        description: 'Review the cost estimate, then start its first analysis.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Website could not be added',
        description: error instanceof Error ? error.message : 'Check the URL and try again.',
        variant: 'destructive',
      }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (website.trim()) add.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Add website</DialogTitle>
            <DialogDescription>
              Add a public website, then review its analysis cost and provider readiness. Adding the
              website does not start a paid run.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="website-url">Website URL</Label>
              <Input
                id="website-url"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                placeholder="https://example.com"
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website-name">
                Website or brand name{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="website-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Example"
              />
            </div>
            <details className="rounded-lg border px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium">
                Analysis settings{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </summary>
              <div className="mt-4 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Business type</Label>
                    <Select
                      value={scoringProfile}
                      onValueChange={(value) =>
                        setScoringProfile(value as WebsiteSearchInput['scoringProfile'])
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="general">General business</SelectItem>
                        <SelectItem value="b2b_saas">B2B SaaS</SelectItem>
                        <SelectItem value="ecommerce">Ecommerce</SelectItem>
                        <SelectItem value="local_business">Local business</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="target-market">Target market</Label>
                    <Input
                      id="target-market"
                      value={targetGeography}
                      onChange={(event) => setTargetGeography(event.target.value)}
                      placeholder="United States"
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="website-country">Country code</Label>
                    <Input
                      id="website-country"
                      value={country}
                      maxLength={2}
                      onChange={(event) => setCountry(event.target.value.toUpperCase())}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="website-locale">Locale</Label>
                    <Input
                      id="website-locale"
                      value={locale}
                      onChange={(event) => setLocale(event.target.value)}
                      placeholder="en-US"
                    />
                  </div>
                </div>
              </div>
            </details>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !website.trim() || country.length !== 2 || locale.trim().length < 2
              }
              loading={add.isPending}
            >
              Add website & review estimate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
