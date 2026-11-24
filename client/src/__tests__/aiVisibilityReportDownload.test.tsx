import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AiVisibilityProject } from '@/lib/ai-visibility';
import { ReportsView } from '@/components/ai-visibility/ReportsView';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  api: {
    reports: vi.fn(),
    reportShares: vi.fn(),
    reportDeliveries: vi.fn(),
    listWorkspaces: vi.fn(),
    retryReport: vi.fn(),
    reportUrl: vi.fn(),
    reportCsvUrl: vi.fn(),
    reportEvidenceUrl: vi.fn(),
  },
}));
vi.mock('@/lib/ai-visibility', () => ({ aiVisibilityApi: mocks.api }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
const clients: QueryClient[] = [];
const pdf = () =>
  new Response('%PDF-1.7\nSynthetic report', { headers: { 'Content-Type': 'application/pdf' } });
const project = {
  id: 7,
  workspaceId: 1,
  name: 'Fixture brand',
  domain: 'https://brand.example.test',
  businessProfileId: 2,
} as AiVisibilityProject;
const renderReports = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ReportsView project={project} />
    </QueryClientProvider>,
  );
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'synthetic-token');
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  sessionStorage.setItem('active-business-profile:4101', '4102');
  mocks.api.reports.mockResolvedValue({
    reports: [
      {
        auditId: 29,
        status: 'completed',
        createdAt: '2026-10-23T12:00:00Z',
        completedAt: '2026-10-23T12:01:00Z',
        sizeBytes: 1024,
      },
    ],
  });
  mocks.api.reportShares.mockResolvedValue({ shares: [] });
  mocks.api.reportDeliveries.mockResolvedValue({ deliveries: [] });
  mocks.api.listWorkspaces.mockResolvedValue({ workspaces: [] });
  mocks.api.reportUrl.mockReturnValue('/api/ai-visibility/audits/29/report');
  mocks.api.reportCsvUrl.mockReturnValue('/fixture.csv');
  mocks.api.reportEvidenceUrl.mockReturnValue('/fixture.json');
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:synthetic-report');
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI Visibility report download boundaries', () => {
  it.each([
    ['HTML success', 'text/html', '<html>synthetic login</html>'],
    ['mislabeled HTML', 'application/pdf', '<html>synthetic error</html>'],
    ['missing MIME', null, '%PDF-1.7\nSynthetic report'],
  ])(
    'refuses %s for a PDF download without exposing a new blob URL',
    async (_label, mime, body) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(pdf())
        .mockResolvedValueOnce(
          new Response(body, { headers: mime ? { 'Content-Type': mime } : {} }),
        );
      vi.stubGlobal('fetch', fetchMock);
      renderReports();
      await screen.findByTitle('PDF preview for analysis 29');
      await userEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
      await waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Could not download PDF', variant: 'destructive' }),
        ),
      );
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(mocks.api.retryReport).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      'Download PDF',
      'pdf',
      '/api/ai-visibility/audits/29/report',
      '%PDF-1.7\nSynthetic report',
      'application/pdf',
    ],
    ['CSV', 'csv', '/fixture.csv', 'column\nsynthetic value', 'text/csv'],
    ['Complete evidence (JSON)', 'json', '/fixture.json', '{"fixture":true}', 'application/json'],
  ])(
    'preserves the separate %s export with authenticated bytes',
    async (label, extension, path, bytes, mime) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(pdf())
        .mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': mime } }));
      vi.stubGlobal('fetch', fetchMock);
      renderReports();
      await screen.findByTitle('PDF preview for analysis 29');
      await userEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenLastCalledWith(
        path,
        expect.objectContaining({
          credentials: 'include',
          headers: expect.objectContaining({
            Authorization: 'Bearer synthetic-token',
            'X-Business-Profile-Id': '4102',
          }),
        }),
      );
      const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
      expect(await blob.text()).toBe(bytes);
      const anchor = vi.mocked(HTMLAnchorElement.prototype.click).mock
        .instances[0] as HTMLAnchorElement;
      expect(anchor.download).toBe(`ai-visibility-audit-29.${extension}`);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-report');
      expect(mocks.api.retryReport).not.toHaveBeenCalled();
    },
  );
});
