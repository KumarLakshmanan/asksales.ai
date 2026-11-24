'use client';

import { fetchSavedReportPdf } from '@/lib/savedReportPdf';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { aiVisibilityApi, type AiVisibilityReport } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { ReportMethodologySummary } from './ReportMethodologySummary';
import { refreshVisibility, useMeasurement } from './workspace-context';
import { Empty, InlineError, Loading, statusBadge } from './workspace-ui';

function reportFailureMessage(error: string, auditId: number) {
  if (/storage limit/i.test(error))
    return 'There is not enough storage to save this PDF. Review storage usage before retrying.';
  if (/\b(?:EACCES|EPERM)\b|storage is not writable/i.test(error))
    return `The PDF could not be saved. Ask support to check report storage access for Analysis #${auditId} before retrying.`;
  return `The PDF could not be generated. Try again later, or contact support with Analysis #${auditId} if the problem continues.`;
}

export function ReportLibrary({
  projectId,
  onDownload,
  onEmail,
  onShare,
  sharing,
  downloading,
}: {
  projectId: number;
  onDownload: (id: number, format: 'pdf' | 'csv' | 'json') => void;
  onEmail: (id: number) => void;
  onShare: (id: number) => void;
  sharing: boolean;
  downloading?: string | null;
}) {
  const { can } = useMeasurement();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<number>(),
    [compareId, setCompareId] = useState<number>();
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [retrying, setRetrying] = useState<number>();
  const [retryExpired, setRetryExpired] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const query = useQuery({
    queryKey: ['ai-visibility-reports', projectId],
    queryFn: () => aiVisibilityApi.reports(projectId),
    refetchInterval: retrying ? 3000 : false,
  });
  const retry = useMutation({
    mutationFn: (id: number) => aiVisibilityApi.retryReport(id),
    onSuccess: (result) => {
      setRetryExpired(false);
      setRetryAttempt(
        query.data?.reports.find((report) => report.auditId === result.auditId)
          ?.generationAttempt || 0,
      );
      setRetrying(result.auditId);
      refreshVisibility(client, projectId);
    },
  });
  const reports = query.data?.reports || [];
  const previous = reports.find((report) => report.auditId === compareId);
  const searchText = search.trim().toLowerCase();
  const analysisNumber = /^(?:analysis\s*)?#\s*(\d+)$/.exec(searchText);
  const filtered = reports.filter((report) =>
    analysisNumber
      ? report.auditId === Number(analysisNumber[1])
      : [report.auditId, new Date(report.createdAt).toLocaleDateString(), report.status]
          .join(' ')
          .toLowerCase()
          .includes(searchText),
  );
  const selected = filtered.find((report) => report.auditId === selectedId) || filtered[0];
  useEffect(() => {
    if (!retrying) return;
    const report = reports.find((report) => report.auditId === retrying);
    const completed = report?.status === 'completed';
    const failed =
      (report?.generationAttempt || 0) > retryAttempt &&
      ['warning', 'failed'].includes(report?.generationStatus || '');
    if (completed || failed) {
      setRetrying(undefined);
      refreshVisibility(client, projectId);
    }
  }, [query.dataUpdatedAt, retrying, retryAttempt, projectId, client]);
  useEffect(() => {
    if (!retrying) return;
    const timer = setTimeout(() => {
      setRetrying(undefined);
      setRetryExpired(true);
    }, 180000);
    return () => clearTimeout(timer);
  }, [retrying]);
  if (query.isLoading) return <Loading />;
  if (query.isError)
    return <InlineError message="Reports could not be loaded." onRetry={() => query.refetch()} />;
  if (!reports.length)
    return <Empty message="Complete an analysis to create a report and evidence export." />;
  return (
    <div className="space-y-4">
      <Input
        aria-label="Search reports"
        placeholder="Search date, analysis number or status"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setPage(0);
        }}
        className="sm:max-w-sm"
      />
      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div>
          <div className="divide-y border-y">
            {filtered.slice(page * 20, (page + 1) * 20).map((report) => (
              <button
                key={report.auditId}
                className={`w-full px-2 py-3 text-left hover:bg-muted focus-visible:ring-2 ${selected?.auditId === report.auditId ? 'bg-primary/5' : ''}`}
                onClick={() => setSelectedId(report.auditId)}
              >
                <span className="block text-sm font-medium">
                  {new Date(report.createdAt).toLocaleDateString()}
                </span>
                <span className="mb-2 block text-xs text-muted-foreground">
                  Analysis #{report.auditId} ·{' '}
                  {report.status === 'completed'
                    ? `${Math.round(Number(report.sizeBytes) / 1024)} KB PDF`
                    : 'PDF not ready'}
                </span>
                {statusBadge(report.status)}
              </button>
            ))}
          </div>
          {!filtered.length && <Empty message="No reports match these filters." />}
          <div className="mt-3 flex justify-between gap-2">
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
          <p className="mt-2 text-xs text-muted-foreground">{filtered.length} matching reports</p>
        </div>
        {selected && (
          <section className="min-w-0 space-y-4" aria-label="Report preview">
            <header>
              <h2 className="text-lg font-semibold">Analysis #{selected.auditId}</h2>
              <p className="text-xs text-muted-foreground">
                Measured {new Date(selected.createdAt).toLocaleString()} · PDF{' '}
                {selected.completedAt
                  ? `generated ${new Date(selected.completedAt).toLocaleString()}`
                  : 'not generated yet'}
              </p>
            </header>
            {Boolean(selected.correctionRevision) && (
              <Callout tone="warning">
                Evidence correction revision {selected.correctionRevision}. Scores remain
                historical. Existing PDFs may predate corrections; the complete evidence export
                includes current observations and correction metadata.
              </Callout>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={selected.status !== 'completed' || Boolean(downloading)}
                onClick={() => onDownload(selected.auditId, 'pdf')}
              >
                Download PDF
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(downloading)}
                onClick={() => onDownload(selected.auditId, 'csv')}
              >
                CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(downloading)}
                onClick={() => onDownload(selected.auditId, 'json')}
              >
                Complete evidence (JSON)
              </Button>
              {can.edit && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selected.status !== 'completed'}
                    onClick={() => onEmail(selected.auditId)}
                  >
                    Email
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selected.status !== 'completed' || sharing}
                    onClick={() => onShare(selected.auditId)}
                  >
                    Share for 7 days
                  </Button>
                </>
              )}
              {can.edit && selected.status !== 'completed' && (
                <Button
                  size="sm"
                  disabled={retry.isPending || retrying === selected.auditId}
                  onClick={() => retry.mutate(selected.auditId)}
                >
                  {retrying === selected.auditId
                    ? 'Generating PDF…'
                    : 'Retry PDF · no analysis charge'}
                </Button>
              )}
            </div>
            {downloading && (
              <p role="status" className="text-sm">
                Preparing {downloading} download…
              </p>
            )}
            {selected.status !== 'completed' && selected.error && (
              <InlineError
                title="PDF not ready"
                message={reportFailureMessage(selected.error, selected.auditId)}
              />
            )}
            {selected.status !== 'completed' &&
              selected.error?.toLowerCase().includes('storage limit') && (
                <a href="/dashboard/storage" className="block text-sm text-primary underline">
                  Review storage usage before retrying
                </a>
              )}
            {retry.isError && (
              <InlineError
                title="PDF not ready"
                message={reportFailureMessage(retry.error.message, retry.variables ?? selected.auditId)}
              />
            )}
            {retrying === selected.auditId && (
              <p role="status" className="text-sm">
                PDF generation queued. This library refreshes automatically when the report is
                ready.
              </p>
            )}
            {retryExpired && (
              <p className="text-sm text-muted-foreground">
                PDF generation is taking longer than expected.{' '}
                <button className="text-primary underline" onClick={() => query.refetch()}>
                  Refresh report status
                </button>
              </p>
            )}
            {selected.status === 'completed' && (
              <PdfPreview
                key={`${selected.auditId}:${selected.completedAt}`}
                auditId={selected.auditId}
                completedAt={selected.completedAt}
              />
            )}
            <p className="text-xs text-muted-foreground">
              New PDFs include every SEO finding and action-plan entry. Older PDFs may contain only
              the first 20 findings and 15 actions. The complete evidence download is not truncated.
            </p>
            <details className="border-y py-3">
              <summary className="cursor-pointer text-sm font-medium">
                Measurement coverage & methodology
              </summary>
              <ReportMethodologySummary methodology={selected.methodology} />
            </details>
            <details className="border-b pb-3">
              <summary className="cursor-pointer text-sm font-medium">
                Compare report scores
              </summary>
              <label className="mt-3 block text-sm">
                Compare with
                <select
                  className="ml-2 rounded border bg-background p-2"
                  value={compareId || ''}
                  onChange={(event) => setCompareId(Number(event.target.value) || undefined)}
                >
                  <option value="">Choose report</option>
                  {reports
                    .filter((item) => item.auditId !== selected.auditId)
                    .map((item) => (
                      <option key={item.auditId} value={item.auditId}>
                        #{item.auditId} · {new Date(item.createdAt).toLocaleDateString()}
                      </option>
                    ))}
                </select>
              </label>
              {previous && <ReportComparison current={selected} previous={previous} />}
            </details>
          </section>
        )}
      </div>
    </div>
  );
}
function PdfPreview({ auditId, completedAt }: { auditId: number; completedAt?: string | null }) {
  const [resource, setResource] = useState<{ blob: Blob; url: string }>();
  const [frameError, setFrameError] = useState(false);
  const [inlineViewerAvailable] = useState(() =>
    typeof navigator === 'undefined' || navigator.pdfViewerEnabled !== false,
  );
  const previewRef = useCallback((frame: HTMLIFrameElement | null) => {
    if (!frame) return;
    // Frame errors do not bubble; retain a native listener for the explicit
    // error event. Native PDF viewer failures may emit no event at all, so the
    // open/save alternatives stay visible regardless of this signal.
    const failed = () => setFrameError(true);
    frame.addEventListener('error', failed);
    return () => frame.removeEventListener('error', failed);
  }, []);
  const query = useQuery({
    queryKey: ['ai-visibility-report-pdf', auditId, completedAt],
    queryFn: ({ signal }) => fetchSavedReportPdf(auditId, signal),
    retry: false,
    staleTime: 300000,
  });
  useEffect(() => {
    if (!query.data) return;
    const url = URL.createObjectURL(query.data);
    setResource({ blob: query.data, url });
    setFrameError(false);
    return () => URL.revokeObjectURL(url);
  }, [query.data]);
  if (query.isLoading || query.isFetching) return <p role="status">Loading PDF preview…</p>;
  if (query.isError)
    return <InlineError message={query.error.message} onRetry={() => query.refetch()} />;
  return resource && resource.blob === query.data ? (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {inlineViewerAvailable
          ? 'If the preview is blank, open the PDF in a new tab or save it to view on your device.'
          : 'This browser cannot display PDFs inline. Open the PDF in a new tab or save it to view on your device.'}
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <a className="text-primary underline" href={resource.url} target="_blank" rel="noopener noreferrer">
          Open PDF in a new tab
        </a>
        <a className="text-primary underline" href={resource.url} download={`ai-visibility-audit-${auditId}.pdf`}>
          Save PDF
        </a>
      </div>
      {frameError && (
        <InlineError
          message="The browser could not open this PDF preview. Open the PDF in a new tab or save it to view on your device."
          onRetry={() => query.refetch()}
        />
      )}
      {inlineViewerAvailable && !frameError && (
        <iframe
          key={resource.url}
          src={resource.url}
          title={`PDF preview for analysis ${auditId}`}
          className="h-[65vh] min-h-96 w-full rounded-lg border"
          ref={previewRef}
        />
      )}
    </div>
  ) : null;
}
function ReportComparison({
  current,
  previous,
}: {
  current: AiVisibilityReport;
  previous: AiVisibilityReport;
}) {
  const a = current.methodology,
    b = previous.methodology;
  if (!a || !b)
    return (
      <p className="mt-3 text-sm">
        Detailed score comparison is unavailable for this older report.
      </p>
    );
  const compatible =
    a.scoring.version === b.scoring.version && a.scoring.profile === b.scoring.profile;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        {compatible
          ? 'Same scoring version and profile. Geography, sampled pages and provider coverage may differ; compare their methodology before interpreting changes.'
          : 'Different scoring versions or profiles; score changes are not directly comparable.'}
      </p>
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Pillar</th>
              <th>Previous</th>
              <th>Current</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {a.pillars.map((pillar) => {
              const before = b.pillars.find((item) => item.key === pillar.key);
              const delta =
                compatible && pillar.score !== null && before?.score != null
                  ? Math.round(pillar.score - before.score)
                  : null;
              return (
                <tr key={pillar.key}>
                  <th className="py-2 font-medium">{pillar.label}</th>
                  <td>{before?.score ?? '—'}</td>
                  <td>{pillar.score ?? '—'}</td>
                  <td>{delta === null ? 'Not comparable' : `${delta > 0 ? '+' : ''}${delta}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
