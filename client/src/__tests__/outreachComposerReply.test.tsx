import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api, { ApiError } from '@/lib/api';
import { useOutreachPage } from '@/components/outreach/useOutreachPage';
import type { OutreachChannel, OutreachConversation } from '@/components/outreach/types';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, ApiError: class extends Error {
  constructor(message: string, public status?: number, public data?: unknown) { super(message); }
} }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const conversation = (id: number, channel: OutreachChannel = 'instagram') => ({ id, channel }) as OutreachConversation;
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Support AI composer reply', () => {
  it.each(['instagram', 'facebook', 'whatsapp', 'sms', 'email', 'linkedin', 'twitter'] as const)('drafts from the selected %s conversation without sending', async channel => {
    vi.mocked(api.post).mockResolvedValue({ content: 'I do not have a confirmed response time yet.' });
    const { result } = renderHook(() => useOutreachPage({ channel, autoLoad: false }));
    act(() => result.current.setSelectedConversation(conversation(123)));
    await act(() => result.current.handleGenerateComposerReply());
    expect(api.post).toHaveBeenCalledExactlyOnceWith(`/api/outreach-conversations/${channel}/123/draft-reply`, { composerOnly: true });
    expect(result.current.newMessage).toContain('response time');
  });
  it.each(['switch', 'edit', 'channel'] as const)('keeps current text after a mid-request %s', async change => {
    let finish!: (value: unknown) => void;
    vi.mocked(api.post).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({ channel }: { channel: 'instagram' | 'facebook' }) => useOutreachPage({ channel, autoLoad: false }), { initialProps: { channel: 'instagram' as 'instagram' | 'facebook' } });
    act(() => { result.current.setSelectedConversation(conversation(123)); result.current.setNewMessage('My reply'); });
    let pending!: Promise<string | null>;
    act(() => { pending = result.current.handleGenerateComposerReply(); });
    if (change === 'switch') act(() => result.current.setSelectedConversation(conversation(456)));
    if (change === 'edit') act(() => result.current.setNewMessage('Still typing'));
    if (change === 'channel') rerender({ channel: 'facebook' });
    await act(async () => { finish({ content: 'Old AI reply' }); await pending; });
    expect(result.current.newMessage).toBe(change === 'edit' ? 'Still typing' : 'My reply');
  });
  it('deduplicates clicks and preserves text on provider failure', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(api.post).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const { result } = renderHook(() => useOutreachPage({ channel: 'instagram', autoLoad: false }));
    act(() => { result.current.setSelectedConversation(conversation(123)); result.current.setNewMessage('Typed text'); });
    let pending!: Promise<string | null>;
    act(() => { pending = result.current.handleGenerateComposerReply(); void result.current.handleGenerateComposerReply(); });
    await act(async () => { fail(new Error('Provider unavailable')); await pending; });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(result.current.newMessage).toBe('Typed text');
    expect(result.current.generatingDraft).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not draft reply' }));
  });

  it('explains that a conversation’s bound Instagram account must be reconnected before sending', async () => {
    vi.mocked(api.post).mockRejectedValue(new ApiError('Account unavailable', 409, { code: 'CONVERSATION_ACCOUNT_UNAVAILABLE' }));
    const { result } = renderHook(() => useOutreachPage({ channel: 'instagram', autoLoad: false }));
    act(() => {
      result.current.setSelectedConversation(conversation(123));
      result.current.setNewMessage('Hello');
    });

    await act(async () => { expect(await result.current.handleSendMessage()).toBe(false); });

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reconnect Instagram',
      description: expect.stringContaining('reconnect that same account'),
      variant: 'destructive',
    }));
    expect(result.current.newMessage).toBe('Hello');
  });

  it('explains that a conversation’s bound WhatsApp account must be reconnected before sending', async () => {
    vi.mocked(api.post).mockRejectedValue(new ApiError('Provider not ready', 409, { code: 'OUTREACH_PROVIDER_NOT_READY' }));
    const { result } = renderHook(() => useOutreachPage({ channel: 'whatsapp', autoLoad: false }));
    act(() => {
      result.current.setSelectedConversation(conversation(124, 'whatsapp'));
      result.current.setNewMessage('Hello');
    });

    await act(async () => { expect(await result.current.handleSendMessage()).toBe(false); });

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reconnect WhatsApp',
      description: expect.stringContaining('reconnect that same'),
      variant: 'destructive',
    }));
    expect(result.current.newMessage).toBe('Hello');
  });
});
