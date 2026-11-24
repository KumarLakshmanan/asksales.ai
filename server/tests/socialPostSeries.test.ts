/** A multi-post plan is validated post by post against the platform limit,
 * never as one caption (tester report: "2,200-character limit exceeded" for a
 * 30-day Instagram plan). */
import { describe, expect, it, jest } from '@jest/globals';
import {
  ContentComplianceError,
  socialCharacterLimit,
  validateGeneratedContent,
} from '../services/content/ContentComplianceService.js';
import type { ResolvedContentBrandContext } from '../services/content/ContentBrandContextService.js';
import {
  MAX_SERIES_POSTS,
  SERIES_BATCH_SIZE,
  generateSocialPostSeries,
  postsFromResponse,
  seriesPostCount,
  validatedSocialPost,
  type SocialPost,
} from '../services/content/SocialPostSeries.js';

const context = {
  businessProfile: { id: 10, userId: 7, version: 1, isApproved: true, website: 'https://acme.example', restrictions: '' },
  brandToolkit: { id: 20, userId: 7, name: 'Acme', voiceDonts: [], isDefault: true, isActive: true, isApproved: true, version: 1, createdAt: new Date(), updatedAt: new Date() },
  provenance: { schemaVersion: 1, resolvedAt: new Date().toISOString(), userId: 7 },
} as unknown as ResolvedContentBrandContext;

const post = (day: number, length = 400) => ({ day, title: `Day ${day} idea`, caption: `Day ${day}: ${'x'.repeat(length)}`, hashtags: ['acme', 'growth'], keywords: [] });
const rules = (platform: string) => ({
  finalize: (value: SocialPost) => value,
  validate: (value: SocialPost) => validateGeneratedContent({ type: 'social', output: value, context, platform }),
});

describe('per-post platform limits', () => {
  it('names the limit and the fix in plain words', () => {
    expect(() => validateGeneratedContent({ type: 'social', platform: 'instagram', context, output: { caption: 'a'.repeat(2300), hashtags: [] } }))
      .toThrow(/Instagram post exceeds the 2,200-character limit: it is 2,300 characters .* split it into separate posts/);
    expect(() => validateGeneratedContent({ type: 'social', platform: 'twitter', context, output: { caption: 'a'.repeat(300), hashtags: [] } }))
      .toThrow(/X \(Twitter\) post exceeds the 280-character limit/);
  });

  it('exposes the per-post limit for each platform', () => {
    expect(socialCharacterLimit('social', 'instagram')).toBe(2200);
    expect(socialCharacterLimit('social', 'twitter')).toBe(280);
    expect(socialCharacterLimit('social', 'linkedin')).toBe(3000);
    expect(socialCharacterLimit('social_message', 'instagram')).toBe(1000);
  });
});

describe('a 30-day Instagram plan', () => {
  it('generates 30 separate posts in bounded batches, each under 2,200 characters, although the plan as a whole is far longer', async () => {
    const requestBatch = jest.fn(async (start: number, size: number) => ({ posts: Array.from({ length: size }, (_, i) => post(start + i + 1)) }));
    const repairPost = jest.fn(async (value: SocialPost) => value);
    const progress: number[] = [];
    const results = await generateSocialPostSeries(30, { ...rules('instagram'), requestBatch, repairPost, onProgress: done => progress.push(done) });

    expect(results).toHaveLength(30);
    expect(results.every(result => result.post && !result.error)).toBe(true);
    expect(results.map(result => result.number)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const combined = results.map(result => result.post!.caption).join('\n\n');
    expect(combined.length).toBeGreaterThan(2200);
    expect(requestBatch).toHaveBeenCalledTimes(Math.ceil(30 / SERIES_BATCH_SIZE));
    expect(repairPost).not.toHaveBeenCalled();
    expect(progress.at(-1)).toBe(30);
  });

  it('shortens only the post that is too long, and reports one that still fails without dropping the rest', async () => {
    const requestBatch = jest.fn(async (start: number, size: number) => ({
      posts: Array.from({ length: size }, (_, i) => post(start + i + 1, start + i + 1 === 2 || start + i + 1 === 3 ? 2500 : 300)),
    }));
    const repairPost = jest.fn(async (value: SocialPost) => value.day === 2 ? { ...value, caption: 'Day 2: short and sweet' } : value);
    const results = await generateSocialPostSeries(4, { ...rules('instagram'), requestBatch, repairPost });

    expect(repairPost).toHaveBeenCalledTimes(2);
    expect(results[1].post?.caption).toBe('Day 2: short and sweet');
    expect(results[2].post).toBeUndefined();
    expect(results[2].error).toMatch(/exceeds the 2,200-character limit/);
    expect(results.filter(result => result.post)).toHaveLength(3);
  });

  it('keeps earlier batches when a later provider call fails', async () => {
    const requestBatch = jest.fn(async (start: number, size: number) => {
      if (start > 0) throw new Error('timeout');
      return { posts: Array.from({ length: size }, (_, i) => post(i + 1)) };
    });
    const results = await generateSocialPostSeries(SERIES_BATCH_SIZE + 2, { ...rules('instagram'), requestBatch, repairPost: async value => value });
    expect(results.slice(0, SERIES_BATCH_SIZE).every(result => result.post)).toBe(true);
    expect(results.slice(SERIES_BATCH_SIZE).every(result => /did not return this post/.test(result.error || ''))).toBe(true);
  });

  it('reports posts the provider left out', async () => {
    const results = await generateSocialPostSeries(3, { ...rules('instagram'), requestBatch: async () => ({ posts: [post(1)] }), repairPost: async value => value });
    expect(results.map(result => Boolean(result.post))).toEqual([true, false, false]);
    expect(results[1].error).toMatch(/fewer posts/);
  });
});

describe('series helpers', () => {
  it('bounds the requested post count', () => {
    expect(seriesPostCount(undefined)).toBe(1);
    expect(seriesPostCount(0)).toBe(1);
    expect(seriesPostCount(7.6)).toBe(7);
    expect(seriesPostCount(90)).toBe(MAX_SERIES_POSTS);
  });
  it('reads common response shapes', () => {
    expect(postsFromResponse({ posts: [1, 2] })).toEqual([1, 2]);
    expect(postsFromResponse([1])).toEqual([1]);
    expect(postsFromResponse({ caption: 'one' })).toEqual([{ caption: 'one' }]);
    expect(postsFromResponse('nope')).toEqual([]);
  });
  it('a single over-limit post gets one rewrite, then a clear failure', async () => {
    const tooLong = post(1, 2600);
    const fixed = await validatedSocialPost(tooLong, { ...rules('instagram'), repairPost: async () => ({ ...tooLong, caption: 'Short.' }) });
    expect(fixed.post?.caption).toBe('Short.');
    const failed = await validatedSocialPost(tooLong, { ...rules('instagram'), repairPost: async () => { throw new ContentComplianceError(['Automatic shortening was unavailable.']); } });
    expect(failed.post).toBeUndefined();
    expect(failed.problems).toEqual(['Automatic shortening was unavailable.']);
  });
});
