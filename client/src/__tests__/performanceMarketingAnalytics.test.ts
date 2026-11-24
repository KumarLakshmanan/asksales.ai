// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { trackPerformanceMarketingEvent } from '@/lib/performanceMarketingAnalytics';

describe('performance marketing analytics adapter', () => {
  it('emits a privacy-safe host event and mirrors it to dataLayer when present', () => {
    const listener = vi.fn();
    window.addEventListener('asksales:analytics', listener);
    window.dataLayer = [];

    trackPerformanceMarketingEvent('filter_changed', {
      workspace: 'paid_ads',
      filter: 'platform',
      value: 'meta',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      event: 'filter_changed',
      area: 'performance_marketing',
      workspace: 'paid_ads',
      filter: 'platform',
      value: 'meta',
    });
    expect(window.dataLayer).toEqual([{
      event: 'performance_marketing_filter_changed',
      workspace: 'paid_ads',
      filter: 'platform',
      value: 'meta',
    }]);

    window.removeEventListener('asksales:analytics', listener);
  });
});
