import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LeadSelectionModal from '@/components/LeadSelectionModal';
import api from '@/lib/api';
import type { OutreachRecipient } from '../../../shared/outreachCompose';

const actor = vi.hoisted(() => ({ scope: 'synthetic:1' }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => actor.scope }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
const recipient = (id: number, phone: string): OutreachRecipient => ({ id, name: `Contact ${id}`, firstName: 'Contact', lastName: String(id), phone, email: '', company: '', eligible: true, reason: null, recipient: phone });
const one = recipient(1, '919000000001');
const two = recipient(2, '919000000002');
const sources = { campaigns: [{ id: 42, name: 'Spring campaign', historicalCount: 2, uploads: [{ id: 71, fileName: 'Campaign.csv', createdAt: '2026-10-28', count: 4 }] }], crmImports: [{ id: 81, fileName: 'CRM.csv', createdAt: '2026-10-28', count: 4 }] };
const selected = vi.fn();
const closed = vi.fn();
const props = { isOpen: true, onClose: closed, onSelectLeads: selected, threadId: 42 };
beforeEach(() => {
  vi.clearAllMocks(); actor.scope = 'synthetic:1';
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('import-sources')) return sources as never;
    const query = new URL(url, 'https://test.example').searchParams;
    return { recipients: query.get('search') === two.phone || query.get('after') ? [two] : [one], nextCursor: query.get('after') ? null : 1 } as never;
  });
});
afterEach(cleanup);

describe('Campaign outreach recipient selection', () => {
  it('uses the paginated shared composer API, searches phones and preserves only checked recipients across filters', async () => {
    render(<LeadSelectionModal {...props} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${one.name} ${one.phone}` }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search outreach recipients' }), { target: { value: two.phone } });
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${two.name} ${two.phone}` }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Contact source' }), { target: { value: 'crm' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'CRM import' }), { target: { value: '81' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('importId=81'), expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 2 recipients' }));
    expect(selected).toHaveBeenCalledWith([one, two], 'whatsapp');
    expect(closed).toHaveBeenCalledOnce();
    expect(vi.mocked(api.get).mock.calls.every(([url]) => url.startsWith('/api/outreach-conversations/compose/'))).toBe(true);
  });
  it('filters by specific campaign upload, supports historical uploads and current campaign without combining conflicting filters', async () => {
    render(<LeadSelectionModal {...props} />); await screen.findByRole('checkbox', { name: `Select ${one.name} ${one.phone}` });
    fireEvent.change(screen.getByRole('combobox', { name: 'Contact source' }), { target: { value: 'campaign' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Campaign' }), { target: { value: '42' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Campaign upload' }), { target: { value: '71' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('campaignId=42&importId=71'), expect.anything()));
    fireEvent.change(screen.getByRole('combobox', { name: 'Campaign upload' }), { target: { value: 'legacy' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('importSource=campaign_legacy&campaignId=42'), expect.anything()));
    fireEvent.change(screen.getByRole('combobox', { name: 'Contact source' }), { target: { value: 'current' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/outreach-conversations/compose/recipients?channel=whatsapp&threadId=42', expect.anything()));
  });
  it('loads more contacts without losing selection, and keeps selection when deselecting just the shown search results', async () => {
    render(<LeadSelectionModal {...props} />); fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${one.name} ${one.phone}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more contacts' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${two.name} ${two.phone}` }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search outreach recipients' }), { target: { value: two.phone } });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: `Select ${one.name} ${one.phone}` })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deselect shown' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Deselect shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 1 recipient' }));
    expect(selected).toHaveBeenCalledWith([one], 'whatsapp');
  });
  it('shows a retryable loading error and clears selections on close or business change', async () => {
    vi.mocked(api.get).mockImplementationOnce(async () => sources as never).mockRejectedValueOnce(new Error('unavailable'));
    const view = render(<LeadSelectionModal {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Contacts could not be loaded');
    expect(screen.getByRole('button', { name: 'Continue with 0 recipients' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${one.name} ${one.phone}` }));
    actor.scope = 'synthetic:2'; view.rerender(<LeadSelectionModal {...props} />);
    expect(screen.getByRole('button', { name: 'Continue with 0 recipients' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${one.name} ${one.phone}` }));
    view.rerender(<LeadSelectionModal {...props} isOpen={false} />);
    view.rerender(<LeadSelectionModal {...props} />);
    expect(screen.getByRole('button', { name: 'Continue with 0 recipients' })).toBeDisabled();
  });
  it('hands off the chosen channel and does not send or change global follow-up settings', async () => {
    render(<LeadSelectionModal {...props} />); fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${one.name} ${one.phone}` }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Outreach channel' }), { target: { value: 'email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 1 recipient' }));
    expect(selected).toHaveBeenCalledWith([one], 'email');
    expect(vi.mocked(api.get).mock.calls.some(([url]) => url.includes('/settings/') || url.includes('/bulk'))).toBe(false);
  });
});
