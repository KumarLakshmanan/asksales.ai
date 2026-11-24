import { describe, expect, it } from '@jest/globals';
import { mapLegacyContentRequest } from '../services/content/LegacyContentGenerationAdapter.js';

describe('legacy content generation compatibility', () => {
  it('maps legacy audience, topic and tone into the canonical email contract', () => {
    expect(mapLegacyContentRequest({ content_type: 'email', topic: 'A factual update', icp_id: 12, thread_id: 20, tone: 'friendly' })).toEqual({
      supported: true, type: 'email', body: { prompt: 'A factual update', icpId: 12, threadId: 20, tone: 'friendly' },
    });
  });
  it('preserves canonical editorial and scoped brand fields for blog drafts', () => {
    const mapped = mapLegacyContentRequest({ type: 'blog', prompt: 'Write an outline', stage: 'outline', businessProfileId: 3, brandToolkitId: 4, editorial: { focusKeyword: 'service' } });
    expect(mapped).toMatchObject({ supported: true, type: 'blog', body: { stage: 'outline', businessProfileId: 3, brandToolkitId: 4, editorial: { focusKeyword: 'service' } } });
  });
  it('maps social tone without enabling optional image/video generation', () => {
    const mapped = mapLegacyContentRequest({ content_type: 'social_post', topic: 'A factual update', tone: 'neutral' });
    expect(mapped).toEqual({ supported: true, type: 'social', body: { prompt: 'A factual update\nRequested tone: neutral', platform: 'linkedin' } });
  });
  it.each(['whitepaper', 'case_study', 'video_script'])('retires unsupported %s without promoting it to paid media', type => {
    expect(mapLegacyContentRequest({ type, prompt: 'A factual update' })).toEqual({ supported: false, type });
  });
  it('supports explicit video as a saved canonical asset request', () => {
    expect(mapLegacyContentRequest({ type: 'video', prompt: 'A short factual video' })).toMatchObject({ supported: true, type: 'video', body: { saveToAssets: true } });
  });
  it.each([
    { type: 'email', prompt: 'A'.repeat(20001) },
    { type: 'email', topic: 'A', icp_id: 1, icpId: 2 },
    { type: 'email', prompt: 'A', content_type: 'blog' },
    { type: 'video', prompt: 'A'.repeat(4001) },
    { type: 'social_post', topic: 'A', platform: 'unsupported' },
    { type: 'email', topic: 'A', unknownOption: 'ignored by old handler' },
    { type: 'email', topic: 'A', persist: 'false' },
  ])('rejects invalid or ambiguous mapped input %# before provider dispatch', input => {
    expect(() => mapLegacyContentRequest(input)).toThrow();
  });
});
