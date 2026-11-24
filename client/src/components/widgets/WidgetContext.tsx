"use client";

/**
 * Widget Context
 * Manages interactive widget states across the chat interface.
 * Handles auto-save, draft persistence, and WebSocket events.
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { WidgetState } from "./types";
import { widgetApi } from "./api";
import { isRetrySafeExecutionResult } from '../../../../shared/toolExecutionReceipt';

interface WidgetContextType {
  // All widgets for the current thread
  widgets: WidgetState[];

  // Loading state
  isLoading: boolean;
  loadError: string | null;

  // Actions
  loadWidgets: (threadId: number) => Promise<void>;
  retryLoadWidgets: () => Promise<void>;
  resetWidgets: (threadId?: number | null) => void;
  addWidget: (widget: WidgetState) => void;
  updateWidget: (widget: Partial<WidgetState> & { id: number }) => void;
  updateFormValues: (widgetId: number, values: Record<string, unknown>) => void;
  submitWidget: (widgetId: number, values: Record<string, unknown>) => Promise<void>;
  closeWidget: (widgetId: number, values?: Record<string, unknown>) => Promise<void>;
  reopenWidget: (widgetId: number) => Promise<void>;
  deleteWidget: (widgetId: number) => Promise<void>;

  // Get widget by ID
  getWidget: (id: number) => WidgetState | undefined;

  // Get widget by message ID
  getWidgetByMessageId: (messageId: number) => WidgetState | undefined;

  // Get widgets by status
  getActiveWidgets: () => WidgetState[];
  getDraftWidgets: () => WidgetState[];
  getSubmittedWidgets: () => WidgetState[];
}

const WidgetContext = createContext<WidgetContextType | undefined>(undefined);

// Terminal realtime receipts can beat the HTTP submit acknowledgement. Do not
// regress them to running/active when that older acknowledgement arrives.
function mergeWidgetState<T extends Partial<WidgetState>>(current: T, update: Partial<WidgetState>, allowReviewEdit = false): T {
  if (current.status === 'cancelled') return current;
  if (current.status === 'succeeded' && update.status && update.status !== 'succeeded') return current;
  // An explicit draft/reopen acknowledgement can keep a verified pre-effect
  // failure's receipt. Passive/outdated acknowledgements still cannot revive it.
  const safeReviewEdit = allowReviewEdit && ['active', 'draft'].includes(update.status || '')
    && isRetrySafeExecutionResult(current.executionResult) && isRetrySafeExecutionResult(update.executionResult)
    && (update.executionAttemptCount ?? 0) === (current.executionAttemptCount ?? 0);
  if (current.status === 'failed'
    && ['active', 'draft', 'running', 'queued', 'provider_succeeded'].includes(update.status || '')
    && (update.executionAttemptCount ?? 0) <= (current.executionAttemptCount ?? 0) && !safeReviewEdit) return current;
  return { ...current, ...update };
}

export function WidgetProvider({ children }: { children: React.ReactNode }) {
  const [widgets, setWidgets] = useState<WidgetState[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const historyBlockedRef = useRef(false);
  const widgetsRef = useRef<WidgetState[]>([]);

  // Track the current thread ID for API calls
  const currentThreadIdRef = useRef<number | null>(null);
  const loadSequenceRef = useRef(0);
  const loadingUpdatesRef = useRef<Map<number, Partial<WidgetState>> | null>(null);
  const submissionLockedWidgetIdsRef = useRef(new Set<number>());
  const formSaveTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const formSaveRevisionsRef = useRef(new Map<number, number>());

  useEffect(() => {
    widgetsRef.current = widgets;
  }, [widgets]);

  useEffect(() => () => {
    for (const timer of formSaveTimersRef.current.values()) clearTimeout(timer);
    formSaveTimersRef.current.clear();
  }, []);

  /**
   * Load all widgets for a thread
   */
  const loadWidgets = useCallback(async (threadId: number) => {
    const seq = ++loadSequenceRef.current;
    const updates = new Map<number, Partial<WidgetState>>();
    loadingUpdatesRef.current = updates;
    if (currentThreadIdRef.current !== threadId) setLoadError(null);
    historyBlockedRef.current = true;
    setIsLoading(true);
    currentThreadIdRef.current = threadId;
    submissionLockedWidgetIdsRef.current.clear();
    setWidgets([]);
    try {
      const fetchedWidgets = await widgetApi.getWidgets(threadId);
      // Stale result: a newer load was triggered while we were fetching
      if (seq !== loadSequenceRef.current) return;
      historyBlockedRef.current = false;
      setLoadError(null);
      setWidgets(current => {
        const fetchedIds = new Set(fetchedWidgets.map(widget => widget.id));
        return [
          ...fetchedWidgets.map(widget => {
            const live = updates.get(widget.id);
            return live ? mergeWidgetState(widget, live) : widget;
          }),
          ...current.filter(widget => !fetchedIds.has(widget.id)),
        ];
      });
    } catch (error) {
      if (seq !== loadSequenceRef.current) return;
      setLoadError('Reviews could not be loaded. Retry before continuing.');
      console.error('[WidgetContext] Error loading widgets:', error);
    } finally {
      if (seq === loadSequenceRef.current) {
        loadingUpdatesRef.current = null;
        setIsLoading(false);
      }
    }
  }, []);

  const retryLoadWidgets = useCallback(async () => {
    const threadId = currentThreadIdRef.current;
    if (threadId !== null) await loadWidgets(threadId);
  }, [loadWidgets]);

  /**
   * Reset immediately when navigation changes, before the next thread's API
   * response arrives. This prevents widgets from the previous conversation
   * remaining actionable during a rapid switch.
   */
  const resetWidgets = useCallback((threadId: number | null = null) => {
    loadSequenceRef.current += 1;
    loadingUpdatesRef.current = null;
    currentThreadIdRef.current = threadId;
    submissionLockedWidgetIdsRef.current.clear();
    historyBlockedRef.current = false;
    setLoadError(null);
    setWidgets([]);
    setIsLoading(false);
  }, []);

  /**
   * Add a new widget (from WebSocket event)
   */
  const addWidget = useCallback((widget: WidgetState) => {
    if (widget.threadId !== currentThreadIdRef.current) return;
    const createdWidget = {
      ...widget,
      // Older servers omitted status from widget_created even though newly
      // created review widgets are active. Defaulting here keeps the review
      // card reachable during rolling deployments.
      status: widget.status || 'active',
    } as WidgetState;
    const loadingUpdates = loadingUpdatesRef.current;
    if (loadingUpdates) {
      const prior = loadingUpdates.get(widget.id);
      loadingUpdates.set(widget.id, prior ? mergeWidgetState(prior, createdWidget) : createdWidget);
    }
    setWidgets(prev => {
      // A repeated natural-language confirmation can relink the same pending
      // widget to a newer tool message. Merge the event so the review surface
      // follows that message instead of remaining attached to stale content.
      if (prev.some(w => w.id === createdWidget.id)) {
        return prev.map(w => w.id === createdWidget.id
          ? mergeWidgetState(w, createdWidget)
          : w);
      }
      return [createdWidget, ...prev];
    });

  }, []);

  /**
   * Update a widget in the local state
   */
  const updateWidget = useCallback((widget: Partial<WidgetState> & { id: number }) => {
    if (widget.threadId !== undefined && widget.threadId !== currentThreadIdRef.current) return;
    // Receipts can arrive before the history response has materialized their
    // row. Keep those patches so an older snapshot cannot revive the review.
    const loadingUpdates = loadingUpdatesRef.current;
    if (loadingUpdates) {
      const prior = loadingUpdates.get(widget.id);
      loadingUpdates.set(widget.id, prior ? mergeWidgetState(prior, widget) : widget);
    }
    if (widget.status === 'cancelled') {
      submissionLockedWidgetIdsRef.current.add(widget.id);
      const timer = formSaveTimersRef.current.get(widget.id);
      if (timer) clearTimeout(timer);
      formSaveTimersRef.current.delete(widget.id);
    }
    if (widget.status === 'failed') {
      const executionResult = widget.executionResult as Record<string, unknown> | null | undefined;
      if (isRetrySafeExecutionResult(executionResult)) {
        submissionLockedWidgetIdsRef.current.delete(widget.id);
      }
    }
    setWidgets(prev => prev.map(w => w.id === widget.id ? mergeWidgetState(w, widget) : w));
  }, []);

  // Listen for custom widget:created and widget:updated events from page.tsx
  useEffect(() => {
    const handleWidgetCreated = (e: Event) => {
      const customEvent = e as CustomEvent<WidgetState>;
      if (customEvent.detail) {
        addWidget(customEvent.detail);
      }
    };

    const handleWidgetUpdated = (e: Event) => {
      const customEvent = e as CustomEvent<Partial<WidgetState> & { id: number }>;
      if (customEvent.detail) {
        updateWidget(customEvent.detail);
      }
    };

    window.addEventListener('widget:created', handleWidgetCreated);
    window.addEventListener('widget:updated', handleWidgetUpdated);

    return () => {
      window.removeEventListener('widget:created', handleWidgetCreated);
      window.removeEventListener('widget:updated', handleWidgetUpdated);
    };
  }, [addWidget, updateWidget]);

  /**
   * Auto-save form values (debounced)
   */
  const saveFormValues = useCallback(async (
    widgetId: number,
    values: Record<string, unknown>,
    revision: number,
  ) => {
    // A debounced edit can mature just after Submit. Once execution has been
    // claimed, discard that stale save instead of sending an invalid update.
    if (submissionLockedWidgetIdsRef.current.has(widgetId)) return;
    const currentWidget = widgetsRef.current.find(widget => widget.id === widgetId);
    if (!currentWidget || !['active', 'draft'].includes(currentWidget.status)) return;
    try {
      await widgetApi.updateFormValues(widgetId, values);
      if (formSaveRevisionsRef.current.get(widgetId) !== revision) return;
      // Update local state
      setWidgets(prev => prev.map(w =>
        w.id === widgetId ? { ...w, formValues: values, updatedAt: new Date().toISOString() } : w
      ));
    } catch (error) {
      console.error('[WidgetContext] Error saving form values:', error);
    }
  }, []);

  const updateFormValues = useCallback((widgetId: number, values: Record<string, unknown>) => {
    const revision = (formSaveRevisionsRef.current.get(widgetId) || 0) + 1;
    formSaveRevisionsRef.current.set(widgetId, revision);
    const existingTimer = formSaveTimersRef.current.get(widgetId);
    if (existingTimer) clearTimeout(existingTimer);
    formSaveTimersRef.current.set(widgetId, setTimeout(() => {
      formSaveTimersRef.current.delete(widgetId);
      void saveFormValues(widgetId, values, revision);
    }, 1000));
  }, [saveFormValues]);

  /**
   * Submit a widget with final values
   */
  const submitWidget = useCallback(async (widgetId: number, values: Record<string, unknown>) => {
    if (historyBlockedRef.current) {
      throw new Error('Reload the reviews before submitting this action.');
    }
    if (widgetsRef.current.find(widget => widget.id === widgetId)?.status === 'cancelled') {
      throw new Error('This review was cancelled. Create a new review to proceed.');
    }
    submissionLockedWidgetIdsRef.current.add(widgetId);
    try {
      const updatedWidget = await widgetApi.submitWidget(widgetId, values);
      setWidgets(prev => prev.map(w => w.id === widgetId ? mergeWidgetState(w, updatedWidget) : w));
    } catch (error) {
      submissionLockedWidgetIdsRef.current.delete(widgetId);
      console.error('[WidgetContext] Error submitting widget:', error);
      throw error;
    }
  }, []);

  /**
   * Close a widget (save as draft)
   */
  const closeWidget = useCallback(async (widgetId: number, values?: Record<string, unknown>) => {
    if (widgetsRef.current.find(widget => widget.id === widgetId)?.status === 'cancelled') {
      throw new Error('This review was cancelled and cannot be saved as a draft.');
    }
    try {
      const pendingTimer = formSaveTimersRef.current.get(widgetId);
      if (pendingTimer) clearTimeout(pendingTimer);
      formSaveTimersRef.current.delete(widgetId);
      formSaveRevisionsRef.current.set(widgetId, (formSaveRevisionsRef.current.get(widgetId) || 0) + 1);
      // A draft click is an explicit persistence boundary. Flush the exact
      // controlled values before changing status instead of waiting for a
      // debounced acknowledgement that may arrive after the card remounts.
      if (values) await widgetApi.updateFormValues(widgetId, values);
      const updatedWidget = await widgetApi.closeWidget(widgetId, 'draft');
      setWidgets(prev => prev.map(w => w.id === widgetId ? mergeWidgetState(w, updatedWidget, true) : w));
    } catch (error) {
      console.error('[WidgetContext] Error closing widget:', error);
      throw error;
    }
  }, []);

  /**
   * Reopen a closed widget
   */
  const reopenWidget = useCallback(async (widgetId: number) => {
    if (widgetsRef.current.find(widget => widget.id === widgetId)?.status === 'cancelled') {
      throw new Error('This review was cancelled. Create a new review to proceed.');
    }
    try {
      const updatedWidget = await widgetApi.reopenWidget(widgetId);
      setWidgets(prev => prev.map(w => w.id === widgetId ? mergeWidgetState(w, updatedWidget, true) : w));
    } catch (error) {
      console.error('[WidgetContext] Error reopening widget:', error);
      throw error;
    }
  }, []);

  /**
   * Delete a widget permanently
   */
  const deleteWidget = useCallback(async (widgetId: number) => {
    try {
      await widgetApi.deleteWidget(widgetId);
      setWidgets(prev => prev.filter(w => w.id !== widgetId));
    } catch (error) {
      console.error('[WidgetContext] Error deleting widget:', error);
      throw error;
    }
  }, []);

  /**
   * Get widget by ID
   */
  const getWidget = useCallback((id: number) => {
    return widgets.find(w => w.id === id);
  }, [widgets]);

  /**
   * Get widget by message ID
   */
  const getWidgetByMessageId = useCallback((messageId: number) => {
    return widgets.find(w => w.messageId === messageId);
  }, [widgets]);

  /**
   * Get widgets filtered by status
   */
  const getActiveWidgets = useCallback(() => {
    return widgets.filter(w => w.status === 'active');
  }, [widgets]);

  const getDraftWidgets = useCallback(() => {
    return widgets.filter(w => w.status === 'draft');
  }, [widgets]);

  const getSubmittedWidgets = useCallback(() => {
    return widgets.filter(w =>
      ['running', 'queued', 'provider_succeeded', 'succeeded', 'failed'].includes(w.status),
    );
  }, [widgets]);

  const value: WidgetContextType = {
    widgets,
    isLoading,
    loadError,
    loadWidgets,
    retryLoadWidgets,
    resetWidgets,
    addWidget,
    updateWidget,
    updateFormValues,
    submitWidget,
    closeWidget,
    reopenWidget,
    deleteWidget,
    getWidget,
    getWidgetByMessageId,
    getActiveWidgets,
    getDraftWidgets,
    getSubmittedWidgets,
  };

  return (
    <WidgetContext.Provider value={value}>
      {children}
    </WidgetContext.Provider>
  );
}

export function useWidgets() {
  const context = useContext(WidgetContext);
  if (!context) {
    throw new Error('useWidgets must be used within a WidgetProvider');
  }
  return context;
}
