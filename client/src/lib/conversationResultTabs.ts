export interface PersistedConversationTab {
  tabId: string;
  tabType: string;
  isActive?: boolean;
}

export interface ReplaceableConversationTab extends PersistedConversationTab {
  tabLabel: string;
  tabOrder: number;
  tabData?: Record<string, unknown>;
}

const SINGLETON_RESULT_TAB_TYPES = new Set([
  'overview',
  'icp',
  'agentchoose',
  'lead-inputs',
  'leads',
  'outreach',
  'analytics',
  'campaigns',
  'ads',
  'leadconfig',
  'content-studio',
  'performancemarketing',
  'crm',
  'support',
  'proposals',
]);

/**
 * Collapse duplicate durable singleton panels while preserving the active copy.
 * Search and generated-content panels intentionally remain repeatable.
 */
export function dedupeSingletonConversationTabs<T extends PersistedConversationTab>(tabs: T[]): T[] {
  const chosenByType = new Map<string, T>();

  for (const tab of tabs) {
    if (!SINGLETON_RESULT_TAB_TYPES.has(tab.tabType)) continue;
    const existing = chosenByType.get(tab.tabType);
    if (!existing || (!existing.isActive && tab.isActive)) {
      chosenByType.set(tab.tabType, tab);
    }
  }

  return tabs.filter((tab) => (
    !SINGLETON_RESULT_TAB_TYPES.has(tab.tabType)
    || chosenByType.get(tab.tabType)?.tabId === tab.tabId
  ));
}

/**
 * Build the strict replacement API payload without leaking read-only database
 * fields returned by the tab list endpoint.
 */
export function toConversationTabReplacement<T extends ReplaceableConversationTab>(
  tabs: T[],
): ReplaceableConversationTab[] {
  return tabs.map((tab, index) => ({
    tabId: tab.tabId,
    tabType: tab.tabType,
    tabLabel: tab.tabLabel,
    tabOrder: index,
    isActive: Boolean(tab.isActive),
    tabData: tab.tabData || {},
  }));
}
