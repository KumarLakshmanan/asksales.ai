import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '@/hooks/useChat';
import { matchesConversationEventScope } from '@/lib/conversation-event-scope';

const { send, releaseQueuedMessage, apiPost, apiGet, subscribe } = vi.hoisted(() => ({
  send: vi.fn<(message: { messageId: string; [key: string]: unknown }) => 'sent' | 'queued'>(() => 'sent'),
  releaseQueuedMessage: vi.fn(),
  apiPost: vi.fn(),
  apiGet: vi.fn(async () => []),
  subscribe: vi.fn<(type: string, listener: (event: Record<string, unknown>) => void) => () => void>(() => vi.fn()),
}));

vi.mock('@/services/WebSocketService', () => ({
  default: { send, releaseQueuedMessage, subscribe },
}));

vi.mock('@/lib/api', () => ({
  api: { post: apiPost, get: apiGet },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe('useChat', () => {
  let fixtureSession = 0;
  beforeEach(() => {
    // Each independently mounted fixture has its own authenticated attempt scope.
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('user', JSON.stringify({ id: `chat-fixture-${++fixtureSession}` }));
    send.mockClear();
    releaseQueuedMessage.mockClear();
    apiPost.mockReset();
    apiGet.mockClear(); subscribe.mockClear();
  });

  afterEach(() => { vi.useRealTimers(); });

  it('keeps first-message ownership separate between two starting campaign tabs', async () => {
    const first = renderHook(() => useChat('42', vi.fn()));
    const second = renderHook(() => useChat('42', vi.fn()));
    await act(async () => { await first.result.current.handleSendMessage('Campaign A advice'); });
    await act(async () => { await second.result.current.handleSendMessage('Campaign B ICP'); });
    const firstId = first.result.current.pendingNewThreadRequestIdRef.current;
    const secondId = second.result.current.pendingNewThreadRequestIdRef.current;
    expect(firstId).toBe(send.mock.calls[0][0].messageId);
    expect(secondId).toBe(send.mock.calls[1][0].messageId);
    expect(firstId).not.toBe(secondId);
    const receipt = { threadId: 221, ackMessageId: firstId };
    expect(matchesConversationEventScope('message_sent', receipt, null, true, firstId)).toBe(true);
    expect(matchesConversationEventScope('message_sent', receipt, null, true, secondId)).toBe(false);
    expect(second.result.current.messages.map(message => message.content)).toEqual(['Campaign B ICP']);
  });

  it('preserves the selected business and attachments in either transport', async () => {
    send.mockReturnValueOnce('queued');
    apiPost.mockResolvedValueOnce({ threadId: 163 });
    const { result } = renderHook(() => useChat('42', vi.fn()));
    await act(async () => {
      await result.current.handleSendMessage('New campaign', false, [{
        fileId: 7, name: 'brief.txt', mimeType: 'text/plain', size: 12, downloadUrl: '/brief',
      }]);
    });
    const envelope = send.mock.calls[0][0];
    expect(envelope.data).toEqual({ content: 'New campaign', businessProfileId: 42, attachments: [{ fileId: 7 }] });
    expect(apiPost).toHaveBeenCalledWith('/api/chat/langgraph/message', {
      ...(envelope.data as object), idempotencyKey: envelope.messageId,
    });
  });

  it.each(['success', 'failure'] as const)('ignores a late fallback %s after switching campaigns without stopping the new turn', async outcome => {
    vi.useFakeTimers();
    send.mockReturnValueOnce('queued');
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    apiPost.mockImplementationOnce(() => new Promise((res, rej) => { resolve = res; reject = rej; }));
    const { result } = renderHook(() => useChat('', vi.fn()));
    act(() => result.current.setCurrentThreadId(208));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('Campaign A question'); });
    act(() => {
      result.current.setCurrentThreadId(207);
      result.current.setMessages([]);
      result.current.setIsProcessing(false);
      vi.advanceTimersByTime(1000);
    });
    await act(async () => { await result.current.handleSendMessage('Campaign B question'); });
    let returned: unknown;
    await act(async () => {
      if (outcome === 'success') resolve({ threadId: 208, response: { content: 'Campaign A answer' } });
      else reject(new Error('Campaign A failed'));
      returned = await sending;
    });
    expect(returned).toBeUndefined(); // No old draft restoration on a late failure.
    expect(result.current.messages.map(message => message.content)).toEqual(['Campaign B question']);
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.isProcessingRef.current).toBe(true);
    act(() => { vi.advanceTimersByTime(149000); });
    expect(result.current.isProcessing).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.isProcessing).toBe(false); // B's safety timer remains intact.
  });

  it('retains an earlier queued reply in its campaign without stopping a newer turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    send.mockReturnValueOnce('queued');
    let resolve!: (value: unknown) => void;
    apiPost.mockImplementationOnce(() => new Promise(res => { resolve = res; }));
    const { result } = renderHook(() => useChat('', vi.fn()));
    act(() => result.current.setCurrentThreadId(208));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('Old turn'); });
    await act(async () => { await result.current.handleSendMessage('New turn', true); });
    expect(result.current.messages.map(message => message.id)).toHaveLength(2);
    expect(new Set(result.current.messages.map(message => message.id)).size).toBe(2);
    await act(async () => { resolve({ response: { content: 'Old answer' } }); await sending; });
    expect(result.current.messages.map(message => message.content)).toEqual(['Old turn', 'New turn', 'Old answer']);
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.isProcessingRef.current).toBe(true);
  });

  it('reconciles a durable reply after returning to its campaign without taking over a newer turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    send.mockReturnValueOnce('queued');
    let resolve!: (value: unknown) => void;
    apiPost.mockImplementationOnce(() => new Promise(res => { resolve = res; }));
    const { result } = renderHook(() => useChat('', vi.fn()));
    act(() => result.current.setCurrentThreadId(208));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('Old turn'); });
    act(() => { result.current.setCurrentThreadId(207); result.current.setMessages([]); });
    act(() => result.current.setCurrentThreadId(208));
    await act(async () => { await result.current.handleSendMessage('New turn'); });
    await act(async () => { resolve({ response: { content: 'Old answer' } }); await sending; });
    expect(result.current.messages.map(message => message.content)).toEqual(['New turn', 'Old turn', 'Old answer']);
    expect(result.current.currentThreadId).toBe(208);
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.isProcessingRef.current).toBe(true);
  });

  it('does not adopt a newly created campaign after the user navigates elsewhere', async () => {
    send.mockReturnValueOnce('queued');
    let resolve!: (value: unknown) => void;
    apiPost.mockImplementationOnce(() => new Promise(res => { resolve = res; }));
    const loadWidgets = vi.fn();
    const { result } = renderHook(() => useChat('42', loadWidgets));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('New campaign'); });
    act(() => {
      result.current.setCurrentThreadId(207);
      result.current.setMessages([]);
      result.current.pendingNewThreadRef.current = false;
    });
    await act(async () => { resolve({ threadId: 209, response: { content: 'New campaign answer' } }); await sending; });
    expect(result.current.currentThreadId).toBe(207);
    expect(result.current.messages).toEqual([]);
    expect(loadWidgets).not.toHaveBeenCalled();
  });

  it('accepts fallback when realtime has already adopted the newly created campaign', async () => {
    send.mockReturnValueOnce('queued');
    let resolve!: (value: unknown) => void;
    apiPost.mockImplementationOnce(() => new Promise(res => { resolve = res; }));
    const { result } = renderHook(() => useChat('42', vi.fn()));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('New campaign'); });
    act(() => {
      const onResolved = subscribe.mock.calls.find(([type]) => type === 'thread_resolved')![1];
      onResolved({ threadId: 209, requestMessageId: send.mock.calls[0][0].messageId });
      result.current.locallyCreatedThreadRef.current = 209;
      result.current.setCurrentThreadId(209);
    });
    await act(async () => { resolve({ threadId: 209, response: { content: 'New campaign answer' } }); await sending; });
    expect(result.current.messages.map(message => message.content)).toEqual(['New campaign', 'New campaign answer']);
    expect(result.current.isProcessing).toBe(false);
  });

  it('does not navigate or load widgets after the conversation unmounts', async () => {
    vi.useFakeTimers();
    send.mockReturnValueOnce('queued');
    let resolve!: (value: unknown) => void;
    apiPost.mockImplementationOnce(() => new Promise(res => { resolve = res; }));
    const loadWidgets = vi.fn();
    const { result, unmount } = renderHook(() => useChat('42', loadWidgets));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('New campaign'); });
    const route = window.location.pathname;
    unmount();
    await act(async () => { resolve({ threadId: 210, response: { content: 'Late answer' } }); await sending; });
    expect(loadWidgets).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(route);
    // jsdom schedules storage notifications at zero delay. Flush those only;
    // a leaked processing timeout or recovery interval would remain counted.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets prior workflow ownership before each accepted turn, but not a blocked send', async () => {
    const onTurnStart = vi.fn();
    const { result } = renderHook(() => useChat('', vi.fn(), onTurnStart));
    send.mockImplementationOnce(() => {
      expect(onTurnStart).toHaveBeenCalledTimes(1);
      return 'sent';
    });
    await act(async () => { await result.current.handleSendMessage('First turn'); });
    await act(async () => { await result.current.handleSendMessage('Blocked turn'); });
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    act(() => result.current.setIsProcessing(false));
    await act(async () => { await result.current.handleSendMessage('Read-only follow-up'); });
    expect(onTurnStart).toHaveBeenCalledTimes(2);
  });

  it('uses the latest thread id when a previously-rendered send callback runs', async () => {
    const { result } = renderHook(() => useChat('', vi.fn()));
    const sendFromInitialRender = result.current.handleSendMessage;

    act(() => {
      result.current.setCurrentThreadId(168);
    });

    await act(async () => {
      await sendFromInitialRender('first message');
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'send_chat_message',
      messageId: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
      data: {
        content: 'first message',
        threadId: 168,
      },
    }));
  });

  it('falls back to the durable HTTP route when realtime delivery is queued', async () => {
    send.mockReturnValueOnce('queued');
    apiPost.mockResolvedValueOnce({
      message: { id: 500, content: 'recover me' },
      response: {
        role: 'assistant',
        content: 'Recovered response',
        metadata: { responseId: 'response-500' },
      },
    });
    const { result } = renderHook(() => useChat('', vi.fn()));
    act(() => result.current.setCurrentThreadId(172));

    await act(async () => {
      await result.current.handleSendMessage('recover me');
    });

    const sentEnvelope = send.mock.calls[0][0];
    expect(releaseQueuedMessage).toHaveBeenCalledWith(sentEnvelope.messageId);
    expect(apiPost).toHaveBeenCalledWith('/api/chat/langgraph/message', {
      content: 'recover me',
      threadId: 172,
      idempotencyKey: sentEnvelope.messageId,
    });
    expect(result.current.messages.map(message => message.content)).toEqual([
      'recover me',
      'Recovered response',
    ]);
    expect(result.current.isProcessing).toBe(false);
  });

  it('adopts a new thread returned by the durable HTTP fallback', async () => {
    send.mockReturnValueOnce('queued');
    apiPost.mockResolvedValueOnce({
      threadId: 163,
      message: { id: 501, content: 'new campaign' },
      response: { role: 'assistant', content: 'Review the task card.' },
    });
    const loadWidgets = vi.fn();
    const { result } = renderHook(() => useChat('', loadWidgets));

    await act(async () => {
      await result.current.handleSendMessage('new campaign');
    });

    expect(result.current.currentThreadId).toBe(163);
    expect(loadWidgets).toHaveBeenCalledWith(163);
    expect(window.location.pathname).toBe('/dashboard/conversations/163');
  });

  it.each([true, false])('reconciles fallback after WS already delivered the same receipt (HTTP messageId=%s)', async hasMessageId => {
    send.mockReturnValueOnce('queued');
    let resolveFallback!: (value: unknown) => void;
    apiPost.mockImplementationOnce(() => new Promise(resolve => { resolveFallback = resolve; }));
    const { result } = renderHook(() => useChat('', vi.fn()));
    act(() => result.current.setCurrentThreadId(184));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('Prepare the outreach review.'); });
    act(() => result.current.setMessages(previous => [...previous, {
      id: '3267', role: 'user', content: 'Prepare the outreach review.', timestamp: 1,
    }, {
      id: '3268', role: 'assistant', agentType: 'outreach', content: 'Review the settings in the card.', timestamp: 2,
      metadata: { responseId: 'outreach-1788808999472', persisted: true },
    }]));
    await act(async () => {
      resolveFallback({ threadId: 184, message: { id: 3267, content: 'Prepare the outreach review.' }, response: {
        ...(hasMessageId ? { messageId: 3268 } : {}), role: 'assistant', agentType: 'outreach',
        content: 'Review the settings in the card.', metadata: { responseId: 'outreach-1788808999472' },
      } });
      await sending;
    });
    expect(result.current.messages.map(message => message.id)).toEqual(['3267', '3268']);
  });

  it('replaces pending chunks in place rather than appending an HTTP final after them', async () => {
    send.mockReturnValueOnce('queued');
    let resolveFallback!: (value: unknown) => void;
    apiPost.mockImplementationOnce(() => new Promise(resolve => { resolveFallback = resolve; }));
    const { result } = renderHook(() => useChat('', vi.fn()));
    act(() => result.current.setCurrentThreadId(184));
    let sending!: ReturnType<typeof result.current.handleSendMessage>;
    act(() => { sending = result.current.handleSendMessage('Prepare review.'); });
    act(() => result.current.setMessages(previous => [...previous, {
      id: 'streaming-outreach-1', role: 'assistant', content: 'Review the', timestamp: 2,
      metadata: { responseId: 'outreach-1', streaming: true },
    }]));
    await act(async () => {
      resolveFallback({ message: { id: 3267 }, response: {
        messageId: 3268, role: 'assistant', content: 'Review the settings.', metadata: { responseId: 'outreach-1' },
      } });
      await sending;
    });
    expect(result.current.messages.map(message => message.id)).toEqual(['3267', '3268']);
    expect(result.current.messages[1].content).toBe('Review the settings.');
  });

  it('keeps attempted text and attachments on an unconfirmed failure without resending', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    send.mockReturnValueOnce('queued');
    apiPost.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useChat('', vi.fn()));
    act(() => result.current.setCurrentThreadId(184));
    let outcome: unknown;
    await act(async () => { outcome = await result.current.handleSendMessage('Do not lose this draft.'); });
    expect(outcome).toEqual({ delivery: 'unconfirmed' });
    expect(result.current.messages[0]).toMatchObject({
      role: 'user', content: 'Do not lose this draft.', metadata: { deliveryUnconfirmed: true, pendingDelivery: false },
    });
    expect(result.current.messages[1].content).toContain('Delivery is not confirmed');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
