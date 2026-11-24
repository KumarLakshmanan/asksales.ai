import { z } from 'zod';
import { crmConfigurationIssues, CRM_STAGE_LIMIT } from '../../shared/crmConfiguration.js';

const platformSchema = z.enum(['all', 'email', 'whatsapp', 'instagram', 'facebook', 'linkedin', 'twitter', 'sms', 'web']);

export const crmConfigurationSchema = z.object({
  stages: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(['entry', 'active', 'won', 'lost']),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    inFlow: z.boolean(),
  }).strict()).min(1).max(CRM_STAGE_LIMIT),
  preferences: z.object({
    dateRange: z.enum(['7d', '30d', '90d', 'all', 'custom']),
    dateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    platform: z.union([platformSchema, z.array(platformSchema).min(1).max(8)])
      .transform(platform => Array.isArray(platform) ? platform : [platform]),
    stuckThreshold: z.number().int().min(1).max(365),
    topFlows: z.number().int().min(1).max(20),
    minFlowCount: z.number().int().min(1).max(1000),
  }).strict(),
  revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().superRefine((configuration, context) => {
  for (const issue of crmConfigurationIssues(configuration)) {
    context.addIssue({ code: 'custom', path: [issue.section], message: issue.message });
  }
});
