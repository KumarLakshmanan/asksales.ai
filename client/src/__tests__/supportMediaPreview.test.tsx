import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportMediaPreview } from '@/components/support/SupportMediaPreview';
import { supportMediaScanNotice } from '@/lib/supportMediaScanNotice';

vi.mock('@/lib/api', () => ({ buildApiUrl: (url: string) => url }));
const fetchMock = vi.fn();
const createObjectURL = vi.fn(() => 'blob:qa-image');
const revokeObjectURL = vi.fn();
describe('support media previews and publication holds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['qa']) });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('renders a fetched image and releases its blob URL on unmount', async () => {
    const view = render(<SupportMediaPreview assetId={1} alt="QA color chart" />);
    expect(await screen.findByAltText('QA color chart')).toHaveAttribute('src', 'blob:qa-image');
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qa-image');
  });
  it('shows a recoverable error instead of an indefinite placeholder', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    render(<SupportMediaPreview assetId={1} alt="QA color chart" />);
    expect(await screen.findByText(/Preview unavailable/)).toBeVisible();
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['recovered']) });
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    expect(await screen.findByAltText('QA color chart')).toHaveAttribute('src', 'blob:qa-image');
  });
  it('does not allocate an orphan blob after unmount', async () => {
    let resolveBlob!: (value: Blob) => void;
    fetchMock.mockResolvedValue({ ok: true, blob: () => new Promise<Blob>((resolve) => { resolveBlob = resolve; }) });
    const view = render(<SupportMediaPreview assetId={1} alt="QA color chart" />);
    await waitFor(() => expect(resolveBlob).toBeDefined());
    view.unmount();
    await act(async () => { resolveBlob(new Blob(['qa'])); });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it('explains unavailable scanners without exposing raw provider errors', () => {
    expect(supportMediaScanNotice('ready_for_review', { error: 'private-provider-value' })).toContain('vision and moderation configuration');
    expect(supportMediaScanNotice('ready_for_review', { error: 'private-provider-value' })).not.toContain('private-provider-value');
    expect(supportMediaScanNotice('quarantined')).toContain('does not override');
    expect(supportMediaScanNotice('failed')).toContain('Retry scans');
    expect(supportMediaScanNotice('published')).toBeNull();
  });
});
