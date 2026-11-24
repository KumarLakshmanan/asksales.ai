import { describe, expect, it } from 'vitest';
import { youtubeDescriptionPreview, youtubeReviewError, youtubeReviewFromAsset, youtubeTags } from '@/lib/youtubePublishing';
import { captionFromSocialAsset, socialFormatsFor } from '@/lib/socialPublishing';

describe('YouTube reusable publishing settings', () => {
  it('previews chapters once even when reopening a saved reviewed description', () => {
    const chapters = [{ startSeconds: 0, title: 'Intro' }, { startSeconds: 30, title: 'Demo' }, { startSeconds: 90, title: 'Next steps' }];
    const description = youtubeDescriptionPreview('Overview', chapters);
    expect(description).toBe('Overview\n\n0:00 Intro\n0:30 Demo\n1:30 Next steps');
    expect(youtubeDescriptionPreview(description, chapters)).toBe(description);
  });
  it('restores draft metadata and keeps reviewed settings authoritative', () => {
    const settings = youtubeReviewFromAsset({ id: 1, title: 'Video', content: 'Description', metadata: { privacyStatus: 'public', tags: ['draft'], reviewedPublishSnapshot: { platform: 'youtube', privacyStatus: 'unlisted', tags: ['reviewed'], youtubeOptions: { madeForKids: false, containsSyntheticMedia: true, license: 'creativeCommon' } } } });
    expect(settings).toMatchObject({ privacyStatus: 'unlisted', tags: 'reviewed', madeForKids: false, containsSyntheticMedia: true, license: 'creativeCommon' });
    expect(youtubeReviewError(settings)).toBeNull();
  });
  it('requires audience/disclosure choices and counts tag separators/quotes', () => {
    expect(youtubeReviewError({ privacyStatus: 'private', tags: '' })).toMatch(/made for kids/);
    expect(youtubeTags('demo, demo, tutorial')).toEqual(['demo', 'tutorial']);
    expect(youtubeReviewError({ privacyStatus: 'private', madeForKids: false, containsSyntheticMedia: false, tags: 'a'.repeat(497) + ' b' })).toMatch(/500/);
  });
  it('only supports one video and never uses its URL as description', () => {
    expect(socialFormatsFor('youtube', 0, 1).map(format => format.value)).toEqual(['video', 'short']);
    // A post with a generated image as well uploads only its one video.
    expect(socialFormatsFor('youtube', 1, 1).map(format => format.value)).toEqual(['video', 'short']);
    expect(socialFormatsFor('youtube', 0, 2)).toEqual([]);
    expect(socialFormatsFor('youtube', 0, 0)).toEqual([]);
    expect(captionFromSocialAsset({ id: 1, title: 'Video', type: 'video', content: '/uploads/video.mp4' })).toBe('');
  });
});
