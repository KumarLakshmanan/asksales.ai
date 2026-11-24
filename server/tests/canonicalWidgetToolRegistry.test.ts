import { describe, expect, it } from '@jest/globals';
import { toolToWidgetType } from '../shared/toolWidgetMap.js';
import {
  assertCanonicalWidgetRegistryComplete,
  canonicalWidgetToolNames,
  canonicalWidgetTools,
  validateCanonicalWidgetToolInput,
} from '../mastra/tools/canonicalToolRegistry.js';

describe('canonical widget tool registry', () => {
  it('preserves exact blog CTA and reviewed writing requirements through validation', () => {
    expect(validateCanonicalWidgetToolInput('generate_blog_post', { topic: 'NimbusFlow', cta_text: 'Book a demo—no pressure.', content_instructions: 'Fictional product only.' })).toEqual(expect.objectContaining({ cta_text: 'Book a demo—no pressure.', content_instructions: 'Fictional product only.' }));
  });
  it('has exactly one canonical Mastra implementation for every mapped widget tool', () => {
    expect(() => assertCanonicalWidgetRegistryComplete()).not.toThrow();
    expect(canonicalWidgetToolNames).toHaveLength(24);
    expect(canonicalWidgetToolNames).toContain('stop_ads');
    expect([...canonicalWidgetToolNames].sort()).toEqual(Object.keys(toolToWidgetType).sort());
    expect(canonicalWidgetToolNames).toContain('publish_google_ads');
  });

  it.each(Object.keys(toolToWidgetType))('%s exposes an executable tool and input schema', (toolName) => {
    const tool = canonicalWidgetTools[toolName];
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe('function');
    expect(tool.inputSchema || tool.schema).toBeDefined();
  });

  it('accepts the exact ad-generation values rendered by the widget', () => {
    expect(() => validateCanonicalWidgetToolInput('generate_ad', { platform: 'meta', cta_type: 'traffic' })).toThrow();
    expect(validateCanonicalWidgetToolInput('generate_ad', { platform: 'meta', cta_type: 'learn_more', cta_text: 'Ask for a workflow review.', content_instructions: 'No emoji', include_image_prompt: false })).toEqual(expect.objectContaining({ cta_text: 'Ask for a workflow review.', content_instructions: 'No emoji', include_image_prompt: false }));
    expect(validateCanonicalWidgetToolInput('generate_ad', {
      platform: 'meta', objective: 'traffic', ad_format: 'image', tone: 'bold',
      auto_generate_image: false, auto_generate_video: false,
    })).toEqual(expect.objectContaining({
      platform: 'meta', objective: 'traffic', ad_format: 'image', tone: 'bold',
      auto_generate_image: false, auto_generate_video: false,
    }));
    expect(() => validateCanonicalWidgetToolInput('generate_ad', {
      platform: 'meta', objective: 'Drive lots of traffic',
    })).toThrow();
  });

  it('supports the same saved-asset campaign contract for Meta and Google', () => {
    const values = {
      asset_ids: [41, 42],
      campaign_name: 'Launch',
      objective: 'leads',
      budget_amount_minor: 5000,
      currency: 'USD',
      budget_type: 'lifetime',
      landing_url: 'https://example.com/launch',
    };
    expect(validateCanonicalWidgetToolInput('publish_meta_ads', values)).toEqual(expect.objectContaining(values));
    expect(validateCanonicalWidgetToolInput('publish_google_ads', values)).toEqual(expect.objectContaining(values));
    expect(validateCanonicalWidgetToolInput('publish_ads', {
      ...values,
      platforms: ['meta', 'google'],
      provider_account_ids: { meta: 'act_123', google: 'customers/456' },
      creative_revision: 3,
      locations: [{ countryCode: 'US' }],
    })).toEqual(expect.objectContaining({
      ...values,
      platforms: ['meta', 'google'],
      provider_account_ids: { meta: 'act_123', google: 'customers/456' },
      creative_revision: 3,
      locations: [{ countryCode: 'US' }],
    }));
  });

  it('rejects empty outreach recipient selections and accepts an optional schedule', () => {
    expect(() => validateCanonicalWidgetToolInput('send_outreach_messages', {
      lead_ids: [], channel: 'email', body: 'Hello',
    })).toThrow();
    expect(validateCanonicalWidgetToolInput('send_outreach_messages', {
      lead_ids: [7], channel: 'email', body: 'Hello', scheduled_for: '2026-09-01T10:00:00.000Z',
    })).toEqual(expect.objectContaining({ lead_ids: [7], scheduled_for: '2026-09-01T10:00:00.000Z' }));
  });
  it('preserves reviewed outreach steps and rejects a card with unreviewed edits', () => {
    const outreach_review = { creationVersion: 1, channel: 'whatsapp', followUpSource: 'outreach', messages: [{ leadId: 7, followUps: [{ delayMinutes: 90, templateName: 'check_in', message: 'Hello Ada' }] }] };
    const input = { lead_ids: [7], channel: 'whatsapp', body: '', outreach_review };
    expect(validateCanonicalWidgetToolInput('send_outreach_messages', input)).toEqual(expect.objectContaining({ outreach_review }));
    expect(() => validateCanonicalWidgetToolInput('send_outreach_messages', { ...input, _review_validation_error: 'Review the updated delay.' })).toThrow('Review the updated delay.');
  });
});
