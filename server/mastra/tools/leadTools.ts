/**
 * Mastra Lead Generation Tools
 * Wraps existing lead executor functions as Mastra createTool instances.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { resolveWorkflowRecommendationRequirements } from './executors/leadRequestConstraints.js';

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

export const listAvailableWorkflowsTool = createTool({
  id: 'list_available_workflows',
  description: 'List lead extraction strategies for each requested channel/platform. By default recommends the best match; set show_all to true to return every available strategy.',
  inputSchema: z.object({
    platforms: z.array(z.string()).describe('Target platforms/channels to list strategies for'),
    user_requirements: z.string().optional().describe('Optional user request or lead criteria'),
    show_all: z.boolean().optional().describe('If true, return ALL strategies per channel instead of just the best match'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;

    const { noLeadProviderForChannels } = await import('./executors/leadExecutor.js');
    if (await noLeadProviderForChannels(Number(toolContext?.userId) || undefined, input.platforms)) {
      const { LEAD_PROVIDER_UNAVAILABLE_MESSAGE } = await import('../../services/apifyCredentialResolver.js');
      return {
        success: false,
        toolName: 'list_available_workflows',
        error: LEAD_PROVIDER_UNAVAILABLE_MESSAGE,
        output: { status: 'provider_not_connected', message: LEAD_PROVIDER_UNAVAILABLE_MESSAGE },
      };
    }

    if (input.show_all) {
      // Return ALL strategies for each channel
      const { listWorkflowsForChannels } = await import('./executors/leadExecutor.js');
      const result = await listWorkflowsForChannels(input.platforms);
      return {
        success: result.success,
        toolName: 'list_available_workflows',
        output: { allStrategies: result.workflows },
      };
    }

    // Default: recommend best match per channel
    const { recommendWorkflowsForChannels } = await import('./executors/leadExecutor.js');
    const semanticLead = toolContext?.intentAnalysis?.semanticRequest?.lead;
    const userRequirements = semanticLead
      ? semanticLead.requirements || input.user_requirements
      : resolveWorkflowRecommendationRequirements(input.user_requirements, toolContext?.conversationHistory);
    const result = await recommendWorkflowsForChannels(
      input.platforms,
      toolContext?.icpProfile,
      userRequirements,
      { userId: toolContext?.userId, threadId: toolContext?.threadId },
    );
    return {
      success: result.success,
      toolName: 'list_available_workflows',
      output: result,
    };
  },
});

export const generateLeadInputsInputSchema = z.object({
  icp_id: z.number().optional().describe('The ID of the ICP to use'),
  platforms: z.array(z.string()).min(1, 'Select at least one platform or workflow before generating lead inputs.').optional().describe('Target platforms'),
  selected_workflows: z.array(z.string()).min(1, 'Select at least one platform or workflow before generating lead inputs.').optional().describe('Explicit workflow IDs confirmed by user'),
  user_requirements: z.string().optional().describe('Specific user requirements for lead generation'),
});

export const generateLeadInputsTool = createTool({
  id: 'generate_lead_inputs',
  description: 'Generate search parameters and inputs for lead generation based on an existing ICP.',
  inputSchema: generateLeadInputsInputSchema,
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeGenerateLeadInputs } = await import('./executors/leadExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolContext = (mastra as any)?.__toolContext;
    return executeGenerateLeadInputs(input, toolContext);
  },
});

export const executeLeadWorkflowTool = createTool({
  id: 'execute_lead_workflow',
  description: 'Execute a lead generation workflow to scrape leads from platforms. Requires user approval before execution.',
  inputSchema: z.object({
    thread_id: z.number().optional().describe('Thread ID containing the lead inputs'),
    platforms: z.array(z.string()).optional().describe('Platforms to scrape leads from'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const platformsStr = input.platforms?.length ? input.platforms.join(', ') : 'configured platforms';
    return {
      success: true,
      toolName: 'execute_lead_workflow',
      requiresApproval: true,
      output: {
        requiresApproval: true,
        message: `Ready to search for leads on ${platformsStr}. This will use the Apify scraper to find real leads. Approve to proceed?`,
        args: input,
      },
    };
  },
});

export const estimateLeadSearchCostTool = createTool({
  id: 'estimate_lead_search_cost',
  description: 'Read-only. Estimate the credits and run time of the reviewed lead search from past runs of the same scraper. Use when the user asks what a search will cost or how long it takes. Never runs or approves a search.',
  inputSchema: z.object({
    result_count: z.number().int().positive().optional().describe('Number of results the reviewed search asks for, if stated'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { estimateLeadSearchCost } = await import('./executors/leadExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return estimateLeadSearchCost(input, (mastra as any)?.__toolContext);
  },
});
