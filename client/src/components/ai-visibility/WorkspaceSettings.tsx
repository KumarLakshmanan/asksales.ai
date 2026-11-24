'use client';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import {
  aiVisibilityApi,
  type AiVisibilityAudit,
  type AiVisibilityAuditEstimate,
  type AiVisibilityProject,
  type VisibilityOverview,
} from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { refreshVisibility, useMeasurement } from './workspace-context';
import {
  BUSINESS_TYPES,
  InlineError,
  providerDisplayName,
  websiteWorkspacePath,
  type AiVisibilityView,
} from './workspace-ui';

type Coverage = NonNullable<VisibilityOverview['coverage']>;

/** Names only the parts of the measurement that fell short, in plain words. */
export function partialCoverageDetail(coverage: Coverage) {
  const gaps: string[] = [];
  if (coverage.successfulProviders < coverage.attemptedProviders)
    gaps.push(`${coverage.successfulProviders} of ${coverage.attemptedProviders} AI providers answered`);
  if (coverage.completedPages < coverage.checkedPages)
    gaps.push(`${coverage.completedPages} of ${coverage.checkedPages} pages crawled`);
  return gaps.length ? gaps.join(' · ') : 'some AI answers could not be read';
}

export function MeasurementBar({
  project,
  data,
  audits,
  view,
  loading,
  error,
  onRetry,
}: {
  project: AiVisibilityProject;
  data?: VisibilityOverview;
  audits: AiVisibilityAudit[];
  view: AiVisibilityView;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const router = useRouter();
  const websites = useQuery({
    queryKey: ['ai-visibility-projects'],
    queryFn: aiVisibilityApi.listProjects,
  });
  if (error) return <InlineError message="Measurement context is unavailable." onRetry={onRetry} />;
  if (loading) return <p role="status">Loading measurement context…</p>;
  const audit = data?.measurementAudit;
  const measuredProject = audit?.inputSnapshot?.project || project;
  const coverage = data?.coverage;
  return (
    <section aria-label="Measurement context" className="border-y py-2 text-sm">
      <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">
          Website
          <select
            aria-label="Select website"
            className="mt-1 block w-full rounded-md border bg-background p-2 text-sm text-foreground"
            value={project.id}
            onChange={(event) =>
              router.push(websiteWorkspacePath(Number(event.target.value), view))
            }
          >
            {(websites.data?.projects || [project]).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.domain}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">
          Completed measurement
          <select
            aria-label="Select measurement"
            className="mt-1 block w-full rounded-md border bg-background p-2 text-sm text-foreground"
            value={audit?.id || ''}
            onChange={(event) =>
              router.push(websiteWorkspacePath(project.id, view) + `?audit=${event.target.value}`)
            }
          >
            {!audit && <option value="">Not analyzed</option>}
            {audits
              .filter((item) => ['completed', 'completed_with_warnings'].includes(item.status))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  #{item.id} · {new Date(item.createdAt).toLocaleString()}
                </option>
              ))}
          </select>
        </label>
        <p className="col-span-2 pb-2 text-xs text-muted-foreground">
          {measuredProject.targetGeography || measuredProject.country} · {measuredProject.locale}
        </p>
      </div>
      {audit && coverage?.partial && (
        <p className="mt-2 text-xs">
          <strong className="font-medium text-amber-700 dark:text-amber-300">Partial coverage</strong>
          <span className="text-muted-foreground"> · {partialCoverageDetail(coverage)}</span>
        </p>
      )}
      {data?.latestAudit && ['running', 'queued'].includes(data.latestAudit.status) && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          New analysis #{data.latestAudit.id} is {data.latestAudit.status}. Showing the last completed
          one until it finishes.
        </p>
      )}
      {data?.configurationChanged && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          Settings changed since this measurement. Analyze again to apply them.
        </p>
      )}
      {Boolean(audit?.correctionRevision) && (
        <Callout tone="warning" announce className="mt-2">
          Evidence correction revision {audit?.correctionRevision}, saved{' '}
          {audit?.correctedAt && new Date(audit.correctedAt).toLocaleString()}. Scores and generated
          PDFs are historical snapshots from before these corrections. Corrected observations are
          labeled in GEO.
        </Callout>
      )}
    </section>
  );
}

