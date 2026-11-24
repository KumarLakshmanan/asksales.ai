import { describe, expect, it } from '@jest/globals';
import { enforceAdRequestConstraints, removeAmbiguousSavedCampaignSelection } from '../mastra/utils/adRequestConstraints.js';
import { intentWith, semanticRequest } from './helpers/semanticIntent.js';

describe('model-derived ad constraints', () => {
  const context = (request: Parameters<typeof intentWith>[0] = {}) => ({ userId: 7, threadId: 42, intentAnalysis: intentWith(request) });
  const messages = [{ role: 'user', content: 'காட்சி இல்லாமல் மூன்று வடிவங்கள்' }];
  it('preserves exact model-resolved variation count and media choices', () => {
    expect(enforceAdRequestConstraints('generate_ad', { number_of_variations: 1, auto_generate_image: true }, messages,
      context({ generation: { image: false, video: false, format: 'text', variationCount: 3, length: null, exactCta: null } })))
      .toMatchObject({ number_of_variations: 3, auto_generate_image: false, auto_generate_video: false, ad_format: 'text' });
  });
  it('inherits only the exact active review when the model identifies a follow-up', () => {
    const c = { ...context({ taskRelation: 'follow_up', generationReviewId: 9 }),
      savedToolActions: [{ widgetId: 9, toolName: 'generate_ad', status: 'draft',
        formValues: { number_of_variations: 3, ad_format: 'text', auto_generate_image: false } }] };
    expect(enforceAdRequestConstraints('generate_ad', { number_of_variations: 1 }, messages, c))
      .toMatchObject({ number_of_variations: 3, ad_format: 'text', auto_generate_image: false });
  });
  it('binds a single semantic campaign selection without treating a model fingerprint as approval', () => {
    expect(enforceAdRequestConstraints('publish_ads', { campaign_id: 'old', asset_ids: [8], review_revision: 'fake' }, messages,
      context({ paidCampaignSelection: { kind: 'single', campaignIds: ['42'], platforms: ['google'] } })))
      .toEqual({ campaign_id: '42', platforms: ['google'] });
  });
  it.each(['multiple', 'ambiguous'] as const)('does not collapse %s selection to one campaign', kind => {
    expect(removeAmbiguousSavedCampaignSelection({ campaign_id: '42', asset_ids: [8], review_revision: 'fake' }, messages, 2,
      context({ paidCampaignSelection: { kind, campaignIds: ['42', '43'], platforms: null } }))).toEqual({});
  });
  it('removes inherited campaign identity for a new named campaign needing lookup', () => {
    expect(enforceAdRequestConstraints('publish_ads', { campaign_id: '42' }, messages,
      context({ taskRelation: 'new' }))).toEqual({});
  });
  it('does not discard independently selected assets for a new campaign', () => {
    expect(enforceAdRequestConstraints('publish_ads', { campaign_id: 'old', asset_ids: [8] }, messages,
      context({ taskRelation: 'new' }))).toEqual({ asset_ids: [8] });
  });
  it('preserves an explicit empty platform selection instead of guessing a channel', () => {
    expect(enforceAdRequestConstraints('publish_ads', { platforms: ['meta'] }, messages,
      context({ paidCampaignSelection: { kind: 'unspecified', campaignIds: [], platforms: [] } }))).toEqual({ platforms: [] });
  });
  it('does not infer platform/count changes from quoted words without semantic constraints', () => {
    const args = { number_of_variations: 2, ad_format: 'image' };
    expect(enforceAdRequestConstraints('generate_ad', args, [{ role: 'user', content: 'Explain three ad variations without images' }],
      context({ generation: semanticRequest().generation }))).toEqual(args);
  });
});
