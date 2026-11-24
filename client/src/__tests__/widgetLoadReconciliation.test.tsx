import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WidgetProvider, useWidgets } from '@/components/widgets/WidgetContext';
import type { WidgetState } from '@/components/widgets/types';

const { getWidgets } = vi.hoisted(() => ({ getWidgets: vi.fn() }));
vi.mock('@/components/widgets/api', () => ({ widgetApi: { getWidgets } }));
afterEach(() => { cleanup(); getWidgets.mockReset(); });
const widget: WidgetState = {
  id: 1, threadId: 42, messageId: 10, toolName: 'generate_image', widgetType: 'image_generation',
  status: 'active', formValues: {}, agentType: 'content',
  createdAt: '2026-10-23T12:00:00Z', updatedAt: '2026-10-23T12:00:00Z',
};
const wrapper = ({ children }: { children: React.ReactNode }) => <WidgetProvider>{children}</WidgetProvider>;

it.each(['running', 'succeeded', 'cancelled'] as const)('keeps the newer %s event when an older active history snapshot arrives', async status => {
  let resolve!: (widgets: WidgetState[]) => void;
  getWidgets.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const hook = renderHook(() => useWidgets(), { wrapper });
  let loading!: Promise<void>;
  act(() => { loading = hook.result.current.loadWidgets(42); });
  // The widget need not have arrived in a creation event before its status.
  act(() => hook.result.current.updateWidget({ id: 1, threadId: 42, status, executionAttemptCount: 1 }));
  await act(async () => { resolve([widget]); await loading; });
  expect(hook.result.current.getWidget(1)?.status).toBe(status);
});

it('retains widgets created after a history read began even when its snapshot omits them', async () => {
  let resolve!: (widgets: WidgetState[]) => void;
  getWidgets.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const hook = renderHook(() => useWidgets(), { wrapper });
  let loading!: Promise<void>;
  act(() => { loading = hook.result.current.loadWidgets(42); });
  act(() => hook.result.current.addWidget(widget));
  await act(async () => { resolve([]); await loading; });
  expect(hook.result.current.widgets).toEqual([widget]);
});

it('discards old-thread updates when navigating before the history response arrives', async () => {
  let resolve!: (widgets: WidgetState[]) => void;
  getWidgets.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const hook = renderHook(() => useWidgets(), { wrapper });
  let loading!: Promise<void>;
  act(() => { loading = hook.result.current.loadWidgets(42); });
  act(() => hook.result.current.updateWidget({ id: 1, threadId: 42, status: 'succeeded' }));
  act(() => hook.result.current.resetWidgets(99));
  await act(async () => { resolve([widget]); await loading; });
  expect(hook.result.current.widgets).toEqual([]);
});
