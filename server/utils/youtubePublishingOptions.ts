import { z } from 'zod';

/** Shared HTTP/chat contract; reject misspelled or unsupported provider settings. */
export const youtubePublishingOptionsSchema = z.object({
  madeForKids: z.boolean().optional(),
  containsSyntheticMedia: z.boolean().optional(),
  categoryId: z.string().trim().regex(/^\d+$/, 'YouTube category must be a numeric category ID').optional(),
  defaultLanguage: z.string().trim().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/i, 'Use a language code such as en or en-US').optional(),
  license: z.enum(['youtube', 'creativeCommon']).optional(),
  thumbnailUrl: z.string().url().refine(value => value.startsWith('https://'), 'Thumbnail images must use HTTPS').optional(),
  playlistId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/, 'Enter a valid YouTube playlist ID').max(100).optional(),
  chapters: z.array(z.object({ startSeconds: z.number().int().nonnegative(), title: z.string().trim().min(1).max(100) }).strict()).min(3).max(100).optional(),
}).strict();

export type YouTubePublishingOptions = z.infer<typeof youtubePublishingOptionsSchema>;
