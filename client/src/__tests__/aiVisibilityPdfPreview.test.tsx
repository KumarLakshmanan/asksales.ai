import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { ReportLibrary } from '@/components/ai-visibility/ReportLibrary';
import { afterAll as afterAllReadRetry, beforeAll as beforeAllReadRetry } from 'vitest';
import { TRANSIENT_READ_RETRY_DELAYS_MS, transientReadRetry } from '@/lib/api-client';

// These cases exercise the feature's own recovery screen after one failed
// read, so the API client's automatic read retry is turned off here.
beforeAllReadRetry(() => { transientReadRetry.delaysMs = []; });
afterAllReadRetry(() => { transientReadRetry.delaysMs = TRANSIENT_READ_RETRY_DELAYS_MS; });

const api = vi.hoisted(() => ({ reports: vi.fn(), reportUrl: vi.fn(), retryReport: vi.fn() }));
vi.mock('@/lib/ai-visibility', () => ({ aiVisibilityApi: api }));

const savedReport = {
  auditId: 29,
  status: 'completed',
  createdAt: '2026-08-28T21:22:00Z',
  completedAt: '2026-08-28T21:24:53Z',
  sizeBytes: 42 * 1024,
};
const clients: QueryClient[] = [];
const viewerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'pdfViewerEnabled');
const pdfResponse = () => new Response('%PDF-1.4\nSynthetic fixture', { headers: { 'Content-Type': 'application/pdf' } });

function renderLibrary(strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = (
    <QueryClientProvider client={client}>
      <ReportLibrary projectId={1} onDownload={vi.fn()} onEmail={vi.fn()} onShare={vi.fn()} sharing={false} />
    </QueryClientProvider>
  );
  return render(strict ? <StrictMode>{view}</StrictMode> : view);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'synthetic-token');
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  sessionStorage.setItem('active-business-profile:4101', '4102');
  api.reports.mockResolvedValue({ reports: [savedReport] });
  api.reportUrl.mockImplementation((id: number) => `/api/ai-visibility/audits/${id}/report`);
  Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: true });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:synthetic-pdf');
    static revokeObjectURL = vi.fn();
  });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  if (viewerDescriptor) Object.defineProperty(navigator, 'pdfViewerEnabled', viewerDescriptor);
  else Reflect.deleteProperty(navigator, 'pdfViewerEnabled');
});

