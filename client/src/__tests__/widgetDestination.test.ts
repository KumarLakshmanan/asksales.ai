import { describe, expect, it } from 'vitest';
import { widgetDestination } from '@/lib/widget-destination';

describe('review receipt destination', () => {
  it('links each campaign action to its status surface', () => {
    expect(widgetDestination('send_outreach_messages', { channel: 'whatsapp' })?.href).toBe('/dashboard/outreach/whatsapp');
    expect(widgetDestination('publish_social_post')?.href).toBe('/dashboard/content-calendar');
    expect(widgetDestination('publish_ads')?.href).toBe('/dashboard/ads?tab=campaigns');
    expect(widgetDestination('analytics_query')?.href).toBe('/dashboard/ads?tab=overview');
  });
});
