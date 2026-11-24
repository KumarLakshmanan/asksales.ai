import { describe, expect, it } from 'vitest';
import {
  dedupeSingletonConversationTabs,
  toConversationTabReplacement,
} from '@/lib/conversationResultTabs';

describe('conversation result tab recovery', () => {
  it('keeps the active copy of a singleton result panel', () => {
    const tabs = dedupeSingletonConversationTabs([
      { tabId: 'overview-1', tabType: 'overview' },
      { tabId: 'leads-stale', tabType: 'leads' },
      { tabId: 'leads-active', tabType: 'leads', isActive: true },
    ]);

    expect(tabs.map((tab) => tab.tabId)).toEqual(['overview-1', 'leads-active']);
  });

  it('preserves intentionally repeatable search panels', () => {
    const tabs = dedupeSingletonConversationTabs([
      { tabId: 'search-1', tabType: 'search' },
      { tabId: 'search-2', tabType: 'search', isActive: true },
    ]);

    expect(tabs).toHaveLength(2);
  });

  it('strips read-only fields from the strict tab replacement payload', () => {
    const tabs = toConversationTabReplacement([{
      id: 72,
      threadId: 179,
      tabId: 'leads-active',
      tabType: 'leads',
      tabLabel: 'Leads',
      tabOrder: 9,
      isActive: true,
      tabData: { source: 'facebook' },
      createdAt: '2026-08-31T09:00:00.000Z',
    }]);

    expect(tabs).toEqual([{
      tabId: 'leads-active',
      tabType: 'leads',
      tabLabel: 'Leads',
      tabOrder: 0,
      isActive: true,
      tabData: { source: 'facebook' },
    }]);
  });
});
