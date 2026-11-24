import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { mergeConversationHistory } from '@/lib/conversation-history-reconciliation';

const source = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx'), 'utf8');
const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handlerNode: ts.FunctionDeclaration | undefined;
let icpLoaderNode: ts.VariableDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleThreadSelect') handlerNode = node;
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'fetchICPByThread') icpLoaderNode = node;
  ts.forEachChild(node, visit);
}
visit(parsed);
if (!handlerNode) throw new Error('Expected the actual page thread loader');
const handlerSource = ts.transpileModule(handlerNode.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
if (!icpLoaderNode) throw new Error('Expected the actual campaign ICP loader');
const icpLoaderSource = ts.transpileModule(`const ${icpLoaderNode.getText(parsed)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// Execute the page's actual async handler with state/router/API boundaries
// mocked. This avoids importing every unrelated dashboard tab and its effects.
function harness(currentThread: number | null = null) {
  const values: Record<string, unknown> = { messages: [{ id: 'saved-history' }], currentThreadId: currentThread };
  const context: Record<string, any> = { ApiError };
  context.messages = values.messages;
  context.streamAccumulatorsRef = { current: new Map() };
  context.mergeConversationHistory = mergeConversationHistory;
  for (const name of ['threadLoadThreadIdRef', 'threadLoadAbortRef', 'olderMessagesAbortRef',
    'locallyCreatedThreadRef', 'lastDurableCursorRef', 'workflowRunStatusRef']) context[name] = { current: null };
  context.threadLoadGenerationRef = { current: 0 };
  context.currentThreadIdRef = { current: currentThread };
  context.pendingNewThreadRef = { current: false };
  context.conversationEventLedgerRef = { current: {} };
  context.workflowRunSeenRef = { current: false };
  context.lastSeenTsRef = { current: 0 };
  for (const name of ['CurrentThreadId', 'ThreadLoadError', 'IsProcessing', 'ActiveAgent', 'IsLoadingMessages',
    'Messages', 'SeenMessageIds', 'ToolLogs', 'TabData', 'ShowApprovalModal', 'ApprovalData', 'ApprovingTool',
    'ChatName', 'SelectedBusinessId', 'SelectedBusinessName', 'SelectedBusinessDetails', 'OlderMessageCursor',
    'HasOlderMessages', 'ShowAgentSuggestions', 'Icp', 'IcpId', 'IcpContextStatus', 'FitScore',
    'UserIntent', 'RecommendedAgentScores', 'AgentDescriptions', 'Tabs', 'ActiveTab']) {
    context[`set${name}`] = vi.fn((value: unknown) => {
      const key = name[0].toLowerCase() + name.slice(1);
      values[key] = typeof value === 'function' ? value(values[key]) : value;
    });
  }
  for (const name of ['resetWidgets', 'clearProcessingTimeout', 'loadWidgets', 'handleSendMessage', 'toast']) context[name] = vi.fn();
  context.createConversationEventLedger = vi.fn(() => ({}));
  context.readDurableApproval = vi.fn(() => null);
  context.fetchICPByThread = vi.fn(async () => undefined);
  context.router = { push: vi.fn(), replace: vi.fn() };
  context.api = { get: vi.fn(async (endpoint: string): Promise<unknown> => endpoint.endsWith('/messages')
    ? { messages: [{ id: 7, role: 'assistant', content: 'Saved campaign message', createdAt: '2026-09-08T00:00:00Z' }] }
    : { id: Number(endpoint.split('/').at(-1)), title: 'Saved campaign' }) };
  const handler = new Function(...Object.keys(context), `${handlerSource}\nreturn handleThreadSelect;`)(...Object.values(context)) as (id: number) => Promise<void>;
  return { context, values, handler };
}

function useActualIcpLoader(context: Record<string, any>) {
  const { fetchICPByThread, ...dependencies } = context;
  fetchICPByThread.mockImplementation(new Function(...Object.keys(dependencies), `${icpLoaderSource}\nreturn fetchICPByThread;`)(...Object.values(dependencies)));
}

describe('conversation thread load recovery', () => {
  beforeEach(() => sessionStorage.clear());

  it('keeps campaign context loading after messages finish until the selected ICP resolves', async () => {
    const { context, values, handler } = harness(215);
    useActualIcpLoader(context);
    let finish!: (response: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    context.api.get.mockImplementation(async (url: string) => url.includes('/icp/thread/') ? pending
      : url.endsWith('/messages') ? { messages: [] } : { id: 215, title: 'Saved campaign' });
    const loading = handler(215);
    await vi.waitFor(() => expect(context.fetchICPByThread).toHaveBeenCalled());
    expect(values.isLoadingMessages).toBe(false);
    expect(values.icpContextStatus).toBe('loading');
    finish({ id: 71, campaignName: 'Approved selected ICP' });
    await loading;
    expect(values.icpContextStatus).toBe('ready');
    expect(values.icpId).toBe(71);
  });

  it('decides an ICP is missing only after a successful empty context response', async () => {
    const { context, values, handler } = harness(215);
    useActualIcpLoader(context);
    context.api.get.mockImplementation(async (url: string) => url.includes('/icp/thread/') ? { id: null }
      : url.endsWith('/messages') ? { messages: [] } : { id: 215, title: 'Saved campaign' });
    await handler(215);
    expect(values.icpContextStatus).toBe('ready');
    expect(values.icpId).toBeNull();
  });

  it('exposes a failed ICP read as recoverable context failure and supports a same-campaign retry', async () => {
    const { context, values, handler } = harness(215);
    useActualIcpLoader(context);
    let fail = true;
    context.api.get.mockImplementation(async (url: string) => {
      if (url.includes('/icp/thread/')) {
        if (fail) throw new ApiError('Temporary outage', 503);
        return { id: 71 };
      }
      return url.endsWith('/messages') ? { messages: [] } : { id: 215, title: 'Saved campaign' };
    });
    await handler(215);
    expect(values.icpContextStatus).toBe('error');
    expect(values.currentThreadId).toBe(215);
    expect(context.router.replace).not.toHaveBeenCalled();
    fail = false;
    await handler(215);
    expect(values.icpContextStatus).toBe('ready');
    expect(values.icpId).toBe(71);
  });

  it('merges a realtime receipt delivered during the actual message read', async () => {
    const { context, values, handler } = harness(184);
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    context.api.get.mockResolvedValueOnce({ id: 184, title: 'Saved campaign' }).mockReturnValueOnce(pending);
    const loading = handler(184);
    await vi.waitFor(() => expect(context.api.get).toHaveBeenCalledTimes(2));
    const live = { id: '501', role: 'assistant', content: 'Live during read', timestamp: 1000 };
    context.setMessages([live]);
    release({ messages: [] });
    await loading;
    expect(values.messages).toEqual(expect.arrayContaining([expect.objectContaining(live)]));
  });

  it('does not apply a queued history updater after the active thread changes', async () => {
    const { context, handler } = harness(184);
    let updater!: (current: unknown[]) => unknown[];
    context.setMessages.mockImplementation((value: unknown) => { if (typeof value === 'function') updater = value as typeof updater; });
    await handler(184);
    expect(updater).toBeDefined();
    context.currentThreadIdRef.current = 99;
    const other = [{ id: 'other-thread' }];
    expect(updater(other)).toBe(other);
  });

  it('clears prior-run ownership when starting a new chat turn', () => {
    const body = source.match(/const beginChatTurn = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1];
    expect(body).toBeDefined();
    const seen = { current: true }, status = { current: 'awaiting_approval' as string | null };
    new Function('workflowRunSeenRef', 'workflowRunStatusRef', body!)(seen, status);
    expect(seen.current).toBe(false);
    expect(status.current).toBeNull();
    expect(source).toContain('useChat(selectedBusinessProfileId, loadWidgets, beginChatTurn)');
  });

  it('tracks native thread-adoption URL changes so New campaign resets an adopted thread', () => {
    expect(source).toContain('const pathname = usePathname();');
    expect(source).not.toContain('const params = useParams();');
    expect(source).toContain('}, [threadIdFromUrl, rawThreadId]);');
    const declaration = source.match(/const rawThreadId = (.+);/);
    expect(declaration).not.toBeNull();
    const readId = new Function('pathname', `return ${declaration![1]};`);
    expect(readId('/dashboard/conversations')).toBeUndefined();
    expect(readId('/dashboard/conversations/187')).toBe('187');
    expect(readId('/dashboard/conversations')).toBeUndefined();
  });

  it.each([0, 500, 502, 503, 504, 429])('keeps requested campaign identity after API status %s', async status => {
    const { context, values, handler } = harness();
    context.api.get.mockRejectedValueOnce(new ApiError('Temporarily unavailable', status));
    await handler(184);
    expect(context.currentThreadIdRef.current).toBe(184);
    expect(values.currentThreadId).toBe(184);
    expect(context.router.push).not.toHaveBeenCalled();
    expect(context.router.replace).not.toHaveBeenCalled();
    expect(values.threadLoadError).toEqual({ threadId: 184, message: 'Temporarily unavailable' });
    expect(values.isLoadingMessages).toBe(false);
    expect(context.threadLoadThreadIdRef.current).toBeNull();
    expect(context.threadLoadAbortRef.current).toBeNull();
  });

  it('handles an unwrapped network failure without discarding the same-thread history', async () => {
    const { context, values, handler } = harness(184);
    context.api.get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await handler(184);
    expect(values.messages).toEqual([{ id: 'saved-history' }]);
    expect(context.resetWidgets).not.toHaveBeenCalled();
    expect(context.router.replace).not.toHaveBeenCalled();
    expect(values.threadLoadError).toEqual({ threadId: 184, message: 'Failed to fetch' });
  });

  it('does not reset known active workflow state during a same-thread retry failure', async () => {
    const { context, values, handler } = harness(184);
    context.workflowRunSeenRef.current = true;
    context.workflowRunStatusRef.current = 'running';
    values.isProcessing = true;
    context.api.get.mockRejectedValueOnce(new ApiError('Offline', 503));
    await handler(184);
    expect(context.workflowRunSeenRef.current).toBe(true);
    expect(context.workflowRunStatusRef.current).toBe('running');
    expect(values.isProcessing).toBe(true);
    expect(context.clearProcessingTimeout).not.toHaveBeenCalled();
  });

  it('retries the same ID successfully rather than being blocked by a settled request', async () => {
    const { context, values, handler } = harness();
    context.api.get.mockRejectedValueOnce(new ApiError('Offline', 503));
    await handler(184);
    await handler(184);
    expect(context.api.get.mock.calls.map(([url]: [string]) => url)).toEqual([
      '/api/chat/threads/184', '/api/chat/threads/184', '/api/chat/threads/184/messages',
    ]);
    expect(values.threadLoadError).toBeNull();
    expect(values.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Saved campaign message' })]));
    expect(context.loadWidgets).toHaveBeenCalledWith(184);
    expect(context.router.replace).not.toHaveBeenCalled();
    expect(context.router.push).not.toHaveBeenCalled();
  });

  it('restores URL-selected campaigns without issuing a duplicate navigation', async () => {
    const { context, values, handler } = harness(210);
    await handler(205);
    expect(values.currentThreadId).toBe(205);
    expect(context.resetWidgets).toHaveBeenLastCalledWith(205);
    expect(values.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Saved campaign message' })]));
    await handler(210);
    expect(values.currentThreadId).toBe(210);
    expect(context.resetWidgets).toHaveBeenLastCalledWith(210);
    expect(context.router.push).not.toHaveBeenCalled();
    expect(context.router.replace).not.toHaveBeenCalled();
  });

  it('retains campaign context when metadata loaded but message retrieval fails', async () => {
    const { context, values, handler } = harness(184);
    context.api.get.mockResolvedValueOnce({ id: 184, title: 'Reviewed campaign' })
      .mockRejectedValueOnce(new ApiError('Messages unavailable', 502));
    await handler(184);
    expect(values.chatName).toBe('Reviewed campaign');
    expect(values.messages).toEqual([{ id: 'saved-history' }]);
    expect(context.currentThreadIdRef.current).toBe(184);
    expect(context.router.replace).not.toHaveBeenCalled();
  });

  it.each([403, 404])('clears unavailable/not-owned campaign context for genuine status %s', async status => {
    const { context, values, handler } = harness(184);
    context.api.get.mockRejectedValueOnce(new ApiError('Conversation unavailable', status));
    await handler(184);
    expect(context.currentThreadIdRef.current).toBeNull();
    expect(values.currentThreadId).toBeNull();
    expect(context.resetWidgets).toHaveBeenLastCalledWith(null);
    expect(context.router.replace).toHaveBeenCalledWith('/dashboard/conversations');
    expect(values.threadLoadError).toBeNull();
    expect(values.messages).toEqual([]);
    expect(values.icp).toBeNull();
    expect(values.approvalData).toBeNull();
  });

  it('deduplicates simultaneous loads for the same requested ID', async () => {
    const { context, handler } = harness();
    let resolveRequest!: (value: unknown) => void;
    context.api.get.mockImplementationOnce(() => new Promise(resolve => { resolveRequest = resolve; }));
    const first = handler(184);
    await handler(184);
    expect(context.api.get).toHaveBeenCalledTimes(1);
    resolveRequest({ id: 184, title: 'Campaign' });
    await first;
  });

  it('does not let a stale failure reset or clear a newer campaign load', async () => {
    const { context, values, handler } = harness();
    let rejectOld!: (reason: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    context.api.get.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const oldLoad = handler(184);
    const newLoad = handler(185);
    const newController = context.threadLoadAbortRef.current;
    rejectOld(new ApiError('Old request unavailable', 404));
    await oldLoad;
    expect(context.currentThreadIdRef.current).toBe(185);
    expect(context.threadLoadAbortRef.current).toBe(newController);
    expect(values.threadLoadError).toBeNull();
    expect(context.router.replace).not.toHaveBeenCalled();
    resolveNew({ id: 185, title: 'New campaign' });
    await newLoad;
  });

  it('wires the visible retry control to the failed campaign and resets errors for new chats', () => {
    expect(source).toContain('role="alert"');
    expect(source).toContain('Retry conversation');
    expect(source).toContain('onClick={() => void handleThreadSelect(threadLoadError.threadId)}');
    const start = source.indexOf('function handleNewThread()');
    expect(source.slice(start, start + 160)).toContain('setThreadLoadError(null)');
  });
});