describe('AS019 saved PDF response and browser recovery contract', () => {
  it('removes the preview and actions for a report excluded by the search filter', async () => {
    const fetchMock=vi.fn().mockImplementation(pdfResponse);vi.stubGlobal('fetch',fetchMock);
    renderLibrary();await screen.findByTitle('PDF preview for analysis 29');
    const search=screen.getByRole('textbox',{name:'Search reports'});
    await userEvent.type(search,'NO_MATCH_SYNTHETIC');
    expect(screen.getByText('0 matching reports')).toBeInTheDocument();
    expect(screen.queryByTitle('PDF preview for analysis 29')).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Download PDF'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'Save PDF'})).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-pdf');
    await userEvent.clear(search);await screen.findByTitle('PDF preview for analysis 29');
    expect(fetchMock).toHaveBeenCalledTimes(1);expect(api.retryReport).not.toHaveBeenCalled();
  });

  it('cancels a filtered-out pending PDF and ignores its late response while showing a matching report', async () => {
    api.reports.mockResolvedValue({reports:[savedReport,{...savedReport,auditId:30}]});
    let finish!:(response:Response)=>void;
    const fetchMock=vi.fn().mockImplementation((url:string)=>url.includes('/29/')?new Promise<Response>(resolve=>{finish=resolve;}):Promise.resolve(pdfResponse()));
    vi.stubGlobal('fetch',fetchMock);renderLibrary();
    await screen.findByRole('textbox',{name:'Search reports'});await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
    try {
      const signal=fetchMock.mock.calls[0][1].signal as AbortSignal;
      await userEvent.type(screen.getByRole('textbox',{name:'Search reports'}),'30');
      expect(signal.aborted).toBe(true);await screen.findByTitle('PDF preview for analysis 30');
      await act(async()=>{finish(pdfResponse());});
      expect(screen.queryByTitle('PDF preview for analysis 29')).not.toBeInTheDocument();
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);expect(api.retryReport).not.toHaveBeenCalled();
    } finally {finish(pdfResponse());}
  });

  it('owns the canceled StrictMode mount read while the replacement mount completes', async () => {
    const fetchMock = vi.fn().mockImplementation(pdfResponse);
    vi.stubGlobal('fetch', fetchMock);
    renderLibrary(true);
    await screen.findByTitle('PDF preview for analysis 29');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const second = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
  it('accepts a PDF Content-Type with case and parameters while preserving the authenticated bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('%PDF-1.7\nSynthetic fixture', {
      headers: { 'Content-Type': 'Application/PDF; charset=binary' },
    })));
    renderLibrary();
    await screen.findByTitle('PDF preview for analysis 29');
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe('%PDF-1.7\nSynthetic fixture');
  });

  it('shows a safe connection recovery for a failed fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('synthetic private network detail')));
    renderLibrary();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Check your connection and retry/);
    expect(alert).not.toHaveTextContent('synthetic private network detail');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects an interrupted response body without exposing transport details or mounting a viewer', async () => {
    const response = pdfResponse();
    vi.spyOn(response, 'blob').mockRejectedValue(new Error('synthetic private storage detail'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    renderLibrary();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/file transfer was interrupted/i);
    expect(alert).not.toHaveTextContent('synthetic private storage detail');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ['HTML success', 'text/html', '<html>synthetic login page</html>'],
    ['JSON success', 'application/json', '{"error":"synthetic"}'],
    ['missing Content-Type', null, '%PDF-1.4\nSynthetic fixture'],
    ['mislabeled HTML', 'application/pdf', '<html>synthetic login page</html>'],
    ['empty PDF', 'application/pdf', ''],
  ])('rejects %s before embedding or exposing a blob link', async (_name, type, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      headers: type ? { 'Content-Type': type } : {},
    })));
    renderLibrary();
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid PDF/);
    expect(screen.queryByTitle('PDF preview for analysis 29')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open PDF in a new tab' })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(api.retryReport).not.toHaveBeenCalled();
  });

  it.each([
    [401, /sign in again/i], [403, /permission/i], [404, /saved PDF.*unavailable/i],
    [409, /not ready/i], [503, /try again later/i],
  ])('gives scoped recovery for HTTP %s without displaying private response details', async (status, recovery) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('synthetic private detail', { status })));
    renderLibrary();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(recovery);
    expect(alert).not.toHaveTextContent('synthetic private detail');
    expect(api.retryReport).not.toHaveBeenCalled();
  });

  it('cancels a loading read when the preview unmounts without caching late bytes', async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderLibrary();
    expect(await screen.findByText('Loading PDF preview…')).toHaveAttribute('role', 'status');
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(pdfResponse()));
    expect(clients.at(-1)?.getQueryData(['ai-visibility-report-pdf', 29, savedReport.completedAt])).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('fences a canceled report selection and keeps the next report usable', async () => {
    api.reports.mockResolvedValue({ reports: [savedReport, { ...savedReport, auditId: 30 }] });
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }))
      .mockResolvedValueOnce(pdfResponse());
    vi.stubGlobal('fetch', fetchMock);
    renderLibrary();
    await screen.findByText('Loading PDF preview…');
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await userEvent.click(screen.getByRole('button', { name: /Analysis #30/ }));
    expect(await screen.findByTitle('PDF preview for analysis 30')).toHaveAttribute('src', 'blob:synthetic-pdf');
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(pdfResponse()));
    expect(screen.queryByTitle('PDF preview for analysis 29')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('offers authenticated blob recovery when the native PDF viewer is unavailable', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: false });
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse());
    vi.stubGlobal('fetch', fetchMock);
    renderLibrary();
    const open = await screen.findByRole('link', { name: 'Open PDF in a new tab' });
    expect(open).toHaveAttribute('href', 'blob:synthetic-pdf');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Save PDF' })).toHaveAttribute('download', 'ai-visibility-audit-29.pdf');
    expect(screen.getByText(/browser cannot display PDFs inline/i)).toBeInTheDocument();
    expect(screen.queryByTitle('PDF preview for analysis 29')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps recovery available for a blank viewer and an explicit frame failure', async () => {
    const fetchMock = vi.fn().mockImplementation(pdfResponse);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:synthetic-pdf').mockReturnValueOnce('blob:recovered-pdf');
    renderLibrary();
    const frame = await screen.findByTitle('PDF preview for analysis 29');
    expect(screen.getByRole('link', { name: 'Open PDF in a new tab' })).toHaveAttribute('href', 'blob:synthetic-pdf');
    expect(screen.getByText(/preview is blank/i)).toBeInTheDocument();
    fireEvent.error(frame);
    expect(await screen.findByRole('alert')).toHaveTextContent(/browser could not open.*PDF/i);
    expect(screen.getByRole('link', { name: 'Save PDF' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTitle('PDF preview for analysis 29')).toHaveAttribute('src', 'blob:recovered-pdf');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-pdf');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(api.retryReport).not.toHaveBeenCalled();
  });
});

// Preserve the original transport assertions and their generic message prefix.
describe('AS019 saved PDF transport diagnosis', () => {
  it.each([401, 403, 404, 409, 500])('shows the same pre-viewer failure for HTTP %s', async status => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Synthetic transport failure' }), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderLibrary();
    expect(await screen.findByRole('alert')).toHaveTextContent('The PDF preview could not be loaded.');
    expect(screen.queryByTitle('PDF preview for analysis 29')).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith('/api/ai-visibility/audits/29/report', {
      credentials: 'include',
      headers: { Authorization: 'Bearer synthetic-token', 'X-Business-Profile-Id': '4102' },
      signal: expect.any(AbortSignal),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('The PDF preview could not be loaded.');
    expect(api.retryReport).not.toHaveBeenCalled();
  });

  it('recovers by fetching the same saved report after a transient failure and revokes its blob', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Synthetic outage', { status: 503 }))
      .mockResolvedValueOnce(new Response('%PDF-1.4\nSynthetic fixture', { headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderLibrary();
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTitle('PDF preview for analysis 29')).toHaveAttribute('src', 'blob:synthetic-pdf');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(api.retryReport).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-pdf');
  });
});
