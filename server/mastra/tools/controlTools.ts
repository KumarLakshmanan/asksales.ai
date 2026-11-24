/**
 * Mastra Control-Flow Tools
 * Non-executor tools that affect agent routing and pipeline state.
 * These are "virtual" tools — their output is interpreted by the orchestrator,
 * not by an external executor.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const suggestSwitchAgentsTool = createTool({
  id: 'suggest_switch_agents',
  description:
    'Suggest switching to one or more other agents when the current agent cannot proceed due to missing prerequisites. Shows action buttons to the user.',
  inputSchema: z.object({
    message: z
      .string()
      .describe(
        'A helpful, conversational message explaining why the current agent cannot proceed and what the user needs to do next',
      ),
    primary_agent: z
      .enum(['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'])
      .describe('The most important agent to route to'),
    alternative_agents: z
      .array(
        z.enum(['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing']),
      )
      .optional()
      .describe('Optional additional agents the user could choose instead'),
    reason: z
      .string()
      .describe(
        'Technical reason why the current agent cannot proceed without the primary_agent running first',
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    toolName: z.literal('suggest_switch_agents'),
    output: z.any(),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input: any) => {
    return {
      success: true,
      toolName: 'suggest_switch_agents' as const,
      output: {
        message: input.message,
        primary_agent: input.primary_agent,
        alternative_agents: input.alternative_agents ?? [],
        reason: input.reason,
      },
    };
  },
});

export const tasksCompletedTool = createTool({
  id: 'tasks_completed',
  description:
    'Signal that all assigned tasks have been completed successfully. Use this ONLY after ALL tools have been executed and results presented to the user.',
  inputSchema: z.object({
    summary: z.string().describe('A brief summary of what was accomplished by this agent'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    toolName: z.literal('tasks_completed'),
    output: z.object({ summary: z.string() }),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input: any) => {
    return {
      success: true,
      toolName: 'tasks_completed' as const,
      output: { summary: input.summary },
    };
  },
});
