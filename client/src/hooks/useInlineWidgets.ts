import { useState, useCallback, useRef, useEffect } from "react";
import { type Tab } from "@/components/ChromeTabs";
import {
  CONTENT_TAB_TYPE_MAP as TAB_CONTENT_TYPE_MAP,
  HEADER_AGENT_TAB_MAP,
  VALID_TAB_TYPES,
  getTabLabel,
  normalizeTabType,
} from "@/lib/tabConfig";

import { type ActionUpdate, type LiveSignal } from "@/components/ActionSnapshotPanel";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const MAX_PERSISTED_RESULT_STRING = 50_000;

function sanitizeResultForPersistence(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 6) return undefined;
  if (typeof value === "string") {
    if (value.length > MAX_PERSISTED_RESULT_STRING) return undefined;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50)
      .map(item => sanitizeResultForPersistence(item, depth + 1))
      .filter(item => item !== undefined);
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, sanitizeResultForPersistence(item, depth + 1)] as const)
        .filter(([, item]) => item !== undefined),
    );
  }
  return undefined;
}

function persistedTabData(data?: Record<string, unknown>): Record<string, unknown> {
  return (sanitizeResultForPersistence(data || {}) as Record<string, unknown>) || {};
}

export function useInlineWidgets(
  currentThreadId: number | null,
  setChatViewMode: (mode: 'overview' | 'campaign') => void,
  setSelectedAgent: (agent: string | null) => void,
  sharedThreadIdRef?: { current: number | null },
) {
  const { toast } = useToast();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string>("");
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const tabsLoadedRef = useRef(tabsLoaded);
  const [tabData, setTabData] = useState<Record<string, Record<string, unknown>>>({});
  const pendingTabsRef = useRef<Set<string>>(new Set());
  const pendingTabResultsRef = useRef(new Map<string, {
    threadId: number | null;
    label?: string;
    switchTo: boolean;
    data?: Record<string, unknown>;
  }>());
  const mutationChainsRef = useRef(new Map<number, Promise<void>>());
  const tabsRef = useRef(tabs);
  const activeTabRef = useRef(activeTab);
  const navigationVersionRef = useRef(0);
  const ownThreadIdRef = useRef(currentThreadId);
  const currentThreadIdRef = sharedThreadIdRef || ownThreadIdRef;
  const deferredAddsRef = useRef<Array<{
    threadId: number;
    tabType: string;
    label?: string;
    switchTo: boolean;
    forceNew: boolean;
    data?: Record<string, unknown>;
  }>>([]);

  const [actionUpdates, setActionUpdates] = useState<ActionUpdate[]>([]);
  const [liveSignals, setLiveSignals] = useState<LiveSignal[]>([]);

  useEffect(() => { tabsLoadedRef.current = tabsLoaded; }, [tabsLoaded]);

  useEffect(() => {
    tabsRef.current = tabs;
    tabs.forEach(tab => {
      pendingTabsRef.current.delete(tab.type);
    });
  }, [tabs]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    ownThreadIdRef.current = currentThreadId;
    navigationVersionRef.current++;
    deferredAddsRef.current = deferredAddsRef.current.filter(
      request => request.threadId === currentThreadId,
    );
    pendingTabsRef.current.clear();
    pendingTabResultsRef.current.clear();
  }, [currentThreadId]);

  const runTabMutation = useCallback(async <T,>(
    threadId: number,
    mutation: () => Promise<T>,
  ): Promise<T> => {
    const previous = mutationChainsRef.current.get(threadId) || Promise.resolve();
    const result = previous.catch(() => undefined).then(mutation);
    const tail = result.then(() => undefined, () => undefined);
    mutationChainsRef.current.set(threadId, tail);
    try {
      return await result;
    } finally {
      if (mutationChainsRef.current.get(threadId) === tail) {
        mutationChainsRef.current.delete(threadId);
      }
    }
  }, []);

  const [highlightedTabId, setHighlightedTabId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerTabHighlight = useCallback((tabId: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedTabId(null);
    requestAnimationFrame(() => {
      setHighlightedTabId(tabId);
      highlightTimerRef.current = setTimeout(() => setHighlightedTabId(null), 2500);
    });
  }, []);

  const addActionUpdate = useCallback((update: Omit<ActionUpdate, 'id' | 'timestamp'>) => {
    const newUpdate: ActionUpdate = {
      ...update,
      id: `action-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };
    setActionUpdates(prev => [newUpdate, ...prev].slice(0, 20));
  }, []);

  const addLiveSignal = useCallback((signal: Omit<LiveSignal, 'id' | 'timestamp'>) => {
    const newSignal: LiveSignal = {
      ...signal,
      id: `signal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };
    setLiveSignals(prev => [newSignal, ...prev].slice(0, 10));
  }, []);

  const addTab: (
    tabType: string,
    label?: string,
    switchTo?: boolean,
    forceNew?: boolean,
    data?: Record<string, unknown>,
  ) => Promise<void> = useCallback(async (
    tabType: string,
    label?: string,
    switchTo = true,
    forceNew = false,
    data?: Record<string, unknown>
  ) => {
    const currentThreadId = currentThreadIdRef.current;
    let normalizedTabType = tabType;
    let normalizedData = data;
    let normalizedLabel = label;

    normalizedTabType = normalizeTabType(normalizedTabType);

    if (tabType === 'contentpreview' && data?.type) {
      const contentTypeMap: Record<string, string> = {
        image: 'content-image',
        video: 'content-video',
        email: 'content-email',
        email_template: 'content-email',
        sms: 'content-sms',
        sms_template: 'content-sms',
        whatsapp_template: 'content-whatsapp',
        whatsapp: 'content-whatsapp',
        social_dm: 'content-social-message',
        social: 'content-social',
        social_post: 'content-social',
        social_message: 'content-social-message',
        ad_copy: 'content-adcopy',
        blog: 'content-blog',
        blog_post: 'content-blog',
      };
      normalizedTabType = contentTypeMap[data.type as string] || 'content-image';
      normalizedData = { ...data };
      normalizedLabel = label || getTabLabel(normalizedTabType);
    } else if (TAB_CONTENT_TYPE_MAP[tabType]) {
      normalizedTabType = TAB_CONTENT_TYPE_MAP[tabType];
      normalizedData = { ...data };
      normalizedLabel = label || getTabLabel(normalizedTabType);
    }

    const acceptedTabTypes = new Set([
      ...VALID_TAB_TYPES,
      'crm',
      'support',
      'proposals',
    ]);
    if (!acceptedTabTypes.has(normalizedTabType)) {
      console.warn(`[Chat] Ignoring unsupported tab type: ${normalizedTabType}`);
      toast({ title: 'Unsupported result panel', description: `The app cannot open the “${normalizedTabType}” panel.`, variant: 'destructive' });
      return;
    }

    if (!tabsLoadedRef.current && currentThreadId) {
      const deferred = {
        threadId: currentThreadId,
        tabType: normalizedTabType,
        label: normalizedLabel,
        switchTo,
        forceNew,
        data: normalizedData,
      };
      const duplicateIndex = deferredAddsRef.current.findIndex(request =>
        request.threadId === currentThreadId &&
        request.tabType === normalizedTabType &&
        !request.forceNew &&
        !forceNew
      );
      if (duplicateIndex >= 0) {
        deferredAddsRef.current[duplicateIndex] = deferred;
      } else {
        deferredAddsRef.current.push(deferred);
      }
      return;
    }

    if (!forceNew) {
      if (pendingTabsRef.current.has(normalizedTabType)) {
        if (normalizedData) {
          pendingTabResultsRef.current.set(normalizedTabType, {
            threadId: currentThreadId,
            label: normalizedLabel,
            switchTo,
            data: normalizedData,
          });
        }
        return;
      }

      const existingTab = tabsRef.current.find(t =>
        t.type === normalizedTabType ||
        (normalizedTabType === 'content-studio' && t.type === 'contentstudio')
      );

      if (existingTab) {
        const previousActiveTab = activeTabRef.current;
        const navigationVersion = switchTo ? ++navigationVersionRef.current : navigationVersionRef.current;
        if (switchTo) {
          activeTabRef.current = existingTab.id;
          setActiveTab(existingTab.id);
          triggerTabHighlight(existingTab.id);
        }
        if (normalizedData) {
          const previousData = tabData[existingTab.id] || {};
          const mergedData = {
            ...previousData,
            ...normalizedData,
            refreshKey: Date.now(),
          };
          setTabData(prev => ({
            ...prev,
            [existingTab.id]: mergedData,
          }));
          if (currentThreadId) {
            const existingOrder = tabsRef.current.findIndex(tab => tab.id === existingTab.id);
            try {
              await runTabMutation(currentThreadId, () => api.post(`/api/chat/threads/${currentThreadId}/tabs`, {
                tabId: existingTab.id,
                tabType: existingTab.type,
                tabLabel: existingTab.label,
                tabOrder: Math.max(existingOrder, 0),
                isActive: switchTo || activeTabRef.current === existingTab.id,
                tabData: persistedTabData(mergedData),
              }));
            } catch (error) {
              if (currentThreadIdRef.current === currentThreadId) {
                setTabData(prev => prev[existingTab.id] === mergedData ? ({ ...prev, [existingTab.id]: previousData }) : prev);
              }
              if (currentThreadIdRef.current === currentThreadId && navigationVersionRef.current === navigationVersion) {
                activeTabRef.current = previousActiveTab;
                setActiveTab(previousActiveTab);
              }
              console.error('[Chat] Failed to persist updated tab result:', error);
              toast({ title: 'Result panel was not saved', description: 'The panel update was rolled back. Please retry.', variant: 'destructive' });
              return;
            }
          }
        }
        if (switchTo) {
          if (currentThreadId && !normalizedData) {
            try {
              await runTabMutation(currentThreadId, () => api.put(`/api/chat/threads/${currentThreadId}/active-tab`, {
                activeTabId: existingTab.id,
              }));
            } catch (error) {
              console.error('[Chat] Failed to persist active tab:', error);
              toast({ title: 'Panel switch was not saved', description: 'The previous panel remains active.', variant: 'destructive' });
              if (currentThreadIdRef.current === currentThreadId && navigationVersionRef.current === navigationVersion) {
                activeTabRef.current = previousActiveTab;
                setActiveTab(previousActiveTab);
              }
              return;
            }
          }
        }
        return;
      }
    }

    pendingTabsRef.current.add(normalizedTabType);
    const newTabId = `${normalizedTabType}-${Date.now()}`;
    const newTab: Tab = {
      id: newTabId,
      label: normalizedLabel || getTabLabel(normalizedTabType) || normalizedTabType,
      type: normalizedTabType,
      closeable: normalizedTabType !== 'overview',
    };

    const previousTabs = tabsRef.current;
    const previousActiveTab = activeTabRef.current;
    const updatedTabs = [...previousTabs, newTab];
    const newTabOrder = updatedTabs.length - 1;
    tabsRef.current = updatedTabs;
    setTabs(updatedTabs);

    if (normalizedData) {
      setTabData(prev => ({ ...prev, [newTabId]: normalizedData || {} }));
    }

    if (switchTo) {
      navigationVersionRef.current++;
      activeTabRef.current = newTabId;
      setActiveTab(newTabId);
    }

    if (currentThreadId) {
      try {
        await runTabMutation(currentThreadId, () => api.post(`/api/chat/threads/${currentThreadId}/tabs`, {
          tabId: newTabId,
          tabType: normalizedTabType,
          tabLabel: newTab.label,
          tabOrder: newTabOrder,
          isActive: switchTo,
          tabData: persistedTabData(normalizedData),
        }));
      } catch (err) {
        if (currentThreadIdRef.current !== currentThreadId) return;
        const rolledBackTabs = tabsRef.current.filter(tab => tab.id !== newTabId);
        tabsRef.current = rolledBackTabs;
        setTabs(rolledBackTabs);
        setTabData(prev => {
          const next = { ...prev };
          delete next[newTabId];
          return next;
        });
        if (switchTo && activeTabRef.current === newTabId) {
          activeTabRef.current = previousActiveTab;
          setActiveTab(previousActiveTab);
        }
        console.error('[Chat] Failed to sync new tab to server:', err);
        toast({ title: 'Result panel could not be opened', description: 'The panel was rolled back because it could not be saved.', variant: 'destructive' });
      } finally {
        if (currentThreadIdRef.current === currentThreadId) {
          pendingTabsRef.current.delete(normalizedTabType);
          const pendingResult = pendingTabResultsRef.current.get(normalizedTabType);
          if (pendingResult) {
            pendingTabResultsRef.current.delete(normalizedTabType);
            if (pendingResult.threadId === currentThreadIdRef.current && tabsRef.current.some(tab => tab.id === newTabId)) {
              void addTab(normalizedTabType, pendingResult.label, false, false, pendingResult.data);
            }
          }
        }
      }
    } else {
      pendingTabsRef.current.delete(normalizedTabType);
    }
  }, [currentThreadIdRef, triggerTabHighlight, tabData, runTabMutation, toast]);

  useEffect(() => {
    if (!tabsLoaded || !currentThreadId || deferredAddsRef.current.length === 0) return;
    const queued = deferredAddsRef.current.filter(request => request.threadId === currentThreadId);
    deferredAddsRef.current = deferredAddsRef.current.filter(request => request.threadId !== currentThreadId);
    queued.forEach(request => {
      void addTab(
        request.tabType,
        request.label,
        request.switchTo,
        request.forceNew,
        request.data,
      );
    });
  }, [tabsLoaded, currentThreadId, addTab]);

  const handleAddTabFromButton = useCallback(async () => {
    const searchTabCount = tabsRef.current.filter(t => t.type === 'search').length;
    await addTab(
      'search',
      searchTabCount > 0 ? `Search ${searchTabCount + 1}` : 'Search',
      true,
      true,
    );
  }, [addTab]);

  const switchTab = useCallback(async (tabId: string) => {
    const currentThreadId = currentThreadIdRef.current;
    if (!tabsRef.current.some(tab => tab.id === tabId)) return;
    const previousActiveTab = activeTabRef.current;
    const navigationVersion = ++navigationVersionRef.current;
    activeTabRef.current = tabId;
    setActiveTab(tabId);
    if (currentThreadId) {
      try {
        await runTabMutation(currentThreadId, () => api.put(`/api/chat/threads/${currentThreadId}/active-tab`, {
          activeTabId: tabId,
        }));
      } catch (error) {
        if (currentThreadIdRef.current === currentThreadId && navigationVersionRef.current === navigationVersion) {
          activeTabRef.current = previousActiveTab;
          setActiveTab(previousActiveTab);
        }
        console.error("Error updating active tab:", error);
        toast({ title: 'Panel switch failed', description: 'The previous panel remains active.', variant: 'destructive' });
      }
    }
  }, [currentThreadIdRef, runTabMutation, toast]);

  const removeTab = useCallback(async (tabId: string) => {
    const currentThreadId = currentThreadIdRef.current;
    const previousTabs = tabsRef.current;
    const previousActiveTab = activeTabRef.current;
    const filteredTabs = previousTabs.filter(t => t.id !== tabId);
    if (filteredTabs.length === previousTabs.length) return;
    const newActiveTabId = previousActiveTab === tabId
      ? (filteredTabs.at(-1)?.id || '')
      : previousActiveTab;

    const navigationVersion = ++navigationVersionRef.current;
    pendingTabResultsRef.current.delete(previousTabs.find(tab => tab.id === tabId)?.type || "");
    tabsRef.current = filteredTabs;
    setTabs(filteredTabs);
    if (newActiveTabId !== previousActiveTab) {
      activeTabRef.current = newActiveTabId;
      setActiveTab(newActiveTabId);
    }

    if (currentThreadId && filteredTabs.length >= 0) {
      try {
        const tabConfigs = filteredTabs.map((tab, index) => ({
          tabId: tab.id,
          tabType: tab.type,
          tabLabel: tab.label,
          tabOrder: index,
          isActive: tab.id === newActiveTabId,
          tabData: persistedTabData(tabData[tab.id]),
        }));

        await runTabMutation(currentThreadId, () => api.put(`/api/chat/threads/${currentThreadId}/tabs`, {
          tabs: tabConfigs,
        }));
      } catch (error) {
        if (currentThreadIdRef.current !== currentThreadId) return;
        const removedTab = previousTabs.find(tab => tab.id === tabId);
        if (removedTab && !tabsRef.current.some(tab => tab.id === tabId)) {
          const restored = [...tabsRef.current];
          restored.splice(Math.min(previousTabs.findIndex(tab => tab.id === tabId), restored.length), 0, removedTab);
          tabsRef.current = restored;
          setTabs(restored);
        }
        if (navigationVersionRef.current === navigationVersion) {
          activeTabRef.current = previousActiveTab;
          setActiveTab(previousActiveTab);
        }
        console.error("Error saving tab configuration:", error);
        toast({ title: 'Panel could not be closed', description: 'The panel was restored because the change could not be saved.', variant: 'destructive' });
      }
    }
  }, [currentThreadIdRef, tabData, runTabMutation, toast]);

  const handleHeaderAgentClick = useCallback(async (agent: { id?: string; name?: string; agentType?: string }) => {
    setChatViewMode('overview');

    const agentKey = (agent.agentType || agent.id || '').toLowerCase();
    const target = HEADER_AGENT_TAB_MAP[agentKey];
    if (!target) return;

    setSelectedAgent(target.selectedAgent);

    const existingTab = tabsRef.current.find(t => t.type === target.tabType);
    if (existingTab) {
      await switchTab(existingTab.id);
      return;
    }

    await addTab(
      target.tabType,
      getTabLabel(target.tabType) || agent.name || 'Agent',
      true,
      false
    );
  }, [addTab, switchTab, setChatViewMode, setSelectedAgent]);

  return {
    tabs,
    setTabs,
    activeTab,
    setActiveTab,
    tabsLoaded,
    setTabsLoaded,
    tabData,
    setTabData,
    addTab,
    switchTab,
    removeTab,
    handleAddTabFromButton,
    handleHeaderAgentClick,
    highlightedTabId,
    triggerTabHighlight,
    actionUpdates,
    setActionUpdates,
    liveSignals,
    setLiveSignals,
    addActionUpdate,
    addLiveSignal,
  };
}
