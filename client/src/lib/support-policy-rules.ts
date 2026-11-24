import { z } from 'zod';

const channels = [
  'email',
  'whatsapp',
  'instagram',
  'instagram_comment',
  'facebook',
  'facebook_comment',
  'web',
] as const;
const base = {
  id: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  enabled: z.boolean(),
};
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().trim().min(1).max(120).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA timezone');

export const supportPolicyRuleSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('operating_hours'), config: z.object({
    timezone,
    start: time,
    end: time,
    outsideHoursAction: z.enum(['escalate', 'auto_reply_with_hours']).default('auto_reply_with_hours'),
    customMessage: z.string().trim().min(1).max(1000).optional(),
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal('prohibited_topics'), config: z.object({
    topics: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
    action: z.enum(['block', 'escalate']),
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal('max_response_length'), config: z.object({
    maxChars: z.number().int().min(1).max(20_000),
    action: z.enum(['truncate', 'block', 'escalate']),
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal('escalation_threshold'), config: z.object({
    threshold: z.number().min(0).max(1),
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal('rate_limit'), config: z.object({
    limit: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(10).max(86_400),
    action: z.enum(['block', 'escalate']).default('block'),
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal('channel_restriction'), config: z.object({
    allowedChannels: z.array(z.enum(channels)).min(1).max(channels.length),
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal('required_disclaimer'), config: z.object({
    disclaimer: z.string().trim().min(1).max(2000),
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal('auto_escalate_intent'), config: z.object({
    intents: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
  }).strict() }).strict(),
]);

export const supportPolicyRulesSchema = z.union([
  z.array(supportPolicyRuleSchema).max(100),
  z.object({ rules: z.array(supportPolicyRuleSchema).max(100).optional().default([]) }).loose(),
]);

export function policyValidationMessage(value: unknown): string | null {
  const result = supportPolicyRulesSchema.safeParse(value);
  if (result.success) return null;
  const issue = result.error.issues[0];
  return `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`;
}
