import { describe, expect, it } from 'vitest';
import { supportWidgetEmbedScriptUrl } from '@/lib/support-widget-embed';

describe('portable support widget script snippet', () => {
  it('uses asksales.ai instead of the embedding customer’s domain when production API configuration is empty', () => {
    expect(supportWidgetEmbedScriptUrl('', 'https://asksales.ai', 'test-key'))
      .toBe('https://asksales.ai/api/support-widget/embed.js?token=test-key');
  });
  it('preserves an explicitly configured separate API origin for local UI testing', () => {
    expect(supportWidgetEmbedScriptUrl('http://localhost:8080', 'http://localhost:3000', 'test-key'))
      .toBe('http://localhost:8080/api/support-widget/embed.js?token=test-key');
  });
  it('normalizes a same-origin API prefix without duplicating /api and encodes keys', () => {
    expect(supportWidgetEmbedScriptUrl('/api', 'https://asksales.ai', 'a&b'))
      .toBe('https://asksales.ai/api/support-widget/embed.js?token=a%26b');
  });
});
