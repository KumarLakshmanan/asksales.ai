/**
 * Mastra ICP Tools
 * Wraps existing ICP executor functions as Mastra createTool instances.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * Tool result schema shared across all tools
 */
const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  approvalData: z.any().optional(),
  executionId: z.string().optional(),
  durationMs: z.number().optional(),
});

export const generateIcpTool = createTool({
  id: 'generate_icp',
  description: 'Generate an Ideal Customer Profile (ICP) based on user requirements. Use this when the user wants to define their target audience or start a new campaign.',
  inputSchema: z.object({
    user_message: z.string().describe("The user's message containing campaign requirements or target audience details."),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateIcp } = await import('./executors/icpExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    return executeGenerateIcp(input, toolContext);
  },
});

export const saveBusinessProfileTool = createTool({
  id: 'save_business_profile',
  description: 'Save business profile information provided by the user during conversation.',
  inputSchema: z.object({
    company_name: z.string().describe("The company/business name"),
    industry: z.string().optional().describe("Industry the company operates in"),
    city: z.string().optional().describe("City/location of the company"),
    country: z.string().optional().describe("Country of the company"),
    description: z.string().optional().describe("Brief description of what the company does"),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeSaveBusinessProfile } = await import('./executors/icpExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    return executeSaveBusinessProfile(input, toolContext);
  },
});

export const crawlWebsiteTool = createTool({
  id: 'crawl_website',
  description: 'Crawl a website URL to extract comprehensive business information from multiple pages. After crawling, the ICP agent should IMMEDIATELY use the data to generate an ICP profile.',
  inputSchema: z.object({
    url: z.string().describe('The website URL to crawl (e.g., https://example.com)'),
    extract_focus: z.string().optional().describe('Optional focus area for extraction'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeCrawlWebsite } = await import('./executors/icpExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    return executeCrawlWebsite(input, toolContext);
  },
});
