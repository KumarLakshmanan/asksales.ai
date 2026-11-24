'use client';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import {
  aiVisibilityApi,
  type AiVisibilityAudit,
  type ProviderPromptRun,
} from '@/lib/ai-visibility';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { PromptRunObservation } from './PromptRunObservation';
import { useDetailFocus } from './use-detail-focus';
import { useMeasurement } from './workspace-context';
import { Empty, InlineError, Loading, providerDisplayName, statusBadge } from './workspace-ui';

export function compatibleMeasurements(a?: AiVisibilityAudit | null, b?: AiVisibilityAudit | null) {
  const left = a?.inputSnapshot?.project,
    right = b?.inputSnapshot?.project;
  return Boolean(
    left &&
    right &&
    ['country', 'locale', 'targetGeography', 'configurationRevision'].every(
      (key) => left[key as keyof typeof left] === right[key as keyof typeof right],
    ),
  );
}
function measured(run: ProviderPromptRun) {
  return (
    run.status === 'completed' &&
    ['completed', 'corrected', 'cached'].includes(run.extractionStatus || '')
  );
}
export function GeoView({ projectId }: { projectId: number }) {
  const { auditId } = useMeasurement();
  const [provider, setProvider] = useState('all'),
    [intent, setIntent] = useState('all'),
    [type, setType] = useState('all'),
    [mention, setMention] = useState('all'),
    [citation, setCitation] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number>();
  const [comparisonId, setComparisonId] = useState<number>();
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: ['ai-visibility-prompts', projectId, 'geo', auditId],
    queryFn: () => aiVisibilityApi.prompts(projectId, 'geo', auditId),
  });
  const audits = useQuery({
    queryKey: ['ai-visibility-audits', projectId],
    queryFn: () => aiVisibilityApi.listAudits(projectId),
  });
  const comparison = useQuery({
    queryKey: ['ai-visibility-prompts', projectId, 'geo', comparisonId],
    queryFn: () => aiVisibilityApi.prompts(projectId, 'geo', comparisonId),
    enabled: Boolean(comparisonId),
  });
  const runs = query.data?.runs || [],
    prompts = query.data?.prompts || [];
  const providers = [...new Set(runs.map((run) => run.provider))];
  const expectedRuns = runs.filter((run) => run.status !== 'excluded');
  const attemptedProviders = new Set(expectedRuns.map((run) => run.provider)).size;
  const successful = runs.filter((run) => run.status === 'completed');
  const extracted = runs.filter(measured);
  const compatible = compatibleMeasurements(query.data?.audit, comparison.data?.audit);
  const otherCompletedAudits =
    audits.data?.audits.filter(
      (audit) =>
        audit.id !== query.data?.audit?.id &&
        ['completed', 'completed_with_warnings'].includes(audit.status),
    ) || [];
  const otherCompleted = otherCompletedAudits.length;
  const compatibleAudits = otherCompletedAudits.filter((audit) =>
    compatibleMeasurements(query.data?.audit, audit),
  );
  const filtered = useMemo(
    () =>
      prompts
        .filter(
          (prompt) =>
            (intent === 'all' || prompt.intent === intent) &&
            (type === 'all' || prompt.isGeneric === (type === 'discovery')) &&
            prompt.prompt.toLowerCase().includes(search.toLowerCase()),
        )
        .map((prompt) => ({
          prompt,
          runs: runs.filter(
            (run) =>
              run.promptId === prompt.id &&
              (provider === 'all' || run.provider === provider) &&
              (mention === 'all' ||
                (measured(run) && run.brandMentioned === (mention === 'yes'))) &&
              (citation === 'all' ||
                (run.status === 'completed' &&
                  Boolean(run.citations?.length) === (citation === 'yes'))),
          ),
        }))
        .filter(
          (row) =>
            row.runs.length || (provider === 'all' && mention === 'all' && citation === 'all'),
        ),
    [prompts, runs, provider, intent, type, mention, citation, search],
  );
  const selected = runs.find((run) => run.id === selectedId);
  const resetPage = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(0);
  };
  const detailRef = useDetailFocus(selectedId);
  if (query.isLoading) return <Loading />;
  if (query.isError)
    return (
      <InlineError
        message="GEO observations could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  return (
    <div className="space-y-5">
      {!query.data?.audit?.inputSnapshot?.project?.category && (
        <Callout tone="warning">
          No business category is set, so only branded questions are asked. Add one in Settings to
          compare against the wider market.
        </Callout>
      )}
      <section aria-label="Provider observation health" className="grid gap-3 sm:grid-cols-2">
        {providers.map((name) => {
          const providerRuns = runs.filter((run) => run.provider === name);
          const answers = providerRuns.filter((run) => run.status === 'completed').length;
          const errors = [...new Set(providerRuns.map((run) => run.error).filter(Boolean))];
          return (
            <div key={name} className="border-b pb-3">
              <button
                onClick={() => resetPage(setProvider)(provider === name ? 'all' : name)}
                className="text-left text-sm font-semibold underline-offset-4 hover:underline"
              >
                {providerDisplayName(name)} ·{' '}
                {providerRuns.every((run) => run.status === 'excluded')
                  ? 'not set up for this analysis'
                  : `${answers}/${providerRuns.filter((run) => run.status !== 'excluded').length} answered`}
              </button>
              {!answers && (
                <p className="text-xs text-muted-foreground">
                  Left out of the brand results because it gave no answers.
                </p>
              )}
              {errors.length > 0 && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-amber-700 dark:text-amber-300">
                    {providerRuns.every((run) => run.status === 'excluded')
                      ? `Not asked · ${providerRuns.length} questions`
                      : `Didn’t answer · ${providerRuns.filter((run) => run.status === 'failed').length} failed, ${providerRuns.filter((run) => run.status === 'skipped').length} skipped`}
                  </summary>
                  <p className="mt-2 text-muted-foreground">
                    The AI engine returned errors, so this isn’t a sign of weak visibility. “AI
                    engines asked” in Settings shows whether it is ready for the next analysis.
                  </p>
                  <ul className="mt-2 list-disc pl-5">
                    {errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </section>
      <div className="grid grid-cols-2 gap-4 border-b pb-4 sm:grid-cols-4">
        <div>
          <strong className="font-mono text-2xl">
            {new Set(successful.map((run) => run.provider)).size}/{attemptedProviders}
          </strong>
          <p className="text-xs text-muted-foreground">AI providers answered</p>
        </div>
        <div>
          <strong className="font-mono text-2xl">
            {successful.length}/{expectedRuns.length}
          </strong>
          <p className="text-xs text-muted-foreground">prompts answered</p>
        </div>
        <button className="text-left" onClick={() => resetPage(setMention)('yes')}>
          <strong className="font-mono text-2xl">
            {extracted.filter((run) => run.brandMentioned).length}/{extracted.length}
          </strong>
          <p className="text-xs text-primary">answers mention your brand →</p>
        </button>
        <button className="text-left" onClick={() => resetPage(setCitation)('yes')}>
          <strong className="font-mono text-2xl">
            {successful.reduce((sum, run) => sum + (run.citations?.length || 0), 0)}
          </strong>
          <p className="text-xs text-primary">citation sources →</p>
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Extraction coverage: {extracted.length}/{successful.length} successful answers.{' '}
        {successful.length < expectedRuns.length &&
          'Partial provider coverage: failures are not evidence of poor brand performance.'}{' '}
        API observations do not reproduce consumer application results. Branded questions name the
        brand; discovery questions measure unprompted inclusion.
      </p>
      <div className="flex flex-wrap gap-3">
        <Input
          className="sm:max-w-xs"
          value={search}
          onChange={(event) => resetPage(setSearch)(event.target.value)}
          aria-label="Search GEO prompts"
          placeholder="Search prompts"
        />
        {[
          {
            label: 'Provider',
            value: provider,
            set: setProvider,
            values: providers,
          },
          {
            label: 'Intent',
            value: intent,
            set: setIntent,
            values: [...new Set(prompts.map((prompt) => prompt.intent))],
          },
          {
            label: 'Prompt type',
            value: type,
            set: setType,
            values: ['branded', 'discovery'],
          },
          {
            label: 'Brand mentioned',
            value: mention,
            set: setMention,
            values: ['yes', 'no'],
          },
          {
            label: 'Has citations',
            value: citation,
            set: setCitation,
            values: ['yes', 'no'],
          },
        ].map((filter) => (
          <label key={filter.label} className="text-xs">
            {filter.label}
            <select
              className="ml-2 rounded border bg-background p-2 text-sm"
              value={filter.value}
              onChange={(event) => resetPage(filter.set)(event.target.value)}
            >
              <option value="all">All</option>
              {filter.values.map((value) => (
                <option key={value} value={value}>
                  {filter.label === 'Provider'
                    ? providerDisplayName(value)
                    : value[0].toUpperCase() + value.slice(1).replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <details className="border-b pb-3">
        <summary className="cursor-pointer text-sm">Compare compatible measurements</summary>
        {audits.isError ? (
          <InlineError
            message="Comparison history is unavailable."
            onRetry={() => audits.refetch()}
          />
        ) : audits.isSuccess && !compatibleAudits.length ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {otherCompleted
              ? `None of the ${otherCompleted} other completed ${otherCompleted === 1 ? 'analysis' : 'analyses'} can be compared with this one. They used a different country, language, region or settings, or were run before settings were recorded.`
              : 'There is no other completed analysis yet.'}{' '}
            Run another analysis with the same settings to compare.
          </p>
        ) : (
          <>
            <label className="mt-3 block text-sm">
              Compare with
              <select
                className="ml-2 rounded border bg-background p-2"
                value={comparisonId || ''}
                onChange={(event) => setComparisonId(Number(event.target.value) || undefined)}
              >
                <option value="">Choose a completed measurement</option>
                {compatibleAudits.map((audit) => (
                  <option key={audit.id} value={audit.id}>
                    #{audit.id} · {new Date(audit.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Only measurements with the same geography, locale and configuration revision can be
              compared. Rows match exact prompt text and provider. Coverage changes remain visible.
            </p>
          </>
        )}
        {comparisonId &&
          (comparison.isLoading ? (
            <p role="status">Loading comparison…</p>
          ) : comparison.isError ? (
            <InlineError
              message="Comparison could not be loaded."
              onRetry={() => comparison.refetch()}
            />
          ) : !compatible ? (
            <p>These measurements are not compatible.</p>
          ) : (
            <p className="mt-2 text-sm">
              Previous: {comparison.data?.runs.filter((run) => run.status === 'completed').length}/
              {comparison.data?.runs.filter((run) => run.status !== 'excluded').length} successful
              observations. Current: {successful.length}/{expectedRuns.length}. Historical scores
              predate any labeled corrections.
            </p>
          ))}
      </details>
      <div className={`grid gap-5 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_420px]' : ''}`}>
        <div className="min-w-0 overflow-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Prompt by provider observations</caption>
            <thead className="border-b">
              <tr>
                <th className="p-3">Prompt</th>
                {providers
                  .filter((name) => provider === 'all' || name === provider)
                  .map((name) => (
                    <th key={name} className="p-3">
                      {providerDisplayName(name)}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.slice(page * 20, (page + 1) * 20).map(({ prompt, runs: promptRuns }) => (
                <tr key={prompt.id}>
                  <th className="max-w-md p-3 text-left font-normal">
                    <div>{prompt.prompt}</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {prompt.isGeneric ? 'Discovery' : 'Branded'} · {prompt.intent.replace(/_/g, ' ')} ·{' '}
                      {prompt.locale}
                    </p>
                  </th>
                  {providers
                    .filter((name) => provider === 'all' || name === provider)
                    .map((name) => {
                      const run = promptRuns.find((item) => item.provider === name);
                      const previousPrompt = comparison.data?.prompts.find(
                        (item) => item.prompt === prompt.prompt,
                      );
                      const previous =
                        compatible &&
                        comparison.data?.runs.find(
                          (item) => item.provider === name && item.promptId === previousPrompt?.id,
                        );
                      return (
                        <td key={name} className="min-w-36 p-3">
                          {run ? (
                            <button
                              aria-label={`View ${providerDisplayName(name)} evidence for ${prompt.prompt}`}
                              onClick={() => setSelectedId(run.id)}
                              className="space-y-1 rounded text-left focus-visible:ring-2"
                            >
                              {statusBadge(run.status)}
                              <span className="block text-xs text-primary">
                                {measured(run)
                                  ? run.brandMentioned
                                    ? `Mentioned${run.brandRank ? ` #${run.brandRank}` : ''}`
                                    : 'Brand not found'
                                  : 'Metrics unavailable'}{' '}
                                · evidence →
                              </span>
                              {previous && (
                                <span className="block text-xs text-muted-foreground">
                                  Previous:{' '}
                                  {measured(previous)
                                    ? previous.brandMentioned
                                      ? 'mentioned'
                                      : 'not found'
                                    : previous.status}
                                </span>
                              )}
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              No matching observation
                            </span>
                          )}
                        </td>
                      );
                    })}
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <Empty
              message={
                prompts.length
                  ? 'No observations match these filters.'
                  : 'Complete an analysis to collect GEO observations.'
              }
            />
          )}
          <div className="mt-4 flex items-center justify-between gap-2 text-xs">
            <span>{filtered.length} matching prompts</span>
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
                disabled={(page + 1) * 20 >= filtered.length}
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
            className="min-w-0 lg:sticky lg:top-4 lg:max-h-[80vh] lg:self-start lg:overflow-auto"
            aria-label="Provider answer detail"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Answer & citations</h2>
              <Button variant="ghost" size="sm" onClick={() => setSelectedId(undefined)}>
                Close
              </Button>
            </div>
            <PromptRunObservation key={selected.id} projectId={projectId} run={selected} />
          </aside>
        )}
      </div>
    </div>
  );
}
