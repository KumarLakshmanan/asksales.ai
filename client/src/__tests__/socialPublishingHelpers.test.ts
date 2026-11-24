import { describe, expect, it, vi } from 'vitest';
import { captionFromSocialAsset, instagramHashtagCount, socialCaptionMeter, instagramOptionsFor, socialFormatsFor, publishingFeedback, publishingIdempotencyKey, scheduleToISOString, scheduledLocalValue } from '@/lib/socialPublishing';

describe('reviewed publishing helpers', () => {
  it('shows platform limits and counts Unicode hashtags without counting URL anchors', () => {
    expect(instagramHashtagCount('#launch #தமிழ் #one,#two https://example.com/#section')).toBe(4);
    expect(socialCaptionMeter('instagram', '#launch')).toBe('7 / 2,200 characters · 1 / 30 hashtags');
    expect(socialCaptionMeter('facebook', 'Hello')).toBe('5 / 63,206 characters');
    expect(socialCaptionMeter('youtube', '🙂')).toBe('4 / 5,000 UTF-8 bytes');
  });
  it('recovers the reviewed key after a page reload clears module memory', async () => {
    const scope = crypto.randomUUID();
    const key = publishingIdempotencyKey(scope, { caption: 'Recover this request' });
    vi.resetModules();
    const reloaded = await import('@/lib/socialPublishing');
    expect(reloaded.publishingIdempotencyKey(scope, { caption: 'Recover this request' })).toBe(key);
  });
  it('offers mixed Instagram carousels and all-image Facebook posts', () => {
    expect(socialFormatsFor('instagram', 2, 1)).toContainEqual({ value: 'carousel', label: 'Instagram carousel' });
    expect(socialFormatsFor('facebook', 3, 0)).toContainEqual({ value: 'photo', label: 'Facebook multi-photo post' });
    expect(socialFormatsFor('youtube', 1, 1).map(format => format.value)).toEqual(['video', 'short']);
    expect(socialFormatsFor('youtube', 0, 2)).toEqual([]);
  });
  it('drops stale settings that do not apply when the Instagram format changes', () => {
    const settings = { altText: 'Image description', coverUrl: 'https://example.com/cover.jpg', shareToFeed: true, locationId: '123', collaborators: ['partner'] };
    expect(instagramOptionsFor('story', settings)).toBeUndefined();
    expect(instagramOptionsFor('post', settings)).toEqual({ altText: 'Image description', locationId: '123', collaborators: ['partner'] });
    expect(instagramOptionsFor('reel', settings)).not.toHaveProperty('altText');
    expect(instagramOptionsFor('carousel', settings)).not.toHaveProperty('coverUrl');
  });
  it('assembles caption, CTA aliases and hashtags exactly once', () => {
    const asset = { id: 1, title: 'Review', content: JSON.stringify({ caption: 'Original copy #Launch', call_to_action: 'Visit https://example.com/a?q=1', hashtags: ['Launch', '#Next', 'Next'] }) };
    const caption = captionFromSocialAsset(asset);
    expect(caption).toBe('Original copy #Launch\n\nVisit https://example.com/a?q=1\n\n#Next');
    expect(captionFromSocialAsset({ ...asset, content: JSON.stringify({ caption, cta: 'Visit https://example.com/a?q=1', hashtags: ['Launch', 'Next'] }) })).toBe(caption);
    expect(captionFromSocialAsset({ ...asset, content: 'Plain text' })).toBe('Plain text');
  });
  it('reuses unchanged reviewed requests and allocates keys for changed payloads', () => {
    const scope = crypto.randomUUID();
    const first = publishingIdempotencyKey(scope, { caption: 'One', scheduledFor: '2026-10-01' });
    expect(publishingIdempotencyKey(scope, { caption: 'One', scheduledFor: '2026-10-01' })).toBe(first);
    expect(publishingIdempotencyKey(scope, { caption: 'Two', scheduledFor: '2026-10-01' })).not.toBe(first);
    expect(publishingIdempotencyKey(scope, { caption: 'One', scheduledFor: '2026-10-02' })).not.toBe(first);
    expect(publishingIdempotencyKey(scope, { caption: 'One', scheduledFor: '2026-10-01' })).toBe(first);
  });
  it.each([
    ['2026-09-10T00:00', 'Asia/Kolkata', '2026-09-09T18:30:00.000Z'],
    ['2026-01-10T00:00', 'UTC', '2026-01-10T00:00:00.000Z'],
    ['2026-03-08T03:30', 'America/New_York', '2026-03-08T07:30:00.000Z'],
    ['2026-11-01T02:30', 'America/New_York', '2026-11-01T07:30:00.000Z'],
    ['2026-09-10T00:00', 'Asia/Kathmandu', '2026-09-09T18:15:00.000Z'],
  ])('converts %s in %s and round-trips without drift', (local, timezone, iso) => {
    expect(scheduleToISOString(local, timezone)).toBe(iso);
    expect(scheduledLocalValue(iso, timezone)).toBe(local);
  });
  it.each([
    ['2026-03-08T02:30', 'America/New_York', /does not exist/],
    ['2026-11-01T01:30', 'America/New_York', /occurs twice/],
    ['2026-04-05T01:45', 'Australia/Lord_Howe', /occurs twice/],
    ['2026-02-30T12:00', 'UTC', /valid schedule/],
    ['2026-09-10T12:00', 'Invalid/Timezone', /valid timezone/],
  ])('rejects unsafe schedule %s in %s', (local, timezone, message) => {
    expect(() => scheduleToISOString(local, timezone)).toThrow(message);
  });
  it('does not label accepted or rejected requests as published', () => {
    expect(publishingFeedback({ success: false, error: 'Rejected' }, false)).toMatchObject({ accepted: false, warning: true, title: 'Publishing failed' });
    expect(publishingFeedback({ success: true, accepted: true, results: { facebook: { success: false, status: 'pending' } } }, false).title).toBe('Publishing in progress');
    expect(publishingFeedback({ success: true, scheduled: true, results: { facebook: { success: true, status: 'pending' } } }, true).title).toBe('Post scheduled');
  });
});