export function WorkspaceSettings({
  project,
  estimate,
}: {
  project: AiVisibilityProject;
  estimate?: AiVisibilityAuditEstimate;
}) {
  const { can } = useMeasurement();
  const client = useQueryClient();
  const [country, setCountry] = useState(project.country);
  const [locale, setLocale] = useState(project.locale);
  const [geography, setGeography] = useState(project.targetGeography || '');
  const [category, setCategory] = useState(project.category || '');
  const [businessType, setBusinessType] = useState(project.scoringProfile);
  const [prompts, setPrompts] = useState(project.geoPrompts || []);
  const providers = useQuery({
    queryKey: ['ai-visibility-providers', project.id],
    queryFn: () => aiVisibilityApi.providers(project.id),
  });
  const save = useMutation({
    mutationFn: () =>
      aiVisibilityApi.updateProject(project.id, {
        country,
        locale,
        targetGeography: geography,
        category,
        scoringProfile: businessType,
        geoPrompts: prompts,
      }),
    onSuccess: () => refreshVisibility(client, project.id),
  });
  const monitor = useMutation({
    mutationFn: () => aiVisibilityApi.updateMonitoring(project.id, !project.monitoringEnabled),
    onSuccess: () => refreshVisibility(client, project.id),
  });
  return (
    <details className="border-b pb-2">
      <summary className="cursor-pointer text-sm font-medium">
        Settings and monitoring
      </summary>
      <div className="grid gap-6 py-4 lg:grid-cols-2">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <h2 className="font-semibold">Analysis settings</h2>
          <fieldset disabled={!can.edit || save.isPending} className="space-y-3">
            <label className="block text-sm">
              What this website is
              <select
                className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
                value={businessType}
                onChange={(event) =>
                  setBusinessType(event.target.value as typeof project.scoringProfile)
                }
              >
                {BUSINESS_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Sets how SEO, AEO and GEO are weighted in the score. Only an online store gets the
              Commerce check of its product catalog.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                Country (2-letter code)
                <Input
                  value={country}
                  maxLength={2}
                  onChange={(event) => setCountry(event.target.value.toUpperCase())}
                  required
                />
              </label>
              <label className="text-sm">
                Language (for example en-US)
                <Input
                  value={locale}
                  onChange={(event) => setLocale(event.target.value)}
                  required
                />
              </label>
            </div>
            <label className="block text-sm">
              Region you serve (optional)
              <Input
                placeholder="For example: Chennai or the United Kingdom"
                value={geography}
                onChange={(event) => setGeography(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Business category
              <Input
                placeholder="For example: resort stays or mobile app development"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Used to ask AI engines questions that don’t name your brand, such as “best{' '}
              {category.trim() || 'your category'} companies”, to see whether they recommend you.
              Leave it empty to ask only questions that name your brand.
            </p>
            <details>
              <summary className="cursor-pointer text-sm">
                Your own questions for AI engines ({prompts.length})
              </summary>
              <div className="space-y-3 pt-3">
                {prompts.map((prompt, index) => (
                  <div key={prompt.id} className="space-y-2 border-b pb-3">
                    <label className="block text-sm">
                      Question {index + 1}
                      <Input
                        minLength={10}
                        maxLength={1000}
                        value={prompt.prompt}
                        onChange={(event) =>
                          setPrompts((items) =>
                            items.map((item, i) =>
                              i === index ? { ...item, prompt: event.target.value } : item,
                            ),
                          )
                        }
                        required
                      />
                    </label>
                    <label className="block text-sm">
                      Purpose (for example discovery or comparison)
                      <Input
                        maxLength={48}
                        value={prompt.intent}
                        onChange={(event) =>
                          setPrompts((items) =>
                            items.map((item, i) =>
                              i === index ? { ...item, intent: event.target.value } : item,
                            ),
                          )
                        }
                        required
                      />
                    </label>
                    <label className="mr-3 text-sm">
                      <input
                        type="checkbox"
                        checked={prompt.isGeneric}
                        onChange={(event) =>
                          setPrompts((items) =>
                            items.map((item, i) =>
                              i === index ? { ...item, isGeneric: event.target.checked } : item,
                            ),
                          )
                        }
                      />{' '}
                      Doesn’t name the brand
                    </label>
                    <label className="text-sm">
                      <input
                        type="checkbox"
                        checked={prompt.active}
                        onChange={(event) =>
                          setPrompts((items) =>
                            items.map((item, i) =>
                              i === index ? { ...item, active: event.target.checked } : item,
                            ),
                          )
                        }
                      />{' '}
                      Ask in analyses
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPrompts((items) => items.filter((_, i) => i !== index))}
                    >
                      Remove question {index + 1}
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={prompts.length >= 30}
                  onClick={() =>
                    setPrompts((items) => [
                      ...items,
                      {
                        id: crypto.randomUUID(),
                        prompt: '',
                        intent: 'discovery',
                        isGeneric: true,
                        active: true,
                      },
                    ])
                  }
                >
                  Add a question
                </Button>
              </div>
            </details>
            <Button type="submit" size="sm">
              {save.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </fieldset>
          {!can.edit && (
            <p className="text-xs text-muted-foreground">An editor can change analysis settings.</p>
          )}
          {save.isError && (
            <InlineError message={save.error.message} onRetry={() => save.mutate()} />
          )}
          {save.isSuccess && (
            <p role="status" className="text-sm">
              Saved. A new analysis will use these settings.
            </p>
          )}
        </form>
        <div className="space-y-5">
          <section>
            <h2 className="font-semibold">AI engines asked</h2>
            {providers.isLoading ? (
              <p role="status">Checking which AI engines are set up…</p>
            ) : providers.isError ? (
              <InlineError
                message="The AI engine list could not be loaded."
                onRetry={() => providers.refetch()}
              />
            ) : (
              providers.data?.providers.map((provider) => (
                <details key={provider.provider} className="border-b py-2 text-sm">
                  <summary className="cursor-pointer">
                    {providerDisplayName(provider.provider)} ·{' '}
                    {provider.status === 'last_run_unavailable'
                      ? 'Didn’t answer last time; will be tried again'
                      : provider.configured
                        ? 'Ready; asked in the next analysis'
                        : 'Not set up; won’t be asked'}
                  </summary>
                  <p className="mt-2 text-muted-foreground">
                    {provider.reason}{' '}
                    {provider.lastError && `Error: ${provider.lastError}`}{' '}
                    {provider.lastObservedAt &&
                      `Last analysis: ${new Date(provider.lastObservedAt).toLocaleString()}`}
                  </p>
                </details>
              ))
            )}
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Scheduled monitoring</h2>
            <p className="text-sm">
              {project.monitoringEnabled
                ? `On: the website is analysed again ${project.monitoringCadence}. Next run: ${
                    project.nextMonitoringAt
                      ? new Date(project.nextMonitoringAt).toLocaleString()
                      : 'not scheduled yet'
                  }.`
                : `Off. When on, the website is analysed again ${project.monitoringCadence} without you starting it.`}
            </p>
            <p className="text-sm text-muted-foreground">
              {estimate
                ? `Each analysis costs up to ${estimate.estimatedMaximum.toLocaleString()} credits. Your balance: ${estimate.walletBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits.`
                : 'Cost estimate unavailable; refresh to load it.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!can.bill || !estimate || monitor.isPending}
              onClick={() => monitor.mutate()}
            >
              {project.monitoringEnabled ? 'Disable monitoring' : 'Enable monitoring'}
            </Button>
            {!can.bill && (
              <p className="text-xs text-muted-foreground">
                The business owner or a billing admin manages scheduled monitoring.
              </p>
            )}
            {monitor.isError && (
              <InlineError message={monitor.error.message} onRetry={() => monitor.mutate()} />
            )}
          </section>
        </div>
      </div>
    </details>
  );
}
