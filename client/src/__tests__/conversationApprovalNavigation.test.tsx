import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useToolExecution } from '@/hooks/useToolExecution';
const mocks = vi.hoisted(() => ({ post: vi.fn(), toast: vi.fn(), clear: vi.fn(), processing: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { post: mocks.post }, ApiError: class extends Error {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); });
afterEach(cleanup);
const approval = (requestId: string) => ({ requestId, toolName: 'execute_lead_workflow' });

it.each(['navigate', 'new-review'])('does not let a late approval response dismiss another review after %s', async change => {
  let complete!: (value: unknown) => void;
  mocks.post.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const hook = renderHook(({ threadId }) => useToolExecution(threadId, mocks.clear, mocks.processing), { initialProps: { threadId: 42 } });
  act(() => { hook.result.current.setApprovalData(approval('old-review')); hook.result.current.setShowApprovalModal(true); });
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.handleApproveTool(true); });
  if (change === 'navigate') hook.rerender({ threadId: 99 });
  act(() => { hook.result.current.setApprovalData(approval('new-review')); hook.result.current.setShowApprovalModal(true); });
  await act(async () => { complete({ status: 'succeeded' }); await pending; });
  expect(hook.result.current.showApprovalModal).toBe(true);
  expect(hook.result.current.approvalData?.requestId).toBe('new-review');
  expect(mocks.processing).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
});

it('only submits one approval when two clicks occur before the next render', async () => {
  let complete!: (value: unknown) => void;
  mocks.post.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const hook = renderHook(() => useToolExecution(42, mocks.clear, mocks.processing));
  act(() => hook.result.current.setApprovalData(approval('one-review')));
  let a!: Promise<void>; let b!: Promise<void>;
  act(() => { a = hook.result.current.handleApproveTool(true); b = hook.result.current.handleApproveTool(true); });
  await act(async () => { complete({ status: 'succeeded' }); await Promise.all([a,b]); });
  expect(mocks.post).toHaveBeenCalledTimes(1);
});

it('retains the first review delivered in the same render as new-thread adoption', () => {
  const hook = renderHook(({ threadId }: { threadId: number | null }) => useToolExecution(threadId,mocks.clear,mocks.processing), { initialProps: { threadId: null as number | null } });
  act(() => {
    hook.result.current.setApprovalData(approval('first-review'));
    hook.result.current.setShowApprovalModal(true);
    hook.rerender({ threadId: 42 });
  });
  expect(hook.result.current.approvalData?.requestId).toBe('first-review');
  expect(hook.result.current.showApprovalModal).toBe(true);
});
