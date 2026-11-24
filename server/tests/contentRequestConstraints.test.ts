import { describe, expect, it } from '@jest/globals';
import { enforceSocialPostMediaConstraints, scopeGenerationRequest } from '../mastra/utils/contentRequestConstraints.js';
import { intentWith, semanticRequest } from './helpers/semanticIntent.js';

describe('model-derived content constraints', () => {
  const messages = [{ role: 'user', content: 'அதை சுருக்கவும்' }];
  const review = { widgetId: 9, toolName: 'generate_social_media_post', status: 'active',
    formValues: { auto_generate_image: false }, submittedValues: { auto_generate_image: true } };
  const context = () => ({ userId: 7, threadId: 42, savedToolActions: [review],
    intentAnalysis: intentWith({ taskRelation: 'follow_up', contentOperation: 'revise_review', generationReviewId: 9 }) });

  it('uses the exact model-selected owned review and its submitted values', () => {
    expect(scopeGenerationRequest(review.toolName, messages, context()).defaults).toEqual({ auto_generate_image: true });
  });
  it.each(['succeeded', 'cancelled', 'running'])('does not inherit %s reviews', status => {
    expect(scopeGenerationRequest(review.toolName, messages, { ...context(),
      savedToolActions: [{ ...review, status }] }).defaults).toEqual({});
  });
  it('rejects wrong owner, thread, tool or unresolved review rather than selecting the newest', () => {
    for (const extra of [{ userId: 8 }, { threadId: 43 }, { toolName: 'generate_ad' }, { widgetId: 99 }]) {
      expect(scopeGenerationRequest(review.toolName, messages, { ...context(),
        savedToolActions: [{ ...review, ...extra }] }).defaults).toEqual({});
    }
    expect(scopeGenerationRequest(review.toolName, messages, { ...context(), intentAnalysis: intentWith() }).defaults).toEqual({});
  });
  it('does not inherit old settings for a model-classified new task', () => {
    expect(scopeGenerationRequest(review.toolName, messages, { ...context(),
      intentAnalysis: intentWith({ taskRelation: 'new', generationReviewId: 9 }) }).defaults).toEqual({});
  });
  it('honors model text-only constraints regardless of the words or language', () => {
    const c = { ...context(), intentAnalysis: intentWith({ generation: {
      image: false, video: false, format: 'text', variationCount: null, length: null, exactCta: 'ஒரு டெமோவைப் பதிவு செய்',
    } }) };
    expect(enforceSocialPostMediaConstraints({ auto_generate_image: true, auto_generate_video: true }, messages, {}, c))
      .toMatchObject({ auto_generate_image: false, auto_generate_video: false,
        include_image_prompt: false, include_video_prompt: false, post_format: 'text', cta_text: 'ஒரு டெமோவைப் பதிவு செய்' });
  });
  it('lets explicit semantic corrections override reviewed media settings', () => {
    expect(enforceSocialPostMediaConstraints({}, messages, { auto_generate_image: false, post_format: 'text' }, {
      ...context(), intentAnalysis: intentWith({ generation: {
        ...semanticRequest().generation, image: true, format: 'image',
      } }),
    })).toMatchObject({ auto_generate_image: true, post_format: 'image' });
  });
  it('does not phrase-match user text when semantic constraints are unavailable', () => {
    const args = { auto_generate_image: true };
    expect(enforceSocialPostMediaConstraints(args, [{ role: 'user', content: 'Explain the phrase no images' }])).toEqual(args);
  });
  it('preserves reviewed length and exact CTA unless the model identifies a user change', () => {
    const defaults = { length: 'short', cta_text: 'Book a demo' };
    expect(enforceSocialPostMediaConstraints({ length: 'medium' }, messages, defaults, context()))
      .toMatchObject(defaults);
    expect(enforceSocialPostMediaConstraints({}, messages, defaults, { ...context(), intentAnalysis: intentWith({
      generation: { ...semanticRequest().generation, length: 'long', lengthIntent: 'set', exactCta: 'Contact us' },
    }) })).toMatchObject({ length: 'long', cta_text: 'Contact us' });
  });

  it.each(['preserve', 'unspecified', undefined] as const)('does not replace saved length with a model default for %s intent', lengthIntent => {
    expect(enforceSocialPostMediaConstraints({ length: 'medium' }, messages, { length: 'short' }, {
      ...context(), intentAnalysis: intentWith({ generation: {
        ...semanticRequest().generation, length: 'medium', lengthIntent,
      } }),
    }).length).toBe('short');
  });
});
