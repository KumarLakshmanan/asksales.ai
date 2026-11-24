import { z } from 'zod';

export const SUPPORT_POLICY_CHANNELS = [
  'email',
  'whatsapp',
  'instagram',
  'instagram_comment',
  'facebook',
  'facebook_comment',
  'web',
] as const;

const ruleId = z.string().trim().min(1).max(120).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
  'Rule IDs may contain letters, numbers, periods, underscores, colons, and hyphens.',
);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use 24-hour HH:mm format.');
const timezone = z.string().trim().min(1).max(120).superRefine((value, ctx) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown IANA timezone: ${value}.` });
  }
});
const baseRule = {
  id: ruleId,
  enabled: z.boolean(),
};

export const policyRuleSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseRule,
    type: z.literal('operating_hours'),
    config: z.object({
      timezone,
      start: time,
      end: time,
      outsideHoursAction: z.enum(['escalate', 'auto_reply_with_hours']).default('auto_reply_with_hours'),
      customMessage: z.string().trim().min(1).max(1000).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...baseRule,
    type: z.literal('prohibited_topics'),
    config: z.object({
      topics: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
      action: z.enum(['block', 'escalate']),
    }).strict(),
  }).strict(),
  z.object({
    ...baseRule,
    type: z.literal('max_response_length'),
    config: z.object({
      maxChars: z.number().int().min(1).max(20_000),
      action: z.enum(['truncate', 'block', 'escalate']),
    }).strict(),
  }).strict(),
  z.object({
    ...baseRule,
    type: z.literal('escalation_threshold'),
    config: z.object({
      threshold: z.number().min(0).max(1),
    }).strict(),
  }).strict(),
  z.object({
    ...baseRule,
    type: z.literal('rate_limit'),
    config: z.object({
      /** Fixed-window requests per tenant/channel/sender. */
      limit: z.number().int().min(1).max(10_000),
      windowSeconds: z.number().int().min(10).max(86_400),
      action: z.enum(['block', 'escalate']).default('block'),
    }).strict(),
  }).strict(),
  z.object({
    ...baseRule,
    type: z.literal('channel_restriction'),
    config: z.object({
      allowedChannels: z.array(z.enum(SUPPORT_POLICY_CHANNELS)).min(1).max(SUPPORT_POLICY_CHANNELS.length),
    }).strict(),
  }).strict(),
  z.object({
    ...baseRule,
    type: z.literal('required_disclaimer'),
    config: z.object({
      disclaimer: z.string().trim().min(1).max(2000),
    }).strict(),
  }).strict(),
  z.object({
    ...baseRule,
    type: z.literal('auto_escalate_intent'),
    config: z.object({
      intents: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
    }).strict(),
  }).strict(),
]);

const policyRuleArraySchema = z.array(policyRuleSchema).max(100).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    if (seen.has(rule.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'id'],
        message: `Duplicate policy rule ID: ${rule.id}.`,
      });
    }
    seen.add(rule.id);
  });
});
const policyRuleWrapperSchema = z.object({
  rules: policyRuleArraySchema.optional().default([]),
}).passthrough();

export const policyRulesSchema = z.union([policyRuleArraySchema, policyRuleWrapperSchema]);
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export function policyRulesFromConfig(value: unknown): PolicyRule[] {
  const parsed = policyRulesSchema.safeParse(value);
  if (!parsed.success) return [];
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.rules;
}

export function validatePolicyRules(value: unknown): string[] {
  const parsed = policyRulesSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
}
