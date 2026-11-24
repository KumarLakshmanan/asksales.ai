import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReportLibrary } from '@/components/ai-visibility/ReportLibrary';
import { capabilities, MeasurementContext } from '@/components/ai-visibility/workspace-context';

const api = vi.hoisted(() => ({ reports: vi.fn(), retryReport: vi.fn() }));
vi.mock('@/lib/ai-visibility', () => ({ aiVisibilityApi: api }));
const clients: QueryClient[] = [];
const actions = { download: vi.fn(), email: vi.fn(), share: vi.fn() };
const report = (auditId: number, error: string | null = null) => ({
  auditId, status: 'missing', error, createdAt: '2026-10-27T08:30:00Z',
  completedAt: null, sizeBytes: 0,
});
function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>
    <MeasurementContext.Provider value={{ historical: false, can: capabilities('owner') }}>
      <ReportLibrary projectId={7} onDownload={actions.download} onEmail={actions.email} onShare={actions.share} sharing={false} />
    </MeasurementContext.Provider>
  </QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  api.reports.mockResolvedValue({ reports: [report(1), report(31), report(10)] });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

describe('Report library displayed identifiers and safe failures', () => {
  it.each(['#1', '  Analysis #1  ', 'analysis # 1'])(
    'matches the exact displayed analysis identifier %s without matching 10 or 31', async text => {
      renderLibrary();
      const search = await screen.findByRole('textbox', { name: 'Search reports' });
      await userEvent.type(search, text);
      expect(screen.getByText('1 matching reports')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Analysis #1' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Analysis #(?:31|10) ·/ })).not.toBeInTheDocument();
      expect(api.retryReport).not.toHaveBeenCalled();
      expect(actions.share).not.toHaveBeenCalled();
      expect(actions.email).not.toHaveBeenCalled();
    },
  );

  it('preserves number, status and local-date text search and clearing', async () => {
    api.reports.mockResolvedValue({ reports: [report(1), { ...report(31), status: 'failed' }, report(10)] });
    renderLibrary();
    const search = await screen.findByRole('textbox', { name: 'Search reports' });
    const user = userEvent.setup();
    for (const [text, count] of [
      ['31', 1], ['FAILED', 1],
      [new Date('2026-10-27T08:30:00Z').toLocaleDateString(), 3], ['#999', 0],
    ] as const) {
      await user.clear(search);
      await user.type(search, text);
      expect(screen.getByText(`${count} matching reports`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('region', { name: 'Report preview' })).not.toBeInTheDocument();
    await user.clear(search);
    expect(screen.getByText('3 matching reports')).toBeInTheDocument();
  });

  it('resets pagination when searching a displayed analysis number', async () => {
    api.reports.mockResolvedValue({ reports: Array.from({ length: 25 }, (_, index) => report(index + 1)) });
    renderLibrary();
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: /Analysis #25 ·/ })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search reports' }), '#1');
    expect(screen.getByRole('button', { name: /Analysis #1 ·/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it.each([
    ["EACCES: permission denied, mkdir '/app/server/uploads/1/document/ai-visibility/1'", /report storage access/i],
    ['AI Visibility report storage is not writable. Run the upload-init service.', /report storage access/i],
    ["ENOENT: no such file '/private/report.html'", /contact support with Analysis #1/i],
    ['Storage limit exceeded at /private/quota.json', /review storage usage before retrying/i],
  ])('shows safe, actionable guidance for a stored generation failure: %s', async (error, guidance) => {
    api.reports.mockResolvedValue({ reports: [report(1, error)] });
    const { container } = renderLibrary();
    expect(await screen.findByRole('alert')).toHaveTextContent(guidance);
    expect(container.textContent).not.toMatch(/EACCES|ENOENT|\/app\/server|\/private\/|upload-init/);
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Share for 7 days' })).toBeDisabled();
    expect(api.retryReport).not.toHaveBeenCalled();
    if (error.startsWith('Storage limit'))
      expect(screen.getByRole('link', { name: 'Review storage usage before retrying' })).toHaveAttribute('href', '/dashboard/storage');
  });

  it('also keeps a rejected, explicitly requested PDF retry free of server exception details', async () => {
    api.retryReport.mockRejectedValueOnce(new Error("EACCES: mkdir '/app/server/uploads/private'"));
    const { container } = renderLibrary();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry PDF · no analysis charge' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/report storage access/i));
    expect(container.textContent).not.toMatch(/EACCES|\/app\/server/);
    expect(api.retryReport).toHaveBeenCalledTimes(1);
    expect(api.retryReport).toHaveBeenCalledWith(1);
  });
});
