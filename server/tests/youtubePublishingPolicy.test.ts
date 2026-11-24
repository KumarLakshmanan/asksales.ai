import {
  YouTubePublishingError,
  classifyYouTubeProcessingState,
  normalizeYouTubePostType,
  normalizeYouTubeTags,
  validateShortMetadata,
  validateYouTubePublishInput,
  validateYouTubeChapters,
  generateYouTubeChapterContent,
  validateYouTubeResumableChunkRange,
} from '../services/social/YouTubePublishingService.js';

describe('YouTube publishing policy', () => {
  const video = 'https://cdn.example.test/videos/launch.mp4';

  it('normalizes the legacy shorts spelling but refuses unsupported Community Posts', () => {
    expect(normalizeYouTubePostType('shorts')).toBe('short');
    expect(normalizeYouTubePostType('short')).toBe('short');
    expect(() => normalizeYouTubePostType('community_post'))
      .toThrow(YouTubePublishingError);
    expect(() => normalizeYouTubePostType('community_post'))
      .toThrow(/public YouTube Data API/);
  });

  it('validates required YouTube video fields before network side effects', () => {
    expect(() => validateYouTubePublishInput({ title: 'Launch', postType: 'video' }))
      .toThrow(/video URL is required/);
    expect(() => validateYouTubePublishInput({ videoUrl: video, title: '', postType: 'video' }))
      .toThrow(/title is required/);
    expect(() => validateYouTubePublishInput({ videoUrl: video, title: 'a'.repeat(101), postType: 'video' }))
      .toThrow(/100 characters/);
    expect(validateYouTubePublishInput({ videoUrl: video, title: 'Launch', postType: 'video' }))
      .toBe('video');
  });

  it('uses the current three-minute square-or-vertical Short rule whenever trusted metadata exists', () => {
    expect(() => validateShortMetadata({ durationSeconds: 181 }))
      .toThrow(/180 seconds/);
    expect(() => validateShortMetadata({ durationSeconds: 30, width: 1920, height: 1080 }))
      .toThrow(/square or vertical/);
    expect(() => validateShortMetadata({ durationSeconds: 180, width: 1080, height: 1080 }))
      .not.toThrow();
    expect(validateYouTubePublishInput({
      videoUrl: video,
      title: 'Vertical launch',
      postType: 'shorts',
      videoMetadata: { durationSeconds: 179, width: 1080, height: 1920 },
    })).toBe('short');
  });

  it('validates UTF-8 description bytes, forbidden brackets and provider tag accounting', () => {
    const base = { videoUrl: video, title: 'Valid title' };
    expect(() => validateYouTubePublishInput({ ...base, description: 'é'.repeat(2501) })).toThrow(/UTF-8 bytes/);
    expect(() => validateYouTubePublishInput({ ...base, title: 'Title <one>' })).toThrow(/cannot contain/);
    expect(() => validateYouTubePublishInput({ ...base, description: 'More > less' })).toThrow(/cannot contain/);
    expect(() => validateYouTubePublishInput({ ...base, tags: ['x'.repeat(497), 'y'] })).not.toThrow();
    expect(() => validateYouTubePublishInput({ ...base, tags: ['x'.repeat(497), 'a b'] })).toThrow(/500 characters/);
    expect(() => validateYouTubePublishInput({ ...base, postType: 'short', tags: ['x'.repeat(495)] })).toThrow(/500 characters/);
  });

  it('adds Shorts once without duplicating a user-provided tag', () => {
    expect(normalizeYouTubeTags(['product', 'Shorts', 'product'], true))
      .toEqual(['product', 'Shorts']);
    expect(normalizeYouTubeTags(['product'], true)).toEqual(['product', 'Shorts']);
  });

  it('does not call an accepted upload published until processing succeeds', () => {
    const acceptedAt = new Date('2026-08-12T00:00:00.000Z');
    expect(classifyYouTubeProcessingState({
      processingStatus: 'processing',
      uploadStatus: 'uploaded',
      failureReason: null,
    }, acceptedAt, acceptedAt.getTime() + 60_000).state).toBe('pending');
    expect(classifyYouTubeProcessingState({
      processingStatus: 'succeeded',
      uploadStatus: 'processed',
      failureReason: null,
    }, acceptedAt, acceptedAt.getTime() + 60_000).state).toBe('succeeded');
    expect(classifyYouTubeProcessingState({
      processingStatus: 'failed',
      uploadStatus: 'failed',
      failureReason: 'invalidFile',
    }, acceptedAt, acceptedAt.getTime() + 60_000)).toMatchObject({
      state: 'failed',
      code: 'YOUTUBE_PROCESSING_FAILED',
      message: 'invalidFile',
    });
    expect(classifyYouTubeProcessingState(null, acceptedAt, acceptedAt.getTime() + 25 * 60 * 60_000))
      .toMatchObject({ state: 'failed', code: 'YOUTUBE_PROCESSING_TIMEOUT' });
  });

  it('requires valid, sufficiently separated chapters and generates a portable description block', () => {
    const chapters = [
      { startSeconds: 0, title: 'Introduction' },
      { startSeconds: 10, title: 'Demo' },
      { startSeconds: 20, title: 'Next steps' },
    ];
    expect(validateYouTubeChapters(chapters)).toEqual(chapters);
    expect(generateYouTubeChapterContent('Watch the launch.', chapters)).toBe(
      'Watch the launch.\n\n0:00 Introduction\n0:10 Demo\n0:20 Next steps',
    );
    expect(() => validateYouTubeChapters([{ startSeconds: 5, title: 'Late start' }, ...chapters.slice(1)]))
      .toThrow(/start at 0:00/);
    expect(() => validateYouTubeChapters([{ startSeconds: 0, title: 'One' }, { startSeconds: 5, title: 'Two' }, { startSeconds: 20, title: 'Three' }]))
      .toThrow(/ten seconds apart/);
  });

  it('enforces private visibility for native scheduled publishing', () => {
    expect(() => validateYouTubePublishInput({
      videoUrl: video,
      title: 'Scheduled',
      privacyStatus: 'public',
      publishAt: new Date(Date.now() + 120_000).toISOString(),
    })).toThrow(/requires private visibility/);
  });

  it('binds every direct-upload chunk to the session file length and byte range', () => {
    expect(validateYouTubeResumableChunkRange('bytes 0-7/16', 8, 16))
      .toEqual({ first: 0, last: 7, total: 16 });
    // Later ranges remain valid so an upload can resume from Google's
    // durable offset after a browser or server restart.
    expect(validateYouTubeResumableChunkRange('bytes 8-15/16', 8, 16))
      .toEqual({ first: 8, last: 15, total: 16 });
    expect(() => validateYouTubeResumableChunkRange('bytes 0-7/17', 8, 16))
      .toThrow(/does not match this upload session/);
    expect(() => validateYouTubeResumableChunkRange('bytes 8-14/16', 8, 16))
      .toThrow(/does not match this upload session/);
    expect(() => validateYouTubeResumableChunkRange(`bytes 0-${16 * 1024 * 1024}/${16 * 1024 * 1024 + 1}`, 16 * 1024 * 1024 + 1, 16 * 1024 * 1024 + 1))
      .toThrow(/no larger than 16 MB/);
  });
});
