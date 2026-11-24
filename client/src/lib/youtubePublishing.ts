import type { SocialPublishingAsset } from './socialPublishing';

export type YouTubeReviewSettings = {
  privacyStatus: 'private' | 'unlisted' | 'public';
  tags: string;
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  categoryId?: string;
  defaultLanguage?: string;
  license?: 'youtube' | 'creativeCommon';
  thumbnailUrl?: string;
  playlistId?: string;
  chapters?: Array<{ startSeconds: number; title: string }>;
};

export const YOUTUBE_SCHEDULE_HELP = 'YouTube upload starts at the scheduled time. Processing can finish later. The selected visibility is retained: private and unlisted uploads do not automatically become public.';

export function youtubeTags(value: string): string[] {
  return [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))];
}

export function youtubeReviewError(value: YouTubeReviewSettings): string | null {
  if (typeof value.madeForKids !== 'boolean') return 'Choose whether this YouTube video is made for kids.';
  if (typeof value.containsSyntheticMedia !== 'boolean') return 'Review the altered or synthetic content disclosure for YouTube.';
  const tags = youtubeTags(value.tags);
  if (value.thumbnailUrl && !/^https:\/\//i.test(value.thumbnailUrl)) return 'YouTube thumbnails must use an HTTPS image URL.';
  if (value.defaultLanguage && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/i.test(value.defaultLanguage)) return 'Use a language code such as en or en-IN.';
  if (value.chapters?.length) {
    if (value.chapters.length < 3 || value.chapters[0].startSeconds !== 0) return 'Chapters need at least three entries, starting at 0:00.';
    if (value.chapters.some((chapter, index) => !Number.isInteger(chapter.startSeconds) || !chapter.title.trim() || chapter.title.length > 100 || (index > 0 && chapter.startSeconds - value.chapters![index - 1].startSeconds < 10))) return 'Each chapter needs a title and must start at least ten seconds after the previous chapter.';
  }
  if (tags.join(',').length + tags.filter(tag => /\s/.test(tag)).length * 2 > 500) return 'YouTube tags must total 500 characters or fewer, including separators and quoted spaces.';
  return null;
}

export function youtubeReviewFromAsset(asset: SocialPublishingAsset): YouTubeReviewSettings {
  let content: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(asset.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
  } catch { /* Direct media URLs have no publication settings. */ }
  const snapshot = asset.metadata?.reviewedPublishSnapshot;
  const reviewed = snapshot && typeof snapshot === 'object' && 'platform' in snapshot && snapshot.platform === 'youtube'
    ? snapshot as Record<string, unknown> : {};
  const values = { ...asset.metadata, ...content, ...reviewed };
  const options = values.youtubeOptions && typeof values.youtubeOptions === 'object' ? values.youtubeOptions as Record<string, unknown> : {};
  return {
    privacyStatus: values.privacyStatus === 'public' || values.privacyStatus === 'unlisted' ? values.privacyStatus : 'private',
    tags: Array.isArray(values.tags) ? values.tags.filter((tag): tag is string => typeof tag === 'string').join(', ') : '',
    madeForKids: typeof options.madeForKids === 'boolean' ? options.madeForKids : undefined,
    containsSyntheticMedia: typeof options.containsSyntheticMedia === 'boolean' ? options.containsSyntheticMedia : undefined,
    categoryId: typeof options.categoryId === 'string' ? options.categoryId : undefined,
    defaultLanguage: typeof options.defaultLanguage === 'string' ? options.defaultLanguage : undefined,
    license: options.license === 'youtube' || options.license === 'creativeCommon' ? options.license : undefined,
    thumbnailUrl: typeof options.thumbnailUrl === 'string' ? options.thumbnailUrl : undefined,
    playlistId: typeof options.playlistId === 'string' ? options.playlistId : undefined,
    chapters: Array.isArray(options.chapters) ? options.chapters as YouTubeReviewSettings['chapters'] : undefined,
  };
}

export function youtubeOptions(value: YouTubeReviewSettings) {
  const { privacyStatus: _privacy, tags: _tags, ...options } = value;
  return options;
}

export function youtubeDescriptionPreview(description: string, chapters?: YouTubeReviewSettings['chapters']): string {
  if (!chapters?.length) return description;
  const lines = chapters.map(chapter => {
    const seconds = chapter.startSeconds;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const timestamp = hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
    return `${timestamp} ${chapter.title}`;
  });
  const block = lines.join('\n');
  const text = description.trim();
  if (text === block || text.endsWith(`\n\n${block}`)) return text;
  return `${text}\n\n${block}`.trim();
}
