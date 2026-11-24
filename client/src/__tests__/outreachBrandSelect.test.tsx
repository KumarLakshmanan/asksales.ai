import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initialOutreachBrandId, OutreachBrandSelect } from '@/components/outreach/OutreachBrandSelect';
import { EmailDesignPicker } from '@/components/outreach/EmailDesignPicker';
import { prepareBulkLaunch } from '@/components/outreach/bulk-launch';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: api }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => '9:7' }));

const toolkits = [
  { id: 1, name: 'Aimplify', isDefault: true, isActive: true },
  { id: 2, name: 'Todle', isDefault: false, isActive: true },
  { id: 3, name: 'Retired', isDefault: false, isActive: false },
];
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/api/content/brand-toolkits') return toolkits;
    if (url === '/api/chat/threads/40') return { metadata: { selectedBrandToolkitId: 2 } };
    if (url.startsWith('/api/settings/outreach/email-designs')) return { canManage: true, brand: { companyName: 'X', logoUrl: null, primaryColor: '#000' }, preferences: { outreach: 'classic', assistant: 'classic', revision: 'r' } };
    return {};
  });
});
afterEach(cleanup);

describe('outreach brand selection', () => {
  it('starts from the chat thread brand, then the default, and ignores inactive brands', () => {
    expect(initialOutreachBrandId(toolkits, 2)).toBe(2);
    expect(initialOutreachBrandId(toolkits, undefined)).toBe(1);
    expect(initialOutreachBrandId(toolkits, 3)).toBe(1);
    expect(initialOutreachBrandId([], 2)).toBeUndefined();
  });

  it('shows which brand this outreach and its follow-ups use', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<OutreachBrandSelect value={undefined} onChange={onChange} threadId="40" />, { wrapper });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(2));
    rerender(<OutreachBrandSelect value={2} onChange={onChange} threadId="40" />);
    expect(await screen.findByText(/This outreach and its follow-ups use Todle/)).toBeTruthy();
  });

  it('sends the chosen brand with the launch and previews the design with it', async () => {
    const launch = prepareBulkLaunch('email', [{ leadId: 1 }], null, undefined, { creationVersion: 1, brandToolkitId: 2 });
    expect(launch.payload.brandToolkitId).toBe(2);
    render(<EmailDesignPicker onChange={vi.fn()} brandToolkitId={2} />, { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/settings/outreach/email-designs?brandToolkitId=2'));
  });
});
