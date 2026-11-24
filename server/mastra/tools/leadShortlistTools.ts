import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { LeadModel } from '../../models/leads/functions.js';
import type { ToolContext } from './toolRegistry.js';

const ids = z.array(z.number().int().positive()).max(1000);
const resultSchema = z.object({ success: z.boolean(), toolName: z.string(), output: z.any().optional(), error: z.string().optional() });
export const reviseLeadShortlistSchema = z.object({
  expectedLeadIds: ids.describe('Complete current shortlist IDs returned by get_lead_shortlist. Used to reject stale edits.'),
  keepLeadIds: ids.describe('Exact IDs to retain, chosen from the current shortlist based on retrieved records. Empty clears only the shortlist, never deletes leads.'),
});

/** Per-invocation capability: edits can only narrow the current reviewed set.
 * Actual state persistence remains in the agent/controller's serialized turn.
 * This tool never approves recipients, changes a campaign or deletes a lead. */
export function createLeadShortlistTools(context: ToolContext, selection: () => number[]) {
  let observedIds: number[] | null = null;
  const same = (a: number[], b: number[]) => a.length === b.length && [...a].sort((x,y) => x-y).every((id, i) => id === [...b].sort((x,y) => x-y)[i]);
  return {
    get_lead_shortlist: createTool({
      id: 'get_lead_shortlist',
      description: 'Read every record in the current campaign shortlist before changing it. Returns exact IDs, names, company, role and contact availability. Saved leads remain untouched.',
      inputSchema: z.object({}), outputSchema: resultSchema,
      execute: async () => {
        const current = [...selection()];
        if (current.length > 1000) return { success: false, toolName: 'get_lead_shortlist', error: 'This shortlist is too large for a safe single-turn edit. Narrow it in the Leads tab first.' };
        const records = await Promise.all(current.map(id => LeadModel.findByIdForUser(id, context.userId)));
        if (records.some(record => !record || record.deletedAt)) return { success: false, toolName: 'get_lead_shortlist', error: 'Some selected leads are no longer available in your account. Refresh the selection before editing.' };
        observedIds = current;
        return { success: true, toolName: 'get_lead_shortlist', output: {
          leadIds: current,
          leads: records.map(record => ({ id: record!.id, name: record!.fullName || record!.name,
            company: record!.companyName || record!.company, role: record!.role, headline: record!.headline,
            industry: record!.industry, bio: record!.bio, about: record!.about,
            hasEmail: !!record!.email, hasPhone: !!record!.phone })),
          message: 'This is the current shortlist, not all saved leads. Missing role/company facts are unknown; do not invent classifications.',
        } };
      },
    }),
    revise_lead_shortlist: createTool({
      id: 'revise_lead_shortlist',
      description: 'Keep an exact subset of the current shortlist after reading get_lead_shortlist in this turn. Use for category-based exclusions or keeping exact leads. Does not delete saved leads, approve outreach, or alter an already prepared campaign. Ask when category membership is unclear.',
      inputSchema: reviseLeadShortlistSchema, outputSchema: resultSchema,
      execute: async raw => {
        const input = reviseLeadShortlistSchema.parse(raw);
        const current = [...selection()];
        if (!observedIds || !same(current, observedIds) || !same(current, input.expectedLeadIds)) {
          return { success: false, toolName: 'revise_lead_shortlist', error: 'Read the current shortlist again before editing; the selection is unverified or has changed.' };
        }
        const keep = [...new Set(input.keepLeadIds)];
        if (keep.some(id => !current.includes(id))) return { success: false, toolName: 'revise_lead_shortlist', error: 'Retain only IDs in the current shortlist. No changes were made.' };
        const records = await Promise.all(keep.map(id => LeadModel.findByIdForUser(id, context.userId)));
        if (records.some(record => !record || record.deletedAt)) return { success: false, toolName: 'revise_lead_shortlist', error: 'A selected lead is no longer available in your account. No changes were made.' };
        return { success: true, toolName: 'revise_lead_shortlist', output: {
          leadIds: keep, previousLeadIds: current, removedLeadIds: current.filter(id => !keep.includes(id)),
          changed: !same(current, keep), leadReviewApproved: false,
          message: 'Shortlist updated for review. No saved leads were deleted and no outreach was approved or sent. Existing campaign recipient snapshots were not changed.',
        } };
      },
    }),
  };
}
