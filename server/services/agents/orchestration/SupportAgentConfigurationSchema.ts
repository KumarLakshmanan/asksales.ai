import { z } from 'zod';
import { SUPPORT_TOOL_NAMES } from './SafeToolExecutor.js';

const demoTurn = z.object({
  id: z.string().max(120).optional(),
  role: z.enum(['user', 'agent', 'assistant']),
  content: z.string().max(4_000),
}).strict();

const trainingDemo = z.object({
  id: z.string().max(120).optional(),
  userMessage: z.string().max(4_000).optional(),
  agentReply: z.string().max(4_000).optional(),
  messages: z.array(demoTurn).max(20).optional(),
}).strict().superRefine((value, ctx) => {
  const legacyPair = Boolean(value.userMessage?.trim() && value.agentReply?.trim());
  const multiTurn = Boolean(value.messages?.length);
  if (!legacyPair && !multiTurn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A demonstration requires a legacy pair or at least one message.' });
  }
});

/** Versioned owner-editable metadata. Unknown keys are rejected at the API boundary. */
export const supportAgentMetadataSchema = z.object({
  platformAutoReplies: z.object({
    instagram: z.boolean().optional(),
    facebook: z.boolean().optional(),
    email: z.boolean().optional(),
    whatsapp: z.boolean().optional(),
    web: z.boolean().optional(),
  }).strict().optional(),
  configurationSchemaVersion: z.literal(1).optional(),
  defaultProfileVersion: z.number().int().positive().optional(),
  mandatoryControlProfileVersion: z.number().int().positive().optional(),
  rateLimitPolicyVersion: z.number().int().positive().optional(),
  proposalToolsVersion: z.number().int().positive().optional(),
  privacyStatus: z.literal('enforced').optional(),
  piiRedactionStatus: z.literal('enforced').optional(),
  safetyStatus: z.literal('enforced').optional(),
  handoffStatus: z.literal('enabled').optional(),
  toolApprovalStatus: z.literal('required').optional(),
  autoApproveTools: z.array(z.string().refine((tool) => SUPPORT_TOOL_NAMES.has(tool), 'Unsupported support tool')).max(100).optional(),
  trainingConversations: z.array(trainingDemo).max(20).optional(),
}).strict();

export function validateSupportAgentMetadata(value: unknown): string[] {
  const result = supportAgentMetadataSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join('.') || 'metadata'}: ${issue.message}`);
}
