'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { aiVisibilityApi, type Recommendation } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { OlderSeoChecksNotice } from './OlderSeoChecksNotice';
import { Evidence } from './SeoView';
import { useDetailFocus } from './use-detail-focus';
import { refreshVisibility, useMeasurement } from './workspace-context';
import {
  Empty,
  InlineError,
  Loading,
  recommendationTitle,
  statusBadge,
  websiteWorkspacePath,
} from './workspace-ui';
const fixTitle = (item: Recommendation) => recommendationTitle(item);
const priority: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
const verification = {
  unverified: 'Not verified by re-analysis',
  verified: 'Verified resolved on re-analysis',
  still_present: 'Still present on re-analysis',
  not_rechecked: 'Not rechecked in this crawl',
};
export function FixesView({ projectId }: { projectId: number }) {
  const { auditId, can, historical, overview } = useMeasurement();
  const client = useQueryClient(),
    router = useRouter(),
    params = useSearchParams();
  const [filters, setFilters] = useState({
    status: 'open',
    severity: 'all',
    module: 'all',
    search: '',
  });
  const [loadedFilters, setLoadedFilters] = useState(false);
  const [selectedId, setSelectedId] = useState(Number(params.get('fix')) || undefined);
  const [page, setPage] = useState(0);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`ai-visibility-fix-filters:${projectId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Object.values(parsed).every((value) => typeof value === 'string'))
          setFilters({
            status: 'open',
            severity: 'all',
            module: 'all',
            search: '',
            ...parsed,
          });
      }
    } catch {}
    setLoadedFilters(true);
  }, [projectId]);
  useEffect(() => {
    if (loadedFilters) {
      try {
        localStorage.setItem(`ai-visibility-fix-filters:${projectId}`, JSON.stringify(filters));
      } catch {}
    }
  }, [filters, loadedFilters, projectId]);
  const query = useQuery({
    queryKey: ['ai-visibility-recommendations', projectId, auditId],
    queryFn: () => aiVisibilityApi.recommendations(projectId, auditId),
  });
  const assets = useQuery({
    queryKey: ['ai-visibility-assets', projectId],
    queryFn: () => aiVisibilityApi.assets(projectId),
  });
  const members = useQuery({
    queryKey: ['ai-visibility-assignees', projectId],
    queryFn: () => aiVisibilityApi.assignees(projectId),
  });
  const create = useMutation({
    mutationFn: (id: number) => aiVisibilityApi.generateAsset(projectId, id),
    onSuccess: (result) => {
      refreshVisibility(client, projectId);
      router.push(websiteWorkspacePath(projectId, 'assets') + `?contentAsset=${result.asset.id}`);
    },
  });
  const all = query.data?.recommendations || [];
  const filtered = all
    .filter(
      (item) =>
        (filters.status === 'all' || item.status === filters.status) &&
        (filters.severity === 'all' || item.severity === filters.severity) &&
        (filters.module === 'all' || item.module === filters.module) &&
        [fixTitle(item), item.title, item.description, item.module, item.affectedUrl]
          .join(' ')
          .toLowerCase()
          .includes(filters.search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (priority[a.severity] ?? 9) - (priority[b.severity] ?? 9) ||
        (a.dueDate || '9999').localeCompare(b.dueDate || '9999'),
    );
  const selected = all.find((item) => item.id === selectedId);
  const updateFilter = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  };
  const detailRef = useDetailFocus(selectedId);
  if (query.isLoading) return <Loading />;
  if (query.isError)
    return <InlineError message="Fixes could not be loaded." onRetry={() => query.refetch()} />;
  const hasSeoFixes = (query.data?.recommendations || []).some((item) => item.module === 'seo');
  return (
    <div className="space-y-4">
      {hasSeoFixes && (
        <OlderSeoChecksNotice
          projectId={projectId}
          version={overview?.measurementSeoRuleVersion}
          current={overview?.currentSeoRuleVersion}
          subject="SEO fixes"
        />
      )}
      {historical && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Historical queue. Select the latest measurement to update work.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Input
          className="sm:max-w-sm"
          aria-label="Search fixes"
          placeholder="Search fixes or URLs"
          value={filters.search}
          onChange={(event) => updateFilter('search', event.target.value)}
        />
        {[
          {
            key: 'status' as const,
            label: 'Status',
            values: ['open', 'in_progress', 'resolved', 'rejected'],
          },
          {
            key: 'severity' as const,
            label: 'Severity',
            values: Object.keys(priority),
          },
          {
            key: 'module' as const,
            label: 'Module',
            values: [...new Set(all.map((item) => item.module))],
          },
        ].map((filter) => (
          <label key={filter.key} className="text-xs">
            {filter.label}
            <select
              className="ml-2 rounded border bg-background p-2 text-sm"
              value={filters[filter.key]}
              onChange={(event) => updateFilter(filter.key, event.target.value)}
            >
              <option value="all">All</option>
              {filter.values.map((value) => (
                <option key={value} value={value}>
                  {filter.key === 'module'
                    ? value.toUpperCase()
                    : value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className={`grid gap-5 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : ''}`}>
        <div className="min-w-0">
          <div className="divide-y border-y">
            {filtered.slice(page * 25, (page + 1) * 25).map((item) => (
              <button
                key={item.id}
                className={`flex w-full items-start gap-3 px-2 py-3 text-left hover:bg-muted focus-visible:ring-2 ${selectedId === item.id ? 'bg-muted' : ''}`}
                onClick={() => setSelectedId(item.id)}
              >
                {statusBadge(item.severity)}
                <span className="min-w-0 flex-1">
                  <strong className="text-sm font-medium">{fixTitle(item)}</strong>
                  <span className="mt-1 block break-all text-xs text-muted-foreground">
                    {item.module.toUpperCase()} · {item.affectedUrl || 'Site-wide'}
                  </span>
                  {/* Only what someone set or a recheck found; "unassigned, not verified" is the default for every row. */}
                  {(() => {
                    const meta = [
                      item.assigneeUserId &&
                        (members.data?.members.find((member) => member.id === item.assigneeUserId)
                          ?.name || 'Assigned member'),
                      item.dueDate && `Due ${item.dueDate.slice(0, 10)}`,
                      item.verificationStatus &&
                        item.verificationStatus !== 'unverified' &&
                        verification[item.verificationStatus],
                    ].filter(Boolean);
                    return meta.length ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {meta.join(' · ')}
                      </span>
                    ) : null;
                  })()}
                </span>
                {/* With a status filter on, every row has that status; show it only for "All". */}
                {filters.status === 'all' && (
                  <span className="text-xs text-muted-foreground">
                    {item.status.replaceAll('_', ' ')}
                  </span>
                )}
              </button>
            ))}
          </div>
          {!filtered.length && (
            <Empty
              message={
                all.length
                  ? 'No fixes match these filters.'
                  : 'No recommendations are available for this measurement.'
              }
            />
          )}
          <div className="mt-4 flex items-center justify-between gap-2 text-xs">
            <span>
              {filtered.length} of {all.length} fixes
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={(page + 1) * 25 >= filtered.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
        {selected && (
          <aside
            ref={detailRef}
            tabIndex={-1}
            aria-label="Fix detail"
            className="min-w-0 rounded-lg border bg-muted/20 p-4 lg:sticky lg:top-4 lg:max-h-[80vh] lg:self-start lg:overflow-auto"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold">{fixTitle(selected)}</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedId(undefined)}
                aria-label="Close fix detail"
              >
                ×
              </Button>
            </div>
            <p className="my-3 text-sm">{selected.description}</p>
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {statusBadge(selected.severity)}
              <span>
                {selected.impact} impact · {selected.effort} effort
              </span>
            </div>
            <Evidence value={{ sourcePage: selected.affectedUrl, ...selected.evidence }} />
            <FixEditor
              key={`${selected.id}:${selected.status}:${selected.assigneeUserId}:${selected.dueDate}:${selected.resolutionEvidence}`}
              item={selected}
              projectId={projectId}
              members={members.data?.members || []}
              disabled={!can.edit || historical}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {verification[selected.verificationStatus || 'unverified']}
              {selected.verifiedAt && ` · ${new Date(selected.verifiedAt).toLocaleString()}`}
            </p>
            {members.isError && (
              <InlineError
                message="Assignee list is unavailable."
                onRetry={() => members.refetch()}
              />
            )}
            {assets.isError ? (
              <InlineError
                message="Linked assets could not be loaded."
                onRetry={() => assets.refetch()}
              />
            ) : (
              <div className="mt-4 space-y-2">
                {assets.data?.assets
                  .filter((item) => item.recommendationId === selected.id)
                  .map((asset) => (
                    <Link
                      key={asset.id}
                      href={websiteWorkspacePath(projectId, 'assets') + `?asset=${asset.id}`}
                      className="block text-sm text-primary underline"
                    >
                      {asset.title} · v{asset.version}
                    </Link>
                  ))}
              </div>
            )}
            {selected.assetType && can.edit && !historical && (
              <Button
                size="sm"
                className="mt-3"
                disabled={create.isPending}
                onClick={() => create.mutate(selected.id)}
              >
                {create.isPending ? 'Creating…' : 'Create / open draft'}
              </Button>
            )}
            {create.isError && <InlineError message={create.error.message} />}
          </aside>
        )}
      </div>
    </div>
  );
}
function FixEditor({
  item,
  projectId,
  members,
  disabled,
}: {
  item: Recommendation;
  projectId: number;
  members: Array<{ id: number; name: string; email: string }>;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const [status, setStatus] = useState(item.status),
    [assignee, setAssignee] = useState(item.assigneeUserId?.toString() || '');
  const [dueDate, setDueDate] = useState(item.dueDate?.slice(0, 10) || ''),
    [evidence, setEvidence] = useState(item.resolutionEvidence || '');
  const save = useMutation({
    mutationFn: () =>
      aiVisibilityApi.updateRecommendation(projectId, item.id, {
        status,
        assigneeUserId: assignee ? Number(assignee) : null,
        dueDate: dueDate || null,
        resolutionEvidence: evidence || null,
      }),
    onSuccess: () => refreshVisibility(client, projectId),
  });
  return (
    <form
      className="mt-4 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <fieldset disabled={disabled || save.isPending} className="space-y-3">
        <label className="block text-sm">
          Workflow status
          <select
            className="mt-1 block w-full rounded border bg-background p-2"
            value={status}
            onChange={(event) => setStatus(event.target.value as Recommendation['status'])}
          >
            {['open', 'in_progress', 'resolved', 'rejected'].map((value) => (
              <option key={value} value={value}>
                {value.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Assigned to
          <select
            className="mt-1 block w-full rounded border bg-background p-2"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
          >
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name || member.email}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Due date
          <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
        <label className="block text-sm">
          Resolution evidence
          <textarea
            className="mt-1 block min-h-24 w-full rounded border bg-background p-2"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="Implementation URL, change reference and what changed"
          />
        </label>
        <Button size="sm" type="submit">
          {save.isPending ? 'Saving…' : 'Save work'}
        </Button>
      </fieldset>
      {save.isError && <InlineError message={save.error.message} onRetry={() => save.mutate()} />}
    </form>
  );
}
