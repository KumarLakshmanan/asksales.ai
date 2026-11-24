'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { aiVisibilityApi } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, Unplug } from 'lucide-react';
import { useState } from 'react';

import { useMeasurement } from './workspace-context';
import { Empty, formatPercent, InlineError, safeCitationUrl } from './workspace-ui';
export function GscCard({ projectId }: { projectId: number }) {
  const { can } = useMeasurement();
  const [startDate, setStartDate] = useState(
    new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
  );
  const [endDate, setEndDate] = useState(
    new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
  );
  const [compare, setCompare] = useState(true);
  const [search, setSearch] = useState('');
  const [snapshotId, setSnapshotId] = useState<number>();
  const [visible, setVisible] = useState(25);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const query = useQuery({
    queryKey: ['ai-visibility-gsc', projectId, snapshotId],
    queryFn: () => aiVisibilityApi.gsc(projectId, snapshotId),
  });
  const connect = useMutation({
    mutationFn: () => aiVisibilityApi.gscAuthUrl(projectId),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) =>
      toast({
        title: 'Search Console connection could not start',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const sync = useMutation({
    mutationFn: () => aiVisibilityApi.syncGsc(projectId, { startDate, endDate, compare }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-gsc', projectId],
      });
      toast({
        title: 'Search Console synchronized',
        description: 'Verified query and page opportunities are now up to date.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Search Console sync failed',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const selectProperty = useMutation({
    mutationFn: (propertyUri: string) => aiVisibilityApi.selectGscProperty(projectId, propertyUri),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-gsc', projectId],
      }),
    onError: (error) =>
      toast({
        title: 'Property could not be selected',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const disconnect = useMutation({
    mutationFn: () => aiVisibilityApi.disconnectGsc(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-gsc', projectId],
      });
      toast({ title: 'Search Console disconnected for this website' });
    },
    onError: (error) =>
      toast({
        title: 'Search Console could not be disconnected',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  if (query.isLoading)
    return (
      <Card>
        <CardContent className="p-0">
          <LoadingState size="inline" className="min-h-32" label="Loading Search Console…" />
        </CardContent>
      </Card>
    );
  if (query.isError)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Google Search Console</CardTitle>
        </CardHeader>
        <CardContent>
          <InlineError
            message="Search Console status could not be loaded."
            onRetry={() => query.refetch()}
          />
        </CardContent>
      </Card>
    );
  const data = query.data!;
  const connection = data.connection;
  const properties = connection?.availableProperties || [];
  const matchingOpportunities = data.opportunities.filter((item) =>
    [item.query, item.page].join(' ').toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Google Search Console</CardTitle>
          <CardDescription className="mt-1.5">
            Use verified Google query and landing-page data to find SEO opportunities. Connecting
            and syncing do not use wallet credits.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.connected ? (
            <>
              <Button
                size="sm"
                variant="outline"
                loading={sync.isPending}
                loadingText="Sync selected dates"
                disabled={!can.connections || !connection?.selectedProperty}
                onClick={() => sync.mutate()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Sync selected dates
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!can.connections || disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                <Unplug className="mr-2 h-4 w-4" />
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              loading={connect.isPending}
              disabled={!can.connections}
              onClick={() => connect.mutate()}
            >
              Connect Search Console
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Start date
            <Input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label className="text-sm">
            End date
            <Input
              type="date"
              value={endDate}
              max={new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
          <label className="py-2 text-sm">
            <input
              type="checkbox"
              checked={compare}
              onChange={(event) => setCompare(event.target.checked)}
            />{' '}
            Compare previous period
          </label>
        </div>
        {data.snapshots && data.snapshots.length > 0 && (
          <label className="block text-sm">
            Stored snapshot
            <select
              className="ml-2 rounded border bg-background p-2"
              value={snapshotId || data.snapshot?.id || ''}
              onChange={(event) => setSnapshotId(Number(event.target.value))}
            >
              {data.snapshots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.startDate} to {item.endDate} ·{' '}
                  {new Date(item.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </label>
        )}
        {data.comparison && (
          <p className="text-sm">
            Previous period ({data.comparison.snapshot.startDate}–{data.comparison.snapshot.endDate}
            ): {data.comparison.clicks.toLocaleString()} clicks,{' '}
            {data.comparison.impressions.toLocaleString()} impressions in loaded rows.
          </p>
        )}
        <Input
          aria-label="Search Search Console queries and pages"
          placeholder="Search query or page"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setVisible(25);
          }}
        />

        {data.connected && properties.length > 0 && (
          <div className="max-w-xl space-y-1.5">
            <Label>Search Console property</Label>
            <Select
              value={connection?.selectedProperty || undefined}
              onValueChange={(value) => selectProperty.mutate(value)}
              disabled={!can.connections || selectProperty.isPending}
            >
              <SelectTrigger aria-label="Search Console property">
                <SelectValue placeholder="Choose a verified property" />
              </SelectTrigger>
              <SelectContent>
                {properties.map((property) => (
                  <SelectItem key={property.siteUrl} value={property.siteUrl}>
                    {property.siteUrl} · {property.permissionLevel.replaceAll('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {!data.available ? (
          <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            {data.unavailableReason}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-lg border p-3">
                <div className="text-xl font-semibold">
                  {Math.round(data.summary?.clicks || 0).toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">Clicks in loaded rows</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xl font-semibold">
                  {Math.round(data.summary?.impressions || 0).toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">Impressions in loaded rows</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xl font-semibold">{formatPercent(data.summary?.ctr)}</div>
                <div className="text-xs text-muted-foreground">Click-through rate</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xl font-semibold">
                  {data.summary?.position ? data.summary.position.toFixed(1) : '—'}
                </div>
                <div className="text-xs text-muted-foreground">Impression-weighted position</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">Search opportunities</div>
                <div className="text-sm text-muted-foreground">
                  Queries with at least 50 impressions, positions 4–20, and CTR below the 5% review
                  threshold.
                </div>
              </div>
              {data.snapshot && (
                <div className="text-xs text-muted-foreground">
                  {data.snapshot.startDate} to {data.snapshot.endDate}
                </div>
              )}
            </div>
            <div className="space-y-3">
              {matchingOpportunities.length ? (
                matchingOpportunities.slice(0, visible).map((item) => {
                  const pageUrl = safeCitationUrl(item.page);
                  return (
                    <div key={`${item.query}:${item.page}`} className="rounded-lg border p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{item.query}</span>
                            <Badge variant={item.priority === 'high' ? 'default' : 'outline'}>
                              {item.priority} opportunity
                            </Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p>
                          {pageUrl ? (
                            <a
                              className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-primary hover:underline"
                              href={pageUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {item.page}
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                          ) : (
                            <p className="mt-1 break-all text-xs text-muted-foreground">
                              {item.page}
                            </p>
                          )}
                        </div>
                        <div className="shrink-0 text-sm text-muted-foreground">
                          {Math.round(item.impressions).toLocaleString()} impressions ·{' '}
                          {formatPercent(item.ctr)} CTR · position {item.position.toFixed(1)}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <Empty
                  message={
                    search
                      ? 'No opportunities match this search.'
                      : 'No query/page rows crossed the current opportunity thresholds.'
                  }
                />
              )}
            </div>
          </>
        )}
        {data.available && (
          <p className="text-xs text-muted-foreground">
            {matchingOpportunities.length} matching opportunities · {data.opportunities.length}{' '}
            total in loaded rows
          </p>
        )}
        {visible < matchingOpportunities.length && (
          <Button variant="outline" size="sm" onClick={() => setVisible((value) => value + 25)}>
            Show more opportunities
          </Button>
        )}
        <details>
          <summary className="cursor-pointer text-sm">
            All loaded query/page rows ({data.rows?.length || 0})
          </summary>
          <div className="mt-3 max-h-96 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Query / page</th>
                  <th>Clicks</th>
                  <th>Impressions</th>
                  <th>CTR</th>
                  <th>Position</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.rows
                  ?.filter((item) =>
                    [item.query, item.page].join(' ').toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((item, index) => (
                    <tr key={index}>
                      <td className="max-w-xs break-words py-2">
                        {item.query}
                        <p className="text-muted-foreground">{item.page}</p>
                      </td>
                      <td>{item.clicks}</td>
                      <td>{item.impressions}</td>
                      <td>{formatPercent(item.ctr)}</td>
                      <td>{item.position.toFixed(1)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
        {connection?.lastSyncError && (
          <p className="text-sm text-destructive">Last sync: {connection.lastSyncError}</p>
        )}
      </CardContent>
    </Card>
  );
}
