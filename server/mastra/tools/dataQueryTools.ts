import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { contentAssetQuerySchema } from './contentAssetQuery.js';

const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
});

export const queryLeadsTool = createTool({
  id: 'query_leads',
  description: 'Query, search, or filter existing leads generated or saved in the database. Use this when the user asks for the list of lead names, leads with emails, phone numbers, or questions about specific leads.',
  inputSchema: z.object({
    query: z.string().optional().describe('Text query to search leads by name, company, or role. Leave blank if the user asks for all leads, lead counts, or general list of leads.'),
    scope: z.enum(['current_campaign', 'all']).optional().describe('current_campaign (default) covers leads found in this conversation. Use all when the user asks about every lead they have, e.g. "how many leads do I have in total".'),
    filters: z.object({
      platform: z.enum(['linkedin', 'google_maps', 'justdial', 'instagram', 'facebook', 'twitter', 'whatsapp', 'email']).optional().describe('Filter by platform type.'),
      status: z.string().optional().describe('Filter by lead status (e.g., new, contacted, qualified, converted, rejected).'),
      has_email: z.boolean().optional().describe('Only return leads that have an email address.'),
      has_phone: z.boolean().optional().describe('Only return leads that have a phone number.'),
      limit: z.number().optional().describe('Maximum number of leads to return (default/max 50).'),
      offset: z.number().optional().describe('Number of leads to skip.'),
    }).optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeQueryLeads } = await import('./executors/dataQueryExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeQueryLeads(input as any, toolContext);
  },
});

export const queryIcpProfilesTool = createTool({
  id: 'query_icp_profiles',
  description: 'Query existing Ideal Customer Profiles (ICPs) created by the user. Use this when the user asks about previously defined target audiences or campaign criteria.',
  inputSchema: z.object({
    query: z.string().optional().describe('Text query to search ICPs by campaign name, industry, or target audience details.'),
    filters: z.object({
      status: z.string().optional().describe('Filter by status (e.g., active, archived).'),
      limit: z.number().optional().describe('Maximum number of ICPs to return.'),
    }).optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeQueryIcpProfiles } = await import('./executors/dataQueryExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeQueryIcpProfiles(input as any, toolContext);
  },
});

export const queryContentAssetsTool = createTool({
  id: 'query_content_assets',
  description: 'Retrieve saved content and its revision. For selected assets or campaign review use assetIds with the exact IDs, not a text query. Use query only for title/body searches.',
  inputSchema: contentAssetQuerySchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeQueryContentAssets } = await import('./executors/dataQueryExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeQueryContentAssets(input as any, toolContext);
  },
});

export const queryOutreachCampaignsTool = createTool({
  id: 'query_outreach_campaigns',
  description: 'Query outreach campaigns, tracking stats, or sent message history. Use this when the user asks about active outreach campaigns, sent count, delivery stats, or sent message logs.',
  inputSchema: z.object({
    query: z.string().optional().describe('Text query to search campaigns by name or description.'),
    filters: z.object({
      status: z.string().optional().describe('Filter by campaign status (e.g., active, draft, completed).'),
      campaign_type: z.enum(['email', 'sms', 'mixed']).optional().describe('Filter by campaign type.'),
      limit: z.number().optional().describe('Maximum number of campaigns to return.'),
    }).optional(),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeQueryOutreachCampaigns } = await import('./executors/dataQueryExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeQueryOutreachCampaigns(input as any, toolContext);
  },
});
