import { z } from 'zod';
import {outreachReportChannels} from '../../../shared/campaignReporting.js';
const positiveId = z.coerce.number().int().positive().max(2147483647);
const instant = z.string().datetime({ offset: true });
export const campaignReportFiltersSchema = z.object({
  workspaceId: positiveId.optional(),
  campaignId: positiveId.optional(),
  preparedOutreachId:z.string().uuid().optional(),
  importId: positiveId.optional(),
  importSource: z.enum(['crm','campaign']).optional(),
  channel: z.enum(outreachReportChannels).optional(),
  accountId: z.string().trim().min(1).max(255).optional(),
  from: instant.optional(),
  to: instant.optional(),
  messageKind: z.enum(['outreach','follow_up','all']).default('outreach').describe('Initial outreach by default. Use all for queue totals including follow-ups.'),
}).strict().superRefine((value, context) => {
  if (value.importId && !value.importSource) context.addIssue({code:'custom',path:['importSource'],message:'Select the source of this import.'});
  if (value.from && value.to && Date.parse(value.from) >= Date.parse(value.to)) context.addIssue({code:'custom',path:['to'],message:'The end must be after the start.'});
});
