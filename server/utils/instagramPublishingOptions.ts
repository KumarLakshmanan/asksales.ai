import { z } from 'zod';

export const instagramPublishingOptionsSchema = z.object({
  coverUrl: z.string().url().refine(value => value.startsWith('https://'), 'Cover images must use HTTPS').optional(),
  thumbOffset: z.number().finite().nonnegative().optional(),
  altText: z.string().trim().max(1000).optional(),
  locationId: z.string().trim().regex(/^\d+$/, 'Use the numeric Facebook place ID').optional(),
  collaborators: z.array(z.string().trim().regex(/^[A-Za-z0-9._]{1,30}$/, 'Use Instagram usernames without @')).max(3).optional(),
  shareToFeed: z.boolean().optional(),
}).strict();

export type InstagramPublishingOptions = z.infer<typeof instagramPublishingOptionsSchema>;
