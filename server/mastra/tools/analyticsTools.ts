/**
 * Mastra Analytics & CRM Tools
 * Wraps existing analytics/CRM executor functions as Mastra createTool instances.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {campaignReportFiltersSchema} from '../../services/outreach/CampaignReportFilters.js';
import { PAID_ANALYTICS_PERIODS } from './executors/paidAnalyticsPeriod.js';

const toolResultSchema = z.object({
  success: z.boolean(),
  toolName: z.string(),
  output: z.any().optional(),
  error: z.string().optional(),
});

export const analyticsQueryTool = createTool({
  id: 'analytics_query',
  description: 'Read saved analytics data about campaigns, leads, outreach performance, or overall marketing metrics and show the result/chart tab. For read-only questions this executes the saved-data lookup directly, without creating an approval review. It never syncs providers, publishes, schedules, or spends. Use a fresh call for requested results even if an older analytics review exists.',
  inputSchema: z.object({
    question: z.string().describe('The analytics question from the user'),
    query_type: z.enum(['campaign', 'lead', 'outreach', 'overview']).describe('The type of analytics to query'),
    scope: z.enum(['current_campaign', 'all_owned']).optional().describe('Paid campaign data scope. Use current_campaign for this conversation, all_owned only for account-wide requests.'),
    filters: z.object({
      campaign_id:z.string().regex(/^\d+$/).optional(),platform:z.string().optional(),status:z.string().optional(),
      period:z.enum(PAID_ANALYTICS_PERIODS).optional().describe('Named reporting period for paid campaign metrics, resolved on the server in UTC. "this month" → this_month, "last week" → last_7_days. Prefer this over date_range for relative periods.'),
      date_range:z.object({
        start:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive start date, YYYY-MM-DD'),
        end:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive end date, YYYY-MM-DD'),
      }).strict().optional().describe('Exact inclusive dates for paid campaign metrics when the user names specific dates.'),
    }).strict().optional().describe('Paid campaign filters. Paid campaign IDs are separate from outreach campaign IDs and conversation IDs. Without period or date_range the metrics are lifetime totals.'),
    outreach_filters:campaignReportFiltersSchema.optional().describe('The same filters as dashboard campaign reports. Outbound creation dates select the cohort with an exclusive end. Keep current_campaign for this conversation; use all_owned plus workspaceId only for an explicitly requested other saved workspace.'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeAnalyticsQuery } = await import('./executors/analyticsExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeAnalyticsQuery(input as any, (mastra as any)?.__toolContext);
  },
});

export const createCrmReminderTool = createTool({
  id: 'create_crm_reminder',
  description: "Create a follow-up reminder in the CRM system for a contact or lead.",
  inputSchema: z.object({
    contact_id: z.number().optional().describe('CRM contact ID to link the reminder to'),
    lead_id: z.number().optional().describe('Lead ID (will auto-resolve to CRM contact)'),
    title: z.string().describe('Reminder title'),
    reminder_due_at: z.string().describe('When the reminder is due (ISO 8601 format)'),
    reminder_type: z.enum(['followup', 'meeting', 'call', 'task', 'other']).optional().describe('Type of reminder. Default: followup'),
    description: z.string().optional().describe('Additional details about the reminder'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeCreateCrmReminder } = await import('./executors/crmExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeCreateCrmReminder(input as any, (mastra as any)?.__toolContext);
  },
});

export const updatePipelineStatusTool = createTool({
  id: 'update_pipeline_status',
  description: 'Update the pipeline status of a CRM contact for deal tracking.',
  inputSchema: z.object({
    contact_id: z.number().optional().describe('CRM contact ID to update'),
    lead_id: z.number().optional().describe('Lead ID (will auto-resolve to CRM contact)'),
    pipeline_status: z.string().trim().min(1).max(60).describe('Exact stage key or name from the selected business profile’s saved CRM configuration'),
    reason: z.string().optional().describe('Reason for the status change'),
  }),
  outputSchema: toolResultSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const { executeUpdatePipelineStatus } = await import('./executors/crmExecutor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executeUpdatePipelineStatus(input as any, (mastra as any)?.__toolContext);
  },
});
