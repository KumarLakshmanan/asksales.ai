'use client';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { readLibraryDraft } from '@/lib/libraryDraft';
import {
  aiVisibilityApi,
  type AiVisibilityCmsPlatform,
  type AiVisibilityGeneratedAsset,
  type AiVisibilityProject,
} from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { CmsConnections } from './CmsConnections';
import { SafeMarkdown } from './SafeMarkdown';
import { Evidence } from './SeoView';
import { refreshVisibility, useMeasurement } from './workspace-context';
import {
  Empty,
  InlineError,
  Loading,
  safeCitationUrl,
  statusBadge,
  websiteWorkspacePath,
} from './workspace-ui';

export function AssetsView({
  projectId,
}: {
  projectId: number;
  role: NonNullable<AiVisibilityProject['workspace']>['role'];
}) {
  const params = useSearchParams();
  const [selectedId, setSelectedId] = useState(Number(params.get('asset')) || undefined);
  const [search, setSearch] = useState(''),
    [kind, setKind] = useState('all'),
    [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: ['ai-visibility-assets', projectId],
    queryFn: () => aiVisibilityApi.assets(projectId),
  });
  const all = query.data?.assets || [];
  const contentAssetId = Number(params.get('contentAsset')) || undefined;
  const selected =
    all.find((item) => item.id === selectedId) ||
    (contentAssetId ? all.find((item) => item.contentAssetId === contentAssetId) : undefined) ||
    all[0];
  const filtered = all.filter(
    (item) =>
      (kind === 'all' || item.type === kind) &&
      [item.title, item.contentAssetId, item.approvalStatus]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  if (query.isLoading) return <Loading />;
  if (query.isError)
    return (
      <InlineError
        message="Generated assets could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Select an exact asset, review its source evidence, edit the draft and approve its current
        version before creating a CMS draft.
      </p>
      <div className="flex flex-wrap gap-3">
        <Input
          className="sm:max-w-sm"
          aria-label="Search assets"
          placeholder="Search title or review status"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
        <label className="text-sm">
          Asset type
          <select
            className="ml-2 rounded border bg-background p-2"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All types</option>
            {[...new Set(all.map((item) => item.type))].map((type) => (
              <option key={type} value={type}>
                {type.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div>
          <div className="divide-y border-y">
            {filtered.slice(page * 20, (page + 1) * 20).map((item) => (
              <button
                key={item.id}
                className={`w-full px-2 py-3 text-left hover:bg-muted focus-visible:ring-2 ${selected?.id === item.id ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="block text-sm font-medium">{item.title}</span>
                <span className="my-1 block text-xs text-muted-foreground">
                  {item.type.replaceAll('_', ' ')} · v{item.version} ·{' '}
                  {new Date(item.createdAt).toLocaleDateString()}
                </span>
                {statusBadge(item.approvalStatus)}
              </button>
            ))}
          </div>
          {!filtered.length && (
            <Empty
              message={
                all.length
                  ? 'No assets match these filters.'
                  : 'Create a draft from Fixes or an AEO question to start reviewing.'
              }
            />
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </Button>
            <span className="text-xs">{filtered.length} assets</span>
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
        {selected && (
          <AssetReview
            key={`${selected.id}:${selected.version}`}
            projectId={projectId}
            asset={selected}
          />
        )}
      </div>
      <details className="border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">CMS destinations</summary>
        <CmsConnections projectId={projectId} />
      </details>
    </div>
  );
}
function AssetReview({
  projectId,
  asset,
}: {
  projectId: number;
  asset: AiVisibilityGeneratedAsset;
}) {
  const { can } = useMeasurement();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(asset.title),
    [content, setContent] = useState(asset.content),
    [comment, setComment] = useState('');
  const [compareVersion, setCompareVersion] = useState<number>();
  const intentKeys = useRef<Record<string, string>>({});
  const versions = useQuery({
    queryKey: ['ai-visibility-asset-versions', projectId, asset.id],
    queryFn: () => aiVisibilityApi.assetVersions(projectId, asset.id),
  });
  const approvals = useQuery({
    queryKey: ['ai-visibility-asset-approvals', projectId],
    queryFn: () => aiVisibilityApi.assetApprovals(projectId),
  });
  const connections = useQuery({
    queryKey: ['ai-visibility-cms-connections', projectId],
    queryFn: () => aiVisibilityApi.cmsConnections(projectId),
  });
  const attempts = useQuery({
    queryKey: ['ai-visibility-cms-attempts', projectId],
    queryFn: () => aiVisibilityApi.cmsPublishAttempts(projectId),
    enabled: can.connections,
    refetchInterval: (query) =>
      query.state.data?.attempts.some((item) => ['pending', 'sending'].includes(item.status))
        ? 3000
        : false,
  });
  const refresh = () => refreshVisibility(client, projectId);
  const save = useMutation({
    mutationFn: () =>
      aiVisibilityApi.editAsset(projectId, asset.id, {
        version: asset.version,
        title,
        content,
      }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') =>
      aiVisibilityApi.decideAsset(
        projectId,
        asset.id,
        asset.version,
        decision,
        comment || undefined,
      ),
    onSuccess: () => {
      setComment('');
      refresh();
    },
  });
  const publish = useMutation({
    mutationFn: (platform: AiVisibilityCmsPlatform) => {
      const key = `${asset.id}:${asset.version}:${platform}`;
      const unresolved = attempts.data?.attempts.find(
        (item) => item.generatedAssetLinkId === asset.id && item.assetVersion === asset.version && item.platform === platform && ['ambiguous', 'sending'].includes(item.status),
      );
      intentKeys.current[key] = unresolved?.idempotencyKey || intentKeys.current[key] || crypto.randomUUID();
      if (unresolved?.status === 'sending')
        return aiVisibilityApi.createCmsDraft(projectId, asset.id, platform, intentKeys.current[key], asset.version, true);
      return aiVisibilityApi.createCmsDraft(projectId, asset.id, platform, intentKeys.current[key], asset.version);
    },
    onSuccess: refresh,
    onError: refresh,
  });
  const previous = versions.data?.versions.find((item) => item.version === compareVersion);
  const decisions =
    approvals.data?.decisions.filter((item) => item.decision.generatedAssetLinkId === asset.id) ||
    [];
  const history =
    attempts.data?.attempts.filter((item) => item.generatedAssetLinkId === asset.id) || [];
  const json = ['json_ld', 'faq_page', 'metadata'].includes(asset.type);
  const brief = asset.type.includes('brief');
  const blog = ['blog', 'blog_post'].includes(asset.type);
  const previewContent = blog ? readLibraryDraft(asset.content).body : asset.content;
  // Markdown intentionally skips HTML. Preserve HTML draft bytes as escaped
  // source for review rather than rendering untrusted markup or hiding it.
  const htmlSource = blog && /<\/?[a-z][^>]*>/i.test(previewContent);
  return (
    <section aria-label="Exact asset review" className="min-w-0 space-y-4">
      <header className="border-b pb-3">
        <h2 className="text-xl font-semibold">{asset.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Asset #{asset.contentAssetId} · version {asset.version} · Analysis #{asset.auditId} ·{' '}
          {new Date(asset.createdAt).toLocaleString()}
        </p>
        <div className="mt-2">{statusBadge(asset.approvalStatus)}</div>
      </header>
      {brief && (
        <Callout tone="warning">
          Content / research brief: this is an authoring plan. It is not finished website copy or
          verified schema.
        </Callout>
      )}
      {asset.type === 'metadata' && (
        <p className="text-sm text-muted-foreground">
          Metadata draft: verify title and description against the target page before
          implementation.
        </p>
      )}
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label className="block text-sm">
            Asset title
            <Input value={title} required onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="block text-sm">
            Draft content
            <textarea
              className={`mt-1 min-h-80 w-full rounded border bg-background p-3 text-sm ${json ? 'font-mono' : ''}`}
              value={content}
              required
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Saving creates version {asset.version + 1} and clears approval. A concurrent edit
            returns a conflict so this draft cannot overwrite newer work.
          </p>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save new version'}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {save.isError && <InlineError message={save.error.message} onRetry={() => refresh()} />}
        </form>
      ) : (
        <>
          <div className="max-h-[65vh] overflow-auto rounded-lg border bg-background p-5">
            {htmlSource && (
              <p className="mb-3 text-xs text-muted-foreground">
                HTML draft source. Markup is shown as text for review.
              </p>
            )}
            {json || htmlSource ? (
              <pre aria-label={htmlSource ? 'HTML draft source' : undefined} className="whitespace-pre-wrap break-words font-mono text-xs">
                {json ? asset.content : previewContent}
              </pre>
            ) : (
              <SafeMarkdown>{previewContent}</SafeMarkdown>
            )}
          </div>
          {can.edit && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit this asset
            </Button>
          )}
        </>
      )}
      <details className="border-y py-3">
        <summary className="cursor-pointer text-sm font-medium">Sources & validation</summary>
        <div className="mt-3">
          <Evidence
            value={
              asset.metadata || {
                source: 'No linked evidence metadata was captured',
              }
            }
          />
          {asset.validationSnapshot && <Evidence value={asset.validationSnapshot} />}
          {asset.recommendationId && (
            <Link
              href={websiteWorkspacePath(projectId, 'fixes') + `?fix=${asset.recommendationId}`}
              className="mt-3 block text-sm text-primary underline"
            >
              Open originating fix
            </Link>
          )}
        </div>
      </details>
      <details className="border-b pb-3">
        <summary className="cursor-pointer text-sm font-medium">Version comparison</summary>
        {versions.isLoading ? (
          <p role="status">Loading versions…</p>
        ) : versions.isError ? (
          <InlineError
            message="Version history could not be loaded."
            onRetry={() => versions.refetch()}
          />
        ) : (
          <>
            <label className="mt-3 block text-sm">
              Compare current v{asset.version} with
              <select
                className="ml-2 rounded border bg-background p-2"
                value={compareVersion || ''}
                onChange={(event) => setCompareVersion(Number(event.target.value) || undefined)}
              >
                <option value="">Choose version</option>
                {versions.data?.versions
                  .filter((item) => item.version !== asset.version)
                  .map((item) => (
                    <option key={item.version} value={item.version}>
                      v{item.version} · {new Date(item.createdAt).toLocaleString()}
                    </option>
                  ))}
              </select>
            </label>
            {previous && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-medium">
                    Previous v{previous.version}: {previous.title}
                  </h3>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
                    {previous.content}
                  </pre>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium">
                    Current v{asset.version}: {asset.title}
                  </h3>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
                    {asset.content}
                  </pre>
                </div>
              </div>
            )}
          </>
        )}
      </details>
      <section className="space-y-3">
        <h3 className="font-semibold">Review version {asset.version}</h3>
        {can.review && !editing && (
          <>
            <label className="block text-sm">
              Review comment
              <textarea
                className="mt-1 min-h-20 w-full rounded border bg-background p-2"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="What is approved or needs revision?"
              />
            </label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() => decide.mutate('rejected')}
              >
                Request revision
              </Button>
              <Button
                size="sm"
                disabled={decide.isPending || asset.approvalStatus === 'approved'}
                onClick={() => decide.mutate('approved')}
              >
                Approve v{asset.version}
              </Button>
            </div>
          </>
        )}
        {decide.isError && <InlineError message={decide.error.message} />}
        {approvals.isLoading ? (
          <p role="status">Loading reviews…</p>
        ) : approvals.isError ? (
          <InlineError
            message="Review history could not be loaded."
            onRetry={() => approvals.refetch()}
          />
        ) : decisions.length ? (
          <details>
            <summary className="cursor-pointer text-sm">
              Review history ({decisions.length})
            </summary>
            <ol className="mt-3 divide-y">
              {decisions.map((item) => (
                <li key={item.decision.id} className="py-2 text-sm">
                  <strong>{item.actorName}</strong> · {item.decision.decision} v
                  {item.decision.assetVersion} ·{' '}
                  {new Date(item.decision.createdAt).toLocaleString()}
                  {item.decision.comment && (
                    <p className="mt-1 text-muted-foreground">{item.decision.comment}</p>
                  )}
                </li>
              ))}
            </ol>
          </details>
        ) : (
          <p className="text-xs text-muted-foreground">No reviews recorded for this asset.</p>
        )}
      </section>
      <section className="space-y-3 border-t pt-4">
        <h3 className="font-semibold">CMS draft destination</h3>
        {asset.approvalStatus !== 'approved' ? (
          <p className="text-sm text-muted-foreground">
            Approval of this exact version is required before creating a CMS draft.
          </p>
        ) : !can.connections ? (
          <p className="text-sm text-muted-foreground">
            The owner can create a draft from this approved version.
          </p>
        ) : connections.isError ? (
          <InlineError
            message="Destinations could not be loaded."
            onRetry={() => connections.refetch()}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {connections.data?.connections
              .filter((item) => item.connected)
              .map((connection) => {
                const last = history.find(
                  (item) =>
                    item.platform === connection.platform && item.assetVersion === asset.version,
                );
                const blocked =
                  last &&
                  ['draft_created', 'pending'].includes(last.status);
                return (
                  <div key={connection.platform}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !connection.publishingReady ||
                        editing ||
                        publish.isPending ||
                        Boolean(blocked)
                      }
                      onClick={() => publish.mutate(connection.platform)}
                    >
                      {last?.status === 'sending' ? `Check ${connection.platform} draft outcome` : `${last?.status === 'ambiguous' ? 'Reconcile' : last?.status === 'retryable_failed' ? 'Retry' : 'Create'} ${connection.platform} draft`}
                    </Button>
                    {!connection.publishingReady && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Add blog and author in CMS destinations.
                      </p>
                    )}
                    {['ambiguous', 'sending'].includes(last?.status || '') && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {last?.status === 'sending' && 'This dispatch has no confirmed outcome yet. '}
                        Checking looks for the existing unpublished draft without creating another one.
                      </p>
                    )}
                  </div>
                );
              })}
            {!connections.data?.connections.some((item) => item.connected) && (
              <p className="text-sm text-muted-foreground">
                Connect a destination below to continue.
              </p>
            )}
          </div>
        )}
        {publish.isError && <InlineError message={publish.error.message} />}
        {can.connections &&
          (attempts.isLoading ? (
            <p role="status">Loading publication history…</p>
          ) : attempts.isError ? (
            <InlineError
              message="Publication attempts could not be loaded."
              onRetry={() => attempts.refetch()}
            />
          ) : (
            <ol className="divide-y">
              {history.map((item) => (
                <li key={item.id} className="py-3 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <strong className="capitalize">{item.platform}</strong>
                    {statusBadge(item.status)}
                    <span>
                      v{item.assetVersion} · {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {item.errorMessage && (
                    <p className="mt-1 text-destructive">{item.errorMessage}</p>
                  )}
                  {item.destinationUrl && safeCitationUrl(item.destinationUrl) && (
                    <a
                      href={item.destinationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block text-primary underline"
                    >
                      Open exact CMS draft
                    </a>
                  )}
                </li>
              ))}
            </ol>
          ))}
      </section>
    </section>
  );
}
