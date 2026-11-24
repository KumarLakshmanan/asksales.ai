/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WidgetContext Tests
 * Tests: loadWidgets race condition, deduplication, and explicit review behavior
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { WidgetProvider, useWidgets } from '@/components/widgets/WidgetContext';
import type { WidgetState } from '@/components/widgets/types';

// Mock the widget API
const mockGetWidgets = vi.fn();
const mockUpdateFormValues = vi.fn().mockResolvedValue(undefined);
const mockDeleteWidget = vi.fn().mockResolvedValue(undefined);
const mockSubmitWidget = vi.fn();
const mockCloseWidget = vi.fn();
const mockReopenWidget = vi.fn();

vi.mock('@/components/widgets/api', () => ({
  widgetApi: {
    getWidgets: (...args: any[]) => mockGetWidgets(...args),
    updateFormValues: (...args: any[]) => mockUpdateFormValues(...args),
    deleteWidget: (...args: any[]) => mockDeleteWidget(...args),
    submitWidget: (...args: any[]) => mockSubmitWidget(...args),
    closeWidget: (...args: any[]) => mockCloseWidget(...args),
    reopenWidget: (...args: any[]) => mockReopenWidget(...args),
  },
}));

function createMockWidget(overrides: Partial<WidgetState> = {}): WidgetState {
  return {
    id: 1,
    widgetType: 'image_generation',
    toolName: 'generate_image',
    status: 'active',
    formValues: {},
    agentType: 'content',
    threadId: 1,
    messageId: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('WidgetContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WidgetProvider>{children}</WidgetProvider>
  );

  it('accepts an explicit safe-failure draft save without reviving a stale passive acknowledgement', async () => {
    const failed = createMockWidget({ status: 'failed', executionAttemptCount: 1, executionResult: { retrySafe: true } });
    const draft = { ...failed, status: 'draft' as const };
    mockGetWidgets.mockResolvedValueOnce([failed]);
    mockCloseWidget.mockResolvedValueOnce(draft);
    const { result } = renderHook(() => useWidgets(), { wrapper });
    await act(async () => { await result.current.loadWidgets(1); });
    act(() => { result.current.updateWidget(draft); });
    expect(result.current.widgets[0].status).toBe('failed');
    await act(async () => { await result.current.closeWidget(1, { question: 'Saved correction' }); });
    expect(result.current.widgets[0]).toMatchObject({ status: 'draft', executionAttemptCount: 1, executionResult: { retrySafe: true } });
  });

  describe('loadWidgets race condition', () => {
    it('should load widgets successfully', async () => {
      const widgets = [createMockWidget({ id: 1 })];
      mockGetWidgets.mockResolvedValueOnce(widgets);

      const { result } = renderHook(() => useWidgets(), { wrapper });

      await act(async () => {
        await result.current.loadWidgets(1);
      });

      expect(result.current.widgets).toEqual(widgets);
    });

    it('should set isLoading to false after loading', async () => {
      mockGetWidgets.mockResolvedValueOnce([]);

      const { result } = renderHook(() => useWidgets(), { wrapper });

      await act(async () => {
        await result.current.loadWidgets(1);
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('should handle API errors gracefully', async () => {
      mockGetWidgets.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useWidgets(), { wrapper });

      await act(async () => {
        await result.current.loadWidgets(1);
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.widgets).toEqual([]);
    });

    it('should use latest load result when multiple loads overlap', async () => {
      const slowWidgets = [createMockWidget({ id: 1, widgetType: 'image_generation' })];
      const fastWidgets = [createMockWidget({ id: 2, widgetType: 'video_generation' })];

      let resolveSlow: (value: WidgetState[]) => void;
      let resolveFast: (value: WidgetState[]) => void;

      const slowPromise = new Promise<WidgetState[]>((resolve) => { resolveSlow = resolve; });
      const fastPromise = new Promise<WidgetState[]>((resolve) => { resolveFast = resolve; });

      mockGetWidgets
        .mockImplementationOnce(() => slowPromise)
        .mockImplementationOnce(() => fastPromise);

      const { result } = renderHook(() => useWidgets(), { wrapper });

      // Start slow load first
      act(() => {
        result.current.loadWidgets(1);
      });

      // Start fast load
      act(() => {
        result.current.loadWidgets(2);
      });

      // Resolve fast load first
      await act(async () => {
        resolveFast!(fastWidgets);
      });

      // Widgets should be from fast load
      expect(result.current.widgets).toEqual(fastWidgets);

      // Now resolve slow load (should be ignored)
      await act(async () => {
        resolveSlow!(slowWidgets);
      });

      // Widgets should still be from fast load (slow was stale)
      expect(result.current.widgets).toEqual(fastWidgets);
    });
  });

  describe('addWidget', () => {
    it('keeps a completed realtime receipt when the older submit response arrives later', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });
      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget());
      });
      let resolveSubmit!: (widget: WidgetState) => void;
      mockSubmitWidget.mockImplementationOnce(() => new Promise(resolve => { resolveSubmit = resolve; }));
      let submitting!: Promise<void>;
      act(() => { submitting = result.current.submitWidget(1, {}); });
      act(() => window.dispatchEvent(new CustomEvent('widget:updated', {
        detail: createMockWidget({ status: 'succeeded', executionAttemptCount: 1 }),
      })));
      await act(async () => {
        resolveSubmit(createMockWidget({ status: 'running', executionAttemptCount: 1 }));
        await submitting;
      });
      expect(result.current.getWidget(1)?.status).toBe('succeeded');
    });

    it('never resurrects a cancelled review from a delayed creation or update event', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });
      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget());
      });
      act(() => result.current.updateWidget({ id: 1, status: 'cancelled' }));
      act(() => {
        result.current.addWidget(createMockWidget());
        result.current.updateWidget({ id: 1, status: 'draft' });
      });
      expect(result.current.widgets[0].status).toBe('cancelled');
      await expect(result.current.submitWidget(1, {})).rejects.toThrow('cancelled');
      await expect(result.current.reopenWidget(1)).rejects.toThrow('cancelled');
      await expect(result.current.closeWidget(1, {})).rejects.toThrow('cancelled');
      expect(mockSubmitWidget).not.toHaveBeenCalled();
      expect(mockReopenWidget).not.toHaveBeenCalled();
      expect(mockCloseWidget).not.toHaveBeenCalled();
    });

    it('does not let an in-flight save-draft response replace a cancellation', async () => {
      let finishClose!: (widget: WidgetState) => void;
      mockCloseWidget.mockImplementationOnce(() => new Promise<WidgetState>(resolve => { finishClose = resolve; }));
      const { result } = renderHook(() => useWidgets(), { wrapper });
      act(() => { result.current.resetWidgets(1); result.current.addWidget(createMockWidget()); });
      let request!: Promise<void>;
      act(() => { request = result.current.closeWidget(1); });
      act(() => result.current.updateWidget({ id: 1, status: 'cancelled' }));
      await act(async () => { finishClose(createMockWidget({ status: 'draft' })); await request; });
      expect(result.current.widgets[0].status).toBe('cancelled');
    });
    it('should add a widget to the list', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      const newWidget = createMockWidget({ id: 10 });
      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(newWidget);
      });

      expect(result.current.widgets).toContainEqual(newWidget);
    });

    it('should not add duplicate widgets', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      const widget = createMockWidget({ id: 10 });
      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(widget);
      });
      act(() => {
        result.current.addWidget(widget);
      });

      expect(result.current.widgets.filter(w => w.id === 10)).toHaveLength(1);
    });

    it('merges a relinked duplicate widget event', () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 10, messageId: 100 }));
      });
      act(() => {
        result.current.addWidget(createMockWidget({ id: 10, messageId: 101 }));
      });

      expect(result.current.widgets).toHaveLength(1);
      expect(result.current.widgets[0].messageId).toBe(101);
    });

    it('should not auto-open active widgets', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      const activeWidget = createMockWidget({ id: 10, status: 'active' });
      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(activeWidget);
      });

    });

    it('treats newly-created widgets without a status as active', () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });
      const rollingDeployWidget = createMockWidget({ id: 11 });
      delete (rollingDeployWidget as Partial<WidgetState>).status;

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(rollingDeployWidget);
      });

      expect(result.current.widgets.find((widget) => widget.id === 11)?.status).toBe('active');
    });
  });

  describe('updateWidget', () => {
    it('should update a widget in the list', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 1 }));
      });

      act(() => {
        result.current.updateWidget(createMockWidget({ id: 1, status: 'succeeded' }));
      });

      expect(result.current.widgets.find(w => w.id === 1)?.status).toBe('succeeded');
    });
  });

  describe('deleteWidget', () => {
    it('should remove a widget from the list', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 1 }));
      });
      act(() => {
        result.current.addWidget(createMockWidget({ id: 2 }));
      });

      await act(async () => {
        await result.current.deleteWidget(1);
      });

      expect(result.current.widgets.find(w => w.id === 1)).toBeUndefined();
      expect(result.current.widgets.find(w => w.id === 2)).toBeDefined();
    });
  });

  describe('updateFormValues', () => {
    it('should update form values for a widget (debounced)', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useWidgets(), { wrapper });

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 1, formValues: {} }));
      });

      act(() => {
        result.current.updateFormValues(1, { prompt: 'test' });
      });

      // Advance timers to trigger debounced save
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });

      const widget = result.current.widgets.find(w => w.id === 1);
      expect(widget?.formValues).toEqual({ prompt: 'test' });
      vi.useRealTimers();
    });

    it('drops a pending debounced save once widget submission starts', async () => {
      vi.useFakeTimers();
      try {
        const runningWidget = createMockWidget({ id: 1, status: 'running' });
        mockSubmitWidget.mockResolvedValueOnce(runningWidget);
        const { result } = renderHook(() => useWidgets(), { wrapper });

        act(() => {
          result.current.resetWidgets(1);
          result.current.addWidget(createMockWidget({ id: 1, formValues: {} }));
          result.current.updateFormValues(1, { prompt: 'final prompt' });
        });

        await act(async () => {
          await result.current.submitWidget(1, { prompt: 'final prompt' });
        });

        await act(async () => {
          vi.advanceTimersByTime(1500);
          await Promise.resolve();
        });

        expect(mockSubmitWidget).toHaveBeenCalledWith(1, { prompt: 'final prompt' });
        expect(mockUpdateFormValues).not.toHaveBeenCalled();
        expect(result.current.widgets.find(widget => widget.id === 1)?.status).toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not auto-save form values for a terminal widget after reload', async () => {
      vi.useFakeTimers();
      try {
        mockGetWidgets.mockResolvedValueOnce([
          createMockWidget({ id: 1, status: 'succeeded', formValues: { prompt: 'done' } }),
        ]);
        const { result } = renderHook(() => useWidgets(), { wrapper });

        await act(async () => {
          await result.current.loadWidgets(1);
        });
        act(() => {
          result.current.updateFormValues(1, { prompt: 'stale mount value' });
        });
        await act(async () => {
          vi.advanceTimersByTime(1500);
          await Promise.resolve();
        });

        expect(mockUpdateFormValues).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('debounces each widget independently instead of dropping another card edit', async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useWidgets(), { wrapper });
        act(() => {
          result.current.resetWidgets(1);
          result.current.addWidget(createMockWidget({ id: 1 }));
          result.current.addWidget(createMockWidget({ id: 2 }));
          result.current.updateFormValues(1, { subject: 'Meta draft' });
          result.current.updateFormValues(2, { subject: 'Google draft' });
        });

        await act(async () => {
          vi.advanceTimersByTime(1100);
          await Promise.resolve();
        });

        expect(mockUpdateFormValues).toHaveBeenCalledWith(1, { subject: 'Meta draft' });
        expect(mockUpdateFormValues).toHaveBeenCalledWith(2, { subject: 'Google draft' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes the exact controlled values before saving a draft', async () => {
      const draftWidget = createMockWidget({ id: 1, status: 'draft', formValues: { subject: 'Retained subject' } });
      mockCloseWidget.mockResolvedValueOnce(draftWidget);
      const { result } = renderHook(() => useWidgets(), { wrapper });
      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 1 }));
      });

      await act(async () => {
        await result.current.closeWidget(1, { subject: 'Retained subject' });
      });

      expect(mockUpdateFormValues).toHaveBeenCalledWith(1, { subject: 'Retained subject' });
      expect(mockCloseWidget).toHaveBeenCalledWith(1, 'draft');
      expect(result.current.widgets[0].formValues).toEqual({ subject: 'Retained subject' });
    });
  });

  describe('getWidget', () => {
    it('should return widget by ID', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 42 }));
      });

      expect(result.current.getWidget(42)).toBeDefined();
      expect(result.current.getWidget(42)?.id).toBe(42);
    });

    it('should return undefined for non-existent widget', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });
      expect(result.current.getWidget(999)).toBeUndefined();
    });
  });

  describe('getActiveWidgets / getDraftWidgets / getSubmittedWidgets', () => {
    it('should filter widgets by status', async () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 1, status: 'active' }));
        result.current.addWidget(createMockWidget({ id: 2, status: 'draft' }));
        result.current.addWidget(createMockWidget({ id: 3, status: 'succeeded' }));
        result.current.addWidget(createMockWidget({ id: 4, status: 'active' }));
      });

      expect(result.current.getActiveWidgets()).toHaveLength(2);
      expect(result.current.getDraftWidgets()).toHaveLength(1);
      expect(result.current.getSubmittedWidgets()).toHaveLength(1);
    });

    it('clears prior widgets and ignores events from another thread', () => {
      const { result } = renderHook(() => useWidgets(), { wrapper });

      act(() => {
        result.current.resetWidgets(1);
        result.current.addWidget(createMockWidget({ id: 1, threadId: 1 }));
      });
      expect(result.current.widgets).toHaveLength(1);

      act(() => {
        result.current.resetWidgets(2);
        result.current.addWidget(createMockWidget({ id: 2, threadId: 1 }));
      });
      expect(result.current.widgets).toEqual([]);
    });
  });
});
