/**
 * Mastra Integration Status Tools
 * Wraps integration executor functions as Mastra createTool instances.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
});

export const checkIntegrationStatusTool = createTool({
  id: 'check_integration_status',
  description: 'Check whether a platform is connected. For meta_ads returns safe saved ad account/Page choices; for google_ads returns the configured customer, not all accessible accounts. Use this when the client asks which account to choose; saved choices are not live eligibility confirmation. Never treat connection as approval to publish.',
  inputSchema: z.object({
    platform: z.enum([
      'email',
      'sms',
      'whatsapp',
      'instagram',
      'facebook',
      'linkedin',
      'twitter',
      'meta_ads',
      'google_ads',
      'youtube',
    ]).describe('Platform to check integration status for'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeCheckIntegrationStatus } = await import('./executors/integrationExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeCheckIntegrationStatus(input, (mastra as any)?.__toolContext);
  },
});
