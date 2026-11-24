'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { aiVisibilityApi } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { refreshVisibility, useMeasurement } from './workspace-context';
import { Empty, formatPercent, InlineError, Loading, websiteWorkspacePath } from './workspace-ui';
export function CompetitorView({ projectId }: { projectId: number }) {
  const { auditId, can, historical, overview, project } = useMeasurement();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editDomain, setEditDomain] = useState('');
  const [analysisNeeded, setAnalysisNeeded] = useState(false);
  // Website typed or found for each suggestion that arrived without one, keyed by name.
  const [suggestedWebsites, setSuggestedWebsites] = useState<
    Record<string, { website: string; message?: string }>
  >({});
  const competitorFormRef = useRef<HTMLFormElement>(null);
  const query = useQuery({
    queryKey: ['ai-visibility-competitors', projectId],
    queryFn: () => aiVisibilityApi.competitors(projectId),
  });
  const estimate = useQuery({
    queryKey: ['ai-visibility-audit-estimate', projectId],
    queryFn: () => aiVisibilityApi.estimate(projectId),
  });
  const suggestions = useQuery({
    queryKey: ['ai-visibility-competitor-suggestions', projectId],
    queryFn: () => aiVisibilityApi.suggestCompetitors(projectId),
  });
  const intelligence = useQuery({
    queryKey: ['ai-visibility-competitor-intelligence', projectId, auditId],
    queryFn: () => aiVisibilityApi.competitorIntelligence(projectId, auditId),
  });
  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: ['ai-visibility-competitors', projectId],
    });
    queryClient.invalidateQueries({
      queryKey: ['ai-visibility-competitor-suggestions', projectId],
    });
    queryClient.invalidateQueries({
      queryKey: ['ai-visibility-competitor-intelligence', projectId],
    });
  };
  const add = useMutation({
    mutationFn: () =>
      aiVisibilityApi.addCompetitor(projectId, {
        name: name.trim(),
        domain: domain.trim(),
      }),
    onSuccess: () => {
      void refreshVisibility(queryClient, projectId);
      setName('');
      setDomain('');
      setAnalysisNeeded(true);
      refresh();
      toast({
        title: 'Competitor added',
        description: 'Analyze again to include it in verified comparisons.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Could not add competitor',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const trackSuggestion = useMutation({
    mutationFn: (input: { name: string; domain: string; aliases?: string[] }) =>
      aiVisibilityApi.addCompetitor(projectId, input),
    onSuccess: () => {
      void refreshVisibility(queryClient, projectId);
      setAnalysisNeeded(true);
      refresh();
      toast({
        title: 'Competitor added',
        description: 'Analyze again to include it in verified comparisons.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Could not track competitor',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const lookup = useMutation({
    mutationFn: (name: string) => aiVisibilityApi.lookupCompetitorWebsite(projectId, name),
    onSuccess: (result, name) =>
      setSuggestedWebsites((current) => ({
        ...current,
        [name]: {
          website: result.website && result.trackable ? result.website : current[name]?.website || '',
          message: result.message,
        },
      })),
    onError: (error, name) =>
      setSuggestedWebsites((current) => ({
        ...current,
        [name]: {
          website: current[name]?.website || '',
          message: error instanceof Error ? error.message : 'The website search failed.',
        },
      })),
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      aiVisibilityApi.updateCompetitor(projectId, id, { active }),
    onSuccess: () => {
      void refreshVisibility(queryClient, projectId);
      setAnalysisNeeded(true);
      refresh();
      toast({
        title: 'Competitor tracking updated',
        description: 'Analyze again to refresh the comparison.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Could not update competitor',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const save = useMutation({
    mutationFn: () =>
      aiVisibilityApi.updateCompetitor(projectId, editingId!, {
        name: editName.trim(),
        domain: editDomain.trim(),
      }),
    onSuccess: () => {
      void refreshVisibility(queryClient, projectId);
      setEditingId(null);
      setAnalysisNeeded(true);
      refresh();
      toast({
        title: 'Competitor updated',
        description: 'Analyze again to refresh the comparison.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Could not update competitor',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const analyze = useMutation({
    mutationFn: () => aiVisibilityApi.createAudit(projectId),
    onSuccess: () => {
      void refreshVisibility(queryClient, projectId);
      setAnalysisNeeded(false);
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-audits', projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-overview', projectId],
      });
      toast({
        title: 'Analysis started',
        description: 'Competitor comparisons will update automatically when it finishes.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Analysis could not start',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const brief = useMutation({
    mutationFn: ({ competitorId, gapKey }: { competitorId: number; gapKey: string }) =>
      aiVisibilityApi.generateCompetitorBrief(projectId, competitorId, gapKey),
    onSuccess: (result) => {
      void refreshVisibility(queryClient, projectId);
      router.push(websiteWorkspacePath(projectId, 'assets') + `?contentAsset=${result.asset.id}`);
    },
    onError: (error) =>
      toast({
        title: 'Brief could not be created',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const startEditing = (item: { id: number; name: string; domain: string }) => {
    setEditingId(item.id);
    setEditName(item.name);
    setEditDomain(item.domain);
  };
  const applySuggestion = (
    suggestion: NonNullable<typeof suggestions.data>['suggestions'][number],
  ) => {
    if (trackSuggestion.isPending) return;
    const domain = suggestion.domain || suggestedWebsites[suggestion.name]?.website.trim();
    if (domain)
      trackSuggestion.mutate({
        name: suggestion.name,
        domain,
        aliases: suggestion.aliases,
      });
  };
  const competitorCount = intelligence.data?.intelligence?.competitors?.length || 0;
  return (
    <div className="space-y-5">
      {(analysisNeeded || overview?.configurationChanged) && (
        <div className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div>
            <div className="font-medium">
              {analysisNeeded ? 'Competitor settings changed' : 'Analysis settings changed'}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Run a new analysis when you are ready to crawl the enabled competitors and refresh
              verified comparisons.{' '}
              {estimate.data
                ? `Up to ${estimate.data.estimate.estimatedMaximum} credits across ${estimate.data.estimate.assumptions.providerRequests} provider requests.`
                : 'Cost estimate unavailable.'}
            </p>
          </div>
          <Button
            className="shrink-0"
            loading={analyze.isPending}
            loadingText="Starting"
            disabled={!can.bill || !estimate.data}
            onClick={() => analyze.mutate()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Analyze with competitors
          </Button>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>How you compare in AI answers</CardTitle>
          <CardDescription>
            Each analysis compares you with the competitors switched on below. Suggestions come
            from businesses AI engines name and your Business Profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {intelligence.isLoading ? (
            <Loading />
          ) : intelligence.isError ? (
            <InlineError
              message="Competitive visibility could not be loaded."
              onRetry={() => intelligence.refetch()}
            />
          ) : !intelligence.data?.available ? (
            <Empty
              message={
                intelligence.data?.unavailableReason || 'Add a competitor and refresh the analysis.'
              }
            />
          ) : (
            <>
              {intelligence.data.intelligence.promptCount === 0 && (
                <Callout tone="warning" announce title="No AI answers to compare">
                  No AI engine answered in this analysis, so mentions, share of voice and citations
                  are not available. The page comparison below still applies.
                </Callout>
              )}
              <p className="text-sm text-muted-foreground">
                Based on {intelligence.data.intelligence.promptCount} AI answers. Share of voice is
                each brand&apos;s part of the {intelligence.data.intelligence.totalMentionEvents}{' '}
                brand mentions in these answers, among the brands listed here only; it is not
                market share.
              </p>
              {competitorCount > 0 && competitorCount < 3 && (
                <Callout tone="info" title="Too few competitors for a fair comparison">
                  You are compared with {competitorCount} competitor
                  {competitorCount === 1 ? '' : 's'}, so share of voice says little yet. Track at
                  least three from the suggestions below, then analyze again.
                </Callout>
              )}
              <div className="overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="p-3">Brand</th>
                      <th className="p-3">Named in</th>
                      <th className="p-3">Share of voice</th>
                      <th className="p-3">Wins</th>
                      <th className="p-3">Its pages cited</th>
                      <th className="p-3">Pages checked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {[
                      {
                        name: project?.name || 'Your brand',
                        metrics: intelligence.data.intelligence.brand,
                      },
                      ...intelligence.data.intelligence.competitors,
                    ].map((entry, index) => (
                      <tr key={index} className={index === 0 ? 'bg-primary/5' : ''}>
                        <th className="p-3 font-medium">{entry.name}</th>
                        <td className="p-3">
                          {entry.metrics.mentions} of {intelligence.data!.intelligence.promptCount}{' '}
                          answers
                        </td>
                        <td className="p-3">{formatPercent(entry.metrics.shareOfVoice)}</td>
                        <td className="p-3">{entry.metrics.promptWins}</td>
                        <td className="p-3">{entry.metrics.citationCount}</td>
                        <td className="p-3">{entry.metrics.crawledPages}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h2 className="pt-3 font-semibold">Pages competitors have that you don’t</h2>
              <p className="text-xs text-muted-foreground">
                From up to 25 of your pages, your sitemap, and 8 pages per competitor. Check your
                site before acting: a page may exist without being checked.
              </p>
              <div className="space-y-3">
                {intelligence.data.intelligence.competitors.map((competitor) => (
                  <div key={competitor.competitorId} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{competitor.name}</span>
                      {!competitor.active && <Badge variant="outline">Switched off</Badge>}
                      <a
                        href={competitor.domain}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-muted-foreground hover:underline"
                      >
                        {competitor.domain}
                      </a>
                    </div>
                    {competitor.contentGaps.length ? (
                      <div className="mt-3 space-y-2">
                        {competitor.contentGaps.map((gap) => (
                          <div
                            key={gap.key}
                            className="flex flex-col gap-3 rounded-lg bg-muted p-3 sm:flex-row sm:items-start sm:justify-between"
                          >
                            <div className="min-w-0">
                              <div className="font-medium">{gap.label}</div>
                              <div className="text-xs text-muted-foreground">
                                {competitor.name} has {gap.competitorPageCount}; none found on your
                                site.
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                                {gap.evidenceUrls.map((url, index) => (
                                  <a
                                    key={url}
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="max-w-sm truncate text-xs text-primary hover:underline"
                                  >
                                    {gap.evidenceUrls.length > 1
                                      ? `View their page ${index + 1}`
                                      : 'View their page'}
                                  </a>
                                ))}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              loading={brief.isPending && brief.variables?.gapKey === gap.key}
                              loadingText="Create brief"
                              disabled={
                                !can.edit ||
                                historical ||
                                (brief.isPending && brief.variables?.gapKey !== gap.key)
                              }
                              onClick={() =>
                                brief.mutate({
                                  competitorId: competitor.competitorId,
                                  gapKey: gap.key,
                                })
                              }
                            >
                              <FilePlus2 className="mr-2 h-4 w-4" />
                              Create brief
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No page types that you are missing.
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {intelligence.data.intelligence.citedDomains.length > 0 && (
                <div>
                  <div className="text-sm font-medium">Sites AI engines cite most</div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Being listed and reviewed on these sites helps AI engines find you.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {intelligence.data.intelligence.citedDomains.map((item) => (
                      <Badge
                        key={item.domain}
                        variant="secondary"
                        title={item.hosts && item.hosts.length > 1 ? item.hosts.join(', ') : undefined}
                      >
                        {item.domain} · {item.citations}
                        {item.hosts && item.hosts.length > 1
                          ? ` (${item.hosts.length} country sites)`
                          : ''}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Wins: answers that put you in the top three; for a competitor, answers that named it
                while you were not in the top three.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <details open className="border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">
          Competitors you track and suggestions
        </summary>
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
            <Card>
              <CardHeader>
                <CardTitle>Add competitor</CardTitle>
                <CardDescription>
                  A company and its own website. The next analysis compares you with it.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  ref={competitorFormRef}
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim() && domain.trim()) add.mutate();
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="competitor-name">Competitor name</Label>
                    <Input
                      id="competitor-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Competitor name"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="competitor-domain">Website URL</Label>
                    <Input
                      id="competitor-domain"
                      value={domain}
                      onChange={(event) => setDomain(event.target.value)}
                      placeholder="https://competitor.com"
                    />
                  </div>
                  <Button
                    type="submit"
                    loading={add.isPending}
                    loadingText="Add competitor"
                    disabled={!can.edit || !name.trim() || !domain.trim()}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add competitor
                  </Button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Tracked competitors</CardTitle>
                <CardDescription>
                  Switch one off to leave it out without losing its history. Changes apply from the
                  next analysis.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {query.isLoading ? (
                  <Loading />
                ) : query.isError ? (
                  <InlineError
                    message="Competitors could not be loaded."
                    onRetry={() => query.refetch()}
                  />
                ) : query.data?.competitors.length ? (
                  query.data.competitors.map((item) => (
                    <div key={item.id} className="rounded-lg border p-4">
                      {editingId === item.id ? (
                        <form
                          className="space-y-3"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (editName.trim() && editDomain.trim()) save.mutate();
                          }}
                        >
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Input
                              aria-label="Competitor name"
                              value={editName}
                              onChange={(event) => setEditName(event.target.value)}
                            />
                            <Input
                              aria-label="Competitor website"
                              value={editDomain}
                              onChange={(event) => setEditDomain(event.target.value)}
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="submit"
                              size="sm"
                              loading={save.isPending}
                              disabled={!can.edit || !editName.trim() || !editDomain.trim()}
                            >
                              Save
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="font-medium">{item.name}</div>
                            <a
                              className="block truncate text-sm text-muted-foreground hover:text-foreground hover:underline"
                              href={item.domain}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {item.domain}
                            </a>
                          </div>
                          <div className="flex items-center gap-3">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!can.edit}
                              onClick={() => startEditing(item)}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </Button>
                            <div className="flex items-center gap-2">
                              <Label
                                htmlFor={`competitor-active-${item.id}`}
                                className="text-sm text-muted-foreground"
                              >
                                Compared
                              </Label>
                              <Switch
                                id={`competitor-active-${item.id}`}
                                checked={item.active}
                                disabled={!can.edit || toggle.isPending}
                                onCheckedChange={(active) => toggle.mutate({ id: item.id, active })}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <Empty message="No competitors yet. Add one here or track a suggestion below." />
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Suggested competitors</CardTitle>
              <CardDescription>
                Businesses AI engines named or your Business Profile lists. Add each one&apos;s own
                website to track it.
                {can.bill && ' Find website searches the web for it and uses a few credits.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {suggestions.isLoading ? (
                <Loading />
              ) : suggestions.isError ? (
                <InlineError
                  message="Suggestions could not be loaded."
                  onRetry={() => suggestions.refetch()}
                />
              ) : suggestions.data?.suggestions.length ? (
                suggestions.data.suggestions.map((suggestion) => {
                  const entered = suggestedWebsites[suggestion.name];
                  const website = suggestion.domain || entered?.website.trim() || '';
                  const searching = lookup.isPending && lookup.variables === suggestion.name;
                  return (
                    <div
                      key={`${suggestion.name}-${suggestion.domain || 'no-domain'}`}
                      className="space-y-3 rounded-lg border p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="font-medium">{suggestion.name}</div>
                          {suggestion.domain && (
                            <a
                              className="mt-1 block truncate text-sm text-muted-foreground hover:text-foreground hover:underline"
                              href={suggestion.domain}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {suggestion.domain}
                            </a>
                          )}
                          <div className="mt-1 text-xs text-muted-foreground">
                            {suggestion.sources
                              .map(
                                (source) =>
                                  `${source.label}${source.evidenceCount > 1 ? ` (${source.evidenceCount} times)` : ''}`,
                              )
                              .join(' · ')}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!can.edit || !website || trackSuggestion.isPending}
                          onClick={() => applySuggestion(suggestion)}
                        >
                          Track competitor
                        </Button>
                      </div>
                      {!suggestion.domain && (
                        <div className="space-y-1.5">
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              aria-label={`Website of ${suggestion.name}`}
                              placeholder="Their own website, e.g. https://example.com"
                              value={entered?.website || ''}
                              disabled={!can.edit}
                              onChange={(event) =>
                                setSuggestedWebsites((current) => ({
                                  ...current,
                                  [suggestion.name]: {
                                    website: event.target.value,
                                    message: current[suggestion.name]?.message,
                                  },
                                }))
                              }
                            />
                            {can.bill && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="shrink-0"
                                loading={searching}
                                loadingText="Searching"
                                disabled={lookup.isPending}
                                onClick={() => lookup.mutate(suggestion.name)}
                              >
                                Find website
                              </Button>
                            )}
                          </div>
                          {entered?.message && (
                            <p role="status" className="text-xs text-muted-foreground">
                              {entered.message}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <Empty
                  message={
                    suggestions.data?.unavailableReason ||
                    'No new competitor suggestions yet.'
                  }
                />
              )}
            </CardContent>
          </Card>
        </div>
      </details>
    </div>
  );
}
