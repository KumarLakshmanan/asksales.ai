import { describe, expect, it } from '@jest/globals';
import {
  chatTabParamSchema,
  chatTabThreadParamSchema,
  chatTabsActiveSchema,
  saveChatTabSchema,
} from '../middleware/schemas.js';

describe('Conversation Builder tab persistence contract', () => {
  it('persists the campaign WhatsApp result pane and its saved asset receipt', () => {
    expect(saveChatTabSchema.parse({ tabId: 'content-whatsapp-1', tabType: 'content-whatsapp', tabLabel: 'WhatsApp', tabData: { type: 'whatsapp', assetId: 280 } })).toMatchObject({ tabType: 'content-whatsapp', tabData: { assetId: 280 } });
  });
  it('normalizes a strict tenant-thread route and bounded tab payload', () => {
    expect(chatTabParamSchema.parse({ id: '42', tabId: 'analytics-1' })).toEqual({
      id: 42,
      tabId: 'analytics-1',
    });
    expect(saveChatTabSchema.parse({
      tabId: 'analytics-1',
      tabType: 'analytics',
      tabLabel: 'Analytics',
      tabOrder: 0,
      isActive: true,
      tabData: { visualizations: [{ type: 'kpi', value: 12 }] },
    }).tabData).toEqual({ visualizations: [{ type: 'kpi', value: 12 }] });
  });

  it('rejects oversized persisted results and overlong active IDs', () => {
    expect(() => saveChatTabSchema.parse({
      tabId: 'analytics-1',
      tabType: 'analytics',
      tabLabel: 'Analytics',
      tabData: { payload: 'x'.repeat(200_001) },
    })).toThrow(/200 KB/);
    expect(() => chatTabsActiveSchema.parse({ activeTabId: 'x'.repeat(101) })).toThrow();
  });

  it('rejects unsafe or non-positive thread route IDs', () => {
    expect(chatTabThreadParamSchema.safeParse({ id: '0' }).success).toBe(false);
    expect(chatTabThreadParamSchema.safeParse({ id: '99999999999999999999' }).success).toBe(false);
  });
});
