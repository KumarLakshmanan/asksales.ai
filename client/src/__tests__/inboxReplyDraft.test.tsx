import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { useInboxConversation, type InboxDraft } from '@/components/outreach/inbox/useInboxConversation';
import type { InboxItem } from '@/lib/outreach-inbox';
import type { OutreachMessage } from '@/components/outreach/types';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const item = { key: 'conversation:7', kind: 'conversation', id: 7, channel: 'email', leadId: 1, subject: 'Proposal', recipient: 'test@example.test', reply: { canReply: true, senderId: 3, providerAccountId: 'original-account' } } as InboxItem;
const messages = [{ id: 1, direction: 'inbound', content: 'Hello', createdAt: '2026-10-02T00:00:00Z' }];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url) => url.includes('/inbox/') ? { item } as never : { conversation: {}, messages } as never);
  vi.mocked(api.post).mockResolvedValue({ success: true } as never);
});
afterEach(cleanup);

async function mount() {
  const drafts = new Map<string, InboxDraft>();
  const onRead = vi.fn();
  const onChanged = vi.fn();
  const hook = renderHook(() => useInboxConversation(item, 0, drafts, onRead, onChanged));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { ...hook, drafts };
}

describe('Inbox reply content', () => {
  it('retains a stale-gate rejected draft and blocks repeated send attempts', async () => {
    const { result } = await mount();
    act(() => result.current.setDraft({ content: 'Keep this reply', htmlContent: '<p>Keep this reply</p>' }));
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError('Assistant required.', 409, { code: 'ASSISTANT_SETUP_REQUIRED', error: 'Assistant required.', setupUrl: '/dashboard/settings/outreach' }));
    await act(async () => { expect(await result.current.send()).toBe(false); });
    expect(result.current.item.reply.canReply).toBe(false);
    expect(result.current.item.reply.assistant?.setupUrl).toBe('/dashboard/settings/outreach');
    expect(result.current.draft.content).toBe('Keep this reply');
    expect(result.current.draft.htmlContent).toBe('<p>Keep this reply</p>');
    await act(async () => { expect(await result.current.send()).toBe(false); });
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('retains template provenance on retry and detaches it when reviewed wording changes', async () => {
    const { result } = await mount();
    act(() => result.current.setDraft({ content: 'Reviewed template', subject: 'Reviewed', sourceTemplateId: 17, sourceTemplateVersion: 4 }));
    vi.mocked(api.post).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { expect(await result.current.send()).toBe(false); });
    expect(result.current.draft.sourceTemplateId).toBe(17);
    expect(api.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sourceTemplateId: 17, sourceTemplateVersion: 4 }));
    act(() => result.current.setDraft({ content: 'Manually edited' }));
    expect(result.current.draft.sourceTemplateId).toBeUndefined();
    await act(async () => { expect(await result.current.send()).toBe(true); });
    expect(vi.mocked(api.post).mock.calls[1][1]).not.toHaveProperty('sourceTemplateId');
  });
  it('sends formatted email plus its text alternative and clears both only after success', async () => {
    const { result, drafts } = await mount();
    act(() => result.current.setDraft({ content: 'Hello\ncustomer', htmlContent: '<p><b>Hello</b></p><p>customer</p>' }));
    await act(async () => { expect(await result.current.send()).toBe(true); });
    expect(api.post).toHaveBeenCalledWith('/api/outreach-conversations/email/7/messages', expect.objectContaining({ content: 'Hello\ncustomer', htmlContent: '<p><b>Hello</b></p><p>customer</p>', senderId: 3, expectedProviderAccountId: 'original-account' }));
    expect(drafts.get(item.key)).toMatchObject({ content: '', htmlContent: '' });
  });

  it('keeps rich text after a failed send and reuses the same idempotency key for a retry', async () => {
    const { result } = await mount();
    act(() => result.current.setDraft({ content: 'Hello', htmlContent: '<p><i>Hello</i></p>' }));
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Temporarily unavailable'));
    await act(async () => { expect(await result.current.send()).toBe(false); });
    expect(result.current.draft.htmlContent).toContain('<i>Hello</i>');
    await act(async () => { expect(await result.current.send()).toBe(true); });
    expect(vi.mocked(api.post).mock.calls[0][1]).toEqual(vi.mocked(api.post).mock.calls[1][1]);
  });

  it('sends the selected existing draft HTML instead of another composer draft', async () => {
    const { result } = await mount();
    act(() => result.current.setDraft({ content: 'Unrelated draft', htmlContent: '<p>Unrelated draft</p>' }));
    const draft = { id: 12, content: 'Reviewed draft', htmlContent: '<p><b>Reviewed draft</b></p>', subject: 'Reviewed subject' } as OutreachMessage;
    await act(async () => { await result.current.send({}, draft); });
    expect(api.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ content: 'Reviewed draft', htmlContent: draft.htmlContent, subject: 'Reviewed subject', existingDraftMessageId: 12 }));
    expect(result.current.draft.content).toBe('Unrelated draft');
  });
});
