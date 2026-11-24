import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupportDocumentsPage from '@/app/dashboard/(main)/knowledge-base/documents/page';
import { SupportDocumentStepEditor } from '@/components/support/SupportDocumentStepEditor';
import api from '@/lib/api';
import type { SupportLibraryDocument } from '@/lib/support-documents';
vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), postForm: vi.fn() }, buildApiUrl: (path: string) => path }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const document: SupportLibraryDocument = { id: 41, title: 'Corporate daytime brochure', description: 'For one-day office offsites',
  service: 'corporate', businessProfileId: null, storageFileId: 250, checksum: 'a'.repeat(64), status: 'draft',
  revision: 1, approvalId: null, updatedAt: new Date().toISOString(), expiresAt: null };
const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockImplementation(async path => path.includes('business-profiles') ? [] as never : [document] as never); });
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});
describe('Documents library', () => {
  it('shows human-readable topics and draft status, with approval disabled until review', async () => {
    render(<SupportDocumentsPage />);
    expect(await screen.findByRole('article', { name: document.title })).toHaveTextContent('Draft');
    fireEvent.click(screen.getByRole('button', { name: 'Review and approve' }));
    expect(screen.getByRole('button', { name: 'Approve for sharing' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Download the current PDF before approving it.');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Approval note'), { target: { value: 'Approved current file' } });
    expect(screen.getByRole('button', { name: 'Approve for sharing' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Connect to playbooks' })).not.toBeInTheDocument();
    expect(screen.getByText(/No playbook linking needed/)).toBeInTheDocument();
  });
  it('updates a draft through the library API with a revision guard', async () => {
    render(<SupportDocumentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated brochure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/settings/support-documents/41',expect.objectContaining({ title: 'Updated brochure', revision: 1, storageFileId: 250 })));
    expect(api.postForm).not.toHaveBeenCalled();
  });
  it('publishes only after the owner downloads and certifies the exact PDF', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['reviewed PDF']) });
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:reviewed-pdf') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.mocked(api.post).mockResolvedValue({} as never);

    render(<SupportDocumentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review and approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF to review' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/support-documents/41/content',
      expect.objectContaining({ credentials: 'include' })));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Approval note'), { target: { value: 'Reviewed the current PDF' } });
    expect(screen.getByRole('button', { name: 'Approve for sharing' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve for sharing' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/settings/support-documents/41/publish', {
      revision: 1, checksum: document.checksum, certified: true, reason: 'Reviewed the current PDF', expiresAt: null,
    }));
  });
  it('reports load failures without displaying an empty-library success state', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Service unavailable'));
    render(<SupportDocumentsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.queryByText('Give your agents the right document')).not.toBeInTheDocument();
  });
  it('does not withdraw until the owner provides a reason', async () => {
    vi.mocked(api.get).mockImplementation(async path => path.includes('business-profiles') ? [] as never : [{ ...document, status: 'published' }] as never);
    render(<SupportDocumentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    expect(screen.getByRole('button', { name: 'Withdraw document' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Old package prices' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw document' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/settings/support-documents/41/withdraw', { revision: 1, reason: 'Old package prices' }));
  });
});
describe('automatic playbook document search', () => {
  it('configures a search topic without requiring a file selection or library fetch', () => {
    const onChange = vi.fn();
    render(<SupportDocumentStepEditor args={{ service: { source: 'constant', value: 'corporate' } }} onChange={onChange} readOnly={false} />);
    expect(screen.queryByLabelText('Document to share')).not.toBeInTheDocument();
    expect(screen.getByText(/No document linking is needed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Document topic'), { target: { value: 'spa' } });
    expect(onChange).toHaveBeenCalledWith({ service: { source: 'constant', value: 'spa' } });
    expect(api.get).not.toHaveBeenCalled();
  });
  it('shows automatic discovery for a legacy file pin and removes it when edited', () => {
    const onChange = vi.fn();
    render(<SupportDocumentStepEditor args={{ service: { value: 'corporate' }, documentId: { value: 99 } }} onChange={onChange} readOnly={false} />);
    expect(screen.queryByLabelText('Document to share')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Document topic'), { target: { value: 'stay' } });
    expect(onChange).toHaveBeenCalledWith({ service: { source: 'constant', value: 'stay' } });
  });
  it('does not fetch owner-only documents in read-only member mode', () => {
    render(<SupportDocumentStepEditor args={{}} onChange={vi.fn()} readOnly />);
    expect(api.get).not.toHaveBeenCalled(); expect(screen.getByLabelText('Document topic')).toBeDisabled();
  });
});
