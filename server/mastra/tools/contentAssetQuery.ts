import { z } from 'zod';

export const contentAssetQuerySchema = z.object({
  scope: z.enum(['current_campaign', 'all_owned']).optional()
    .describe('Listings default to the current conversation. Use all_owned only when the user asks for content outside this campaign. Exact assetIds remain tenant-owned lookups unless current_campaign is explicit.'),
  assetIds: z.array(z.number().int().positive().safe()).min(1).max(50).optional()
    .describe('Exact saved asset IDs. Use this for a selected creative; do not search its ID as text.'),
  query: z.string().optional().describe('Search title/body text, not asset IDs.'),
  filters: z.object({
    type: z.enum(['email', 'email_template', 'sms', 'sms_template', 'social_post', 'social_dm', 'ad_copy', 'blog_post', 'image', 'video', 'general']).optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().positive().max(50).optional(),
  }).optional(),
});

export function normalizeContentAssetQuery(input: unknown) {
  const parsed = contentAssetQuerySchema.parse(input);
  // Compatibility for tool calls emitted before the explicit ID field existed.
  // Only an entire, unambiguous ID expression is accepted; prose stays prose.
  const legacyId = parsed.query?.trim().match(/^(?:assetId\s*:\s*|asset\s*#\s*)([1-9]\d*)$/i);
  const assetIds = parsed.assetIds ?? (legacyId ? [Number(legacyId[1])] : undefined);
  if (assetIds?.some(id => !Number.isSafeInteger(id))) throw new Error('Invalid content asset ID');
  return { ...parsed, assetIds: assetIds ? [...new Set(assetIds)] : undefined,
    query: legacyId ? undefined : parsed.query };
}
