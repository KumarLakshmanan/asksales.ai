import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const scheduledPostsInput = z.object({
  scope: z.enum(['current_campaign', 'all_owned']).default('current_campaign').describe('Use all_owned only when the user explicitly requests content outside this campaign.'),
  asset_id: z.number().int().positive().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  platform: z.enum(['facebook', 'instagram', 'youtube', 'linkedin', 'twitter']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
}).strict();
export const editSavedContentInput = z.object({
  scope: z.enum(['current_campaign', 'all_owned']).default('current_campaign'),
  asset_id: z.number().int().positive(),
  expected_version: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  text_fields: z.object({
    caption: z.string().min(1).max(50000).optional(),
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(50000).optional(),
    message: z.string().min(1).max(20000).optional(),
    content: z.string().min(1).max(200000).optional(),
    excerpt: z.string().min(1).max(5000).optional(),
    headline: z.string().min(1).max(500).optional(),
    primaryText: z.string().min(1).max(5000).optional(),
    description: z.string().min(1).max(2000).optional(),
    callToAction: z.string().max(1000).optional(),
    cta: z.string().max(500).optional(),
    hashtags: z.array(z.string().max(200)).max(30).optional(),
  }).strict().optional(),
}).strict().refine(value => value.title !== undefined || Object.keys(value.text_fields || {}).length > 0, 'Supply a text change');
export const changeScheduledPostInput = z.object({
  scope: z.enum(['current_campaign', 'all_owned']).default('current_campaign'),
  asset_id: z.number().int().positive(),
  expected_version: z.number().int().positive(),
  expected_scheduled_for: z.string().datetime({ offset: true }).describe('Exact saved scheduledFor returned by query_scheduled_posts; protects against concurrent timing changes.'),
  action: z.enum(['reschedule', 'cancel']),
  scheduled_for: z.string().datetime({ offset: true }).optional(),
}).strict().refine(value => value.action === 'reschedule' ? Boolean(value.scheduled_for) : value.scheduled_for === undefined,
  'Only reschedule requires scheduled_for');
const resultSchema = z.object({ success: z.boolean(), toolName: z.string(), output: z.any().optional(), error: z.string().optional() });

export const queryScheduledPostsTool = createTool({
  id: 'query_scheduled_posts', description: 'Read owned scheduled posts with exact asset IDs, scheduled times and pagination. Use timezone-qualified date bounds for calendar questions. Includes individual publishing destinations.',
  inputSchema: scheduledPostsInput, outputSchema: resultSchema,
  execute: async (input, { mastra }: any) => {
    const { executeQueryScheduledPosts } = await import('./executors/contentManagementExecutor.js');
    return executeQueryScheduledPosts(input, mastra?.__toolContext);
  },
});
export const editSavedContentTool = createTool({
  id: 'edit_saved_content', description: 'Edit explicitly requested text on the SAME saved asset, preserving media and identity. Query the exact asset and version first. Saves a new unapproved version; never publishes. Cannot edit scheduled or active content.',
  inputSchema: editSavedContentInput, outputSchema: resultSchema,
  execute: async (input, { mastra }: any) => {
    const { executeEditSavedContent } = await import('./executors/contentManagementExecutor.js');
    return executeEditSavedContent(input, mastra?.__toolContext);
  },
});
export const changeScheduledPostTool = createTool({
  id: 'change_scheduled_post', description: 'On explicit user request, cancel or reschedule one exact owned scheduled post. Query and resolve its asset ID first; never infer an ambiguous destination. Only changes existing reviewed durable attempts, never creates or publishes a new post. Does not cancel a campaign.',
  inputSchema: changeScheduledPostInput, outputSchema: resultSchema,
  execute: async (input, { mastra }: any) => {
    const { executeChangeScheduledPost } = await import('./executors/contentManagementExecutor.js');
    return executeChangeScheduledPost(input, mastra?.__toolContext);
  },
});
