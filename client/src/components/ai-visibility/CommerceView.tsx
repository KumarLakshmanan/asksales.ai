'use client';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { Input } from '@/components/ui/input';
import { aiVisibilityApi } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Callout } from '@/components/ui/callout';
import { CmsConnections } from './CmsConnections';
import { refreshVisibility, useMeasurement } from './workspace-context';
import {
  BUSINESS_TYPES,
  Empty,
  InlineError,
  Loading,
  showsCommerce,
  statusBadge,
  websiteHost,
} from './workspace-ui';
const SOURCE_LABELS: Record<string, string> = {
  csv: 'CSV file',
  json: 'JSON file',
  xml: 'XML file',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
};
const fields = [
  'identifier',
  'title',
  'description',
  'image',
  'price',
  'currency',
  'availability',
  'variants',
  'shipping',
  'returns',
  'reviews',
];
export const SAMPLE_FEED =
  'id,title,description,image,price,currency,availability,variants,shipping,returns,reviews\nSAMPLE-001,Example product,Replace this example with an accurate product description,https://example.com/product.jpg,100.00,INR,in_stock,Standard,See shipping policy,See return policy,0\n';
function downloadSample() {
  const url = URL.createObjectURL(new Blob([SAMPLE_FEED], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ai-visibility-product-feed-example.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CommerceView({ projectId }: { projectId: number }) {
  const { can, project, overview } = useMeasurement();
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [search, setSearch] = useState(''),
    [issuesOnly, setIssuesOnly] = useState(false),
    [offset, setOffset] = useState(0);
  const [snapshotId, setSnapshotId] = useState<number>();
  const query = useQuery({
    queryKey: ['ai-visibility-commerce', projectId],
    queryFn: () => aiVisibilityApi.commerce(projectId),
  });
  const snapshot =
    query.data?.snapshots.find((item) => item.id === snapshotId) || query.data?.latestSnapshot;
  const products = useQuery({
    queryKey: [
      'ai-visibility-commerce-products',
      projectId,
      snapshot?.id,
      search,
      issuesOnly,
      offset,
    ],
    queryFn: () =>
      aiVisibilityApi.commerceProducts(projectId, {
        snapshotId: snapshot?.id,
        query: search,
        issuesOnly,
        offset,
        limit: 50,
      }),
    enabled: Boolean(snapshot),
  });
  const connections = useQuery({
    queryKey: ['ai-visibility-cms-connections', projectId],
    queryFn: () => aiVisibilityApi.cmsConnections(projectId),
  });
  const refresh = () => {
    setSnapshotId(undefined);
    setOffset(0);
    refreshVisibility(client, projectId);
  };
  const upload = useMutation({
    mutationFn: () =>
      aiVisibilityApi.uploadCommerceFeed(
        projectId,
        file!,
        Object.fromEntries(Object.entries(mapping).filter(([, value]) => value.trim())),
      ),
    onSuccess: () => {
      setFile(null);
      refresh();
    },
  });
  const sync = useMutation({
    mutationFn: () => aiVisibilityApi.syncShopifyCatalog(projectId),
    onSuccess: refresh,
  });
  const woo = useMutation({
    mutationFn: () => aiVisibilityApi.syncWooCommerceCatalog(projectId),
    onSuccess: refresh,
  });
  const shopifyConnected = Boolean(
    connections.data?.connections.some((item) => item.platform === 'shopify' && item.connected),
  );
  const store = !project || showsCommerce(project, overview?.latestScore);
  const host = project ? websiteHost(project.domain) : 'this website';
  const businessType =
    BUSINESS_TYPES.find((type) => type.value === project?.scoringProfile)?.label.replace(/ \(.*\)$/, '') ||
    'Other business';
  return (
    <div className="space-y-5">
      {!store && !query.data?.latestSnapshot && (
        <Callout title="Commerce is for online stores">
          {host} is set up as “{businessType}”, so Commerce is not part of its score. If you sell
          products on this website, choose “Online store” under What this website is, in Settings
          and monitoring.
        </Callout>
      )}
      {query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <InlineError
          message="Catalog health could not be loaded."
          onRetry={() => query.refetch()}
        />
      ) : snapshot ? (
        <section aria-label="Catalog health" className="space-y-3 border-b pb-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-semibold">{snapshot.sourceName}</h2>
              <p className="text-xs text-muted-foreground">
                {SOURCE_LABELS[snapshot.sourceType] || snapshot.sourceType} · checked{' '}
                {new Date(snapshot.createdAt).toLocaleString()} · snapshot #{snapshot.id}
              </p>
            </div>
            <label className="text-sm">
              Snapshot
              <select
                className="ml-2 rounded border bg-background p-2"
                value={snapshot.id}
                onChange={(event) => {
                  setSnapshotId(Number(event.target.value));
                  setOffset(0);
                }}
              >
                {query.data?.snapshots.map((item) => (
                  <option key={item.id} value={item.id}>
                    {new Date(item.createdAt).toLocaleString()} · {item.sourceName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-8">
            <div>
              <strong className="font-mono text-3xl">{Math.round(Number(snapshot.score))}</strong>
              <p className="text-xs text-muted-foreground">catalog readiness</p>
            </div>
            <div>
              <strong className="font-mono text-3xl">
                {snapshot.validItemCount}/{snapshot.itemCount}
              </strong>
              <p className="text-xs text-muted-foreground">products pass required checks</p>
            </div>
            <button
              className="text-left"
              onClick={() => {
                setIssuesOnly(true);
                setOffset(0);
              }}
            >
              <strong className="font-mono text-3xl">
                {snapshot.itemCount - snapshot.validItemCount}
              </strong>
              <p className="text-xs text-primary">products need attention →</p>
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Catalog validation has its own snapshot date. The overall visibility score updates on
            the next full analysis.
          </p>
        </section>
      ) : null}
      <details className="border-b pb-4" open={!snapshot && store ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">
          {snapshot ? 'Update your product catalog' : 'Add your product catalog'}
        </summary>
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="font-semibold">Upload a feed</h2>
            <p className="my-2 text-xs text-muted-foreground">
              CSV, JSON or XML · up to 15 MB and 100,000 products. Download the example, replace
              every example value with real catalog data, then validate.
            </p>
            <Button variant="outline" size="sm" onClick={downloadSample}>
              Download example CSV
            </Button>
            <form
              className="mt-3 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                upload.mutate();
              }}
            >
              <label className="block text-sm">
                Product feed
                <Input
                  type="file"
                  accept=".csv,.json,.xml"
                  disabled={!can.edit || upload.isPending}
                  onChange={(event) => setFile(event.target.files?.[0] || null)}
                />
              </label>
              <details>
                <summary className="cursor-pointer text-sm">
                  Map custom column names (optional)
                </summary>
                <p className="mt-2 text-xs text-muted-foreground">
                  Common names such as id, sku, title and image_link are detected automatically.
                  Enter the source column/key for each custom field.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {fields.map((field) => (
                    <label key={field} className="text-xs capitalize">
                      {field}
                      <Input
                        value={mapping[field] || ''}
                        placeholder="Auto-detect"
                        disabled={!can.edit || upload.isPending}
                        onChange={(event) =>
                          setMapping((current) => ({
                            ...current,
                            [field]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </details>
              {file && file.size > 15 * 1024 * 1024 && (
                <p className="text-sm text-destructive">The file exceeds 15 MB.</p>
              )}
              <Button
                size="sm"
                disabled={!can.edit || !file || file.size > 15 * 1024 * 1024 || upload.isPending}
              >
                {upload.isPending ? 'Uploading & validating…' : 'Validate feed'}
              </Button>
              {upload.isPending && (
                <p role="status" className="text-sm">
                  Uploading the feed, parsing product records and checking required fields. The
                  completed snapshot appears automatically.
                </p>
              )}
              {upload.isError && (
                <InlineError message={upload.error.message} onRetry={() => upload.mutate()} />
              )}
              {upload.isSuccess && (
                <p role="status" className="text-sm">
                  Validation finished. Review product issues below.
                </p>
              )}
            </form>
          </section>
          <div className="space-y-6">
          <section>
            <h2 className="font-semibold">WooCommerce store</h2>
            <p className="my-2 text-xs text-muted-foreground">
              If {host} runs WooCommerce, its products are read from the store&apos;s public product
              list. No login is needed.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!can.edit || woo.isPending}
              onClick={() => woo.mutate()}
            >
              {woo.isPending ? 'Reading products…' : `Read products from ${host}`}
            </Button>
            {woo.isError && (
              <InlineError message={woo.error.message} onRetry={() => woo.mutate()} />
            )}
          </section>
          <section>
            <h2 className="font-semibold">Shopify catalog</h2>
            <CmsConnections projectId={projectId} catalogOnly />
            {shopifyConnected && (
              <Button
                size="sm"
                variant="outline"
                disabled={!can.connections || sync.isPending}
                onClick={() => sync.mutate()}
              >
                {sync.isPending ? 'Reading & validating catalog…' : 'Sync Shopify products'}
              </Button>
            )}
            {sync.isPending && (
              <p role="status" className="mt-2 text-sm">
                Reading product pages from Shopify and validating the catalog…
              </p>
            )}
            {sync.isError && (
              <InlineError message={sync.error.message} onRetry={() => sync.mutate()} />
            )}
            {connections.isError && (
              <InlineError
                message="Shopify connection could not be loaded."
                onRetry={() => connections.refetch()}
              />
            )}
          </section>
          </div>
        </div>
      </details>
      {snapshot && (
        <>
          <details className="border-b pb-3">
            <summary className="cursor-pointer text-sm font-medium">
              Field coverage & validation rules ({snapshot.issues.length} findings)
            </summary>
            <div className="mt-3 overflow-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Field</th>
                    <th className="p-2">Coverage</th>
                    <th className="p-2">Finding</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(snapshot.fieldCoverage).map(([field, value]) => (
                    <tr key={field}>
                      <th className="p-2 font-normal">{field}</th>
                      <td className="p-2">{Math.round(value * 100)}%</td>
                      <td className="p-2">
                        {snapshot.issues
                          .filter((issue) => issue.field === field)
                          .map((issue, index) => (
                            <p key={index}>{issue.message}</p>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snapshot.issues
                .filter((issue) => !(issue.field in snapshot.fieldCoverage))
                .map((issue, index) => (
                  <p key={index} className="p-2 text-sm">
                    {issue.message}
                  </p>
                ))}
            </div>
          </details>
          <section aria-label="Product validation">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="font-semibold">Product validation</h2>
              <Input
                className="sm:ml-auto sm:max-w-sm"
                aria-label="Search catalog products"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
                placeholder="Search product, identifier or issue"
              />
              <label className="text-sm">
                <input
                  type="checkbox"
                  checked={issuesOnly}
                  onChange={(event) => {
                    setIssuesOnly(event.target.checked);
                    setOffset(0);
                  }}
                />{' '}
                Only products with issues
              </label>
            </div>
            {products.isLoading ? (
              <Loading />
            ) : products.isError ? (
              <InlineError
                message="Product validation details could not be loaded."
                onRetry={() => products.refetch()}
              />
            ) : products.data?.available === false ? (
              <Empty message="This older snapshot has no product-level validation evidence. Upload or sync a fresh catalog to populate it." />
            ) : (
              <>
                <div className="overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b">
                      <tr>
                        <th className="p-2">Row / ID</th>
                        <th className="p-2">Product</th>
                        <th className="p-2">Validation</th>
                        <th className="p-2">Issues</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {products.data?.products.map((item) => (
                        <tr key={`${item.row}:${item.identifier}`}>
                          <td className="p-2">
                            {item.row}
                            <span className="block text-xs text-muted-foreground">
                              {item.identifier || 'Missing identifier'}
                            </span>
                          </td>
                          <td className="max-w-xs break-words p-2">
                            {item.title || 'Missing title'}
                          </td>
                          <td className="p-2">
                            {statusBadge(item.valid ? 'passed' : 'needs_attention')}
                          </td>
                          <td className="max-w-md p-2">
                            {item.issues.length ? (
                              <ul className="list-disc pl-4">
                                {item.issues.map((issue, index) => (
                                  <li key={index}>{issue}</li>
                                ))}
                              </ul>
                            ) : (
                              'No required-field issues'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!products.data?.products.length && (
                  <Empty message="No products match these filters." />
                )}
                <Pagination
                  aria-label="Product pages"
                  className="mt-4"
                  page={Math.floor(offset / 50) + 1}
                  pageSize={50}
                  totalItems={products.data?.total || 0}
                  onPageChange={(next) => setOffset((next - 1) * 50)}
                  itemLabel="products"
                />
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
