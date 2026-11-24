import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SearchSettingsTab from '@/components/tabs/LeadsInputsTab';
import { api } from '@/lib/api';
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const props = { icpId: '1', platforms: ['instagram'], icpData: {} };
describe('saved lead search-input loading', () => {
  beforeEach(() => { vi.mocked(api.get).mockReset(); });
  it('removes the side-panel approval when the durable review is cancelled or absent', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => (url.includes('sub-workflows') ? {} : { hasExistingInputs: true, inputs: [{ platform: 'linkedin', inputs: { query: 'hotel' } }] }) as never);
    const approve = vi.fn();
    const { rerender } = render(<SearchSettingsTab {...props} threadId={1} approvalAvailable onApproval={approve} />);
    expect(await screen.findByRole('button', { name: 'Approve & Run Search' })).toBeInTheDocument();
    rerender(<SearchSettingsTab {...props} threadId={1} approvalAvailable={false} onApproval={approve} />);
    expect(screen.queryByRole('button', { name: 'Approve & Run Search' })).not.toBeInTheDocument();
    expect(screen.getByText(/no active approval/)).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
  });
  it('shows a recoverable error, not an empty result, and retries read-only', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('sub-workflows')) return {} as never;
      throw new Error('Unavailable');
    });
    render(<SearchSettingsTab {...props} threadId={1} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('loading error');
    expect(screen.queryByText('No reviewed search inputs yet')).not.toBeInTheDocument();
    vi.mocked(api.get).mockResolvedValue({ hasExistingInputs: false } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading search inputs' }));
    expect(await screen.findByText('No reviewed search inputs yet')).toBeInTheDocument();
  });
  it('does not apply a late response from the previous campaign', async () => {
    let finishOld: (data: unknown) => void = () => {};
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.endsWith('/1')) return new Promise(resolve => { finishOld = resolve; }) as never;
      return Promise.resolve(url.includes('sub-workflows') ? {} : { hasExistingInputs: false }) as never;
    });
    const { rerender } = render(<SearchSettingsTab {...props} threadId={1} />);
    expect(screen.getByText('Loading saved search parameters...')).toBeInTheDocument();
    expect(screen.queryByText('Generating search parameters...')).not.toBeInTheDocument();
    rerender(<SearchSettingsTab {...props} threadId={2} />);
    await screen.findByText('No reviewed search inputs yet');
    await act(async () => finishOld({ hasExistingInputs: true, inputs: [{ platform: 'old-campaign-provider', inputs: { query: 'wrong-campaign' } }] }));
    expect(screen.queryByText(/old-campaign-provider/)).not.toBeInTheDocument();
    expect(screen.getByText('No reviewed search inputs yet')).toBeInTheDocument();
  });

  it('distinguishes provider fetch limits from the global saved-lead cap', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => (url.includes('sub-workflows')
      ? {}
      : {
          hasExistingInputs: true,
          inputs: [{
            platform: 'twitter_post_author_profiles',
            inputs: { maxResults: 15, searchTerms: ['revenue operations'] },
            requestedLeadTotal: 5,
          }],
        }) as never);

    render(<SearchSettingsTab {...props} threadId={3} />);

    expect(await screen.findByText('Saved lead cap: 5 leads')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'Provider request limit: 15. The global cap saves up to 5 leads across selected providers; provider usage may be higher.',
    );
  });
});
