import { z } from 'zod';

const simulationResult = z.object({
  success: z.literal(true),
  previewSessionId: z.number().int().gt(-2_000_000_000).lte(-1_500_000_000).optional(),
  outcome: z.string().min(1),
  replyText: z.string().default(''),
  redactedInput: z.string().default(''),
  intent: z.string().nullable().default(null),
  riskLevel: z.string().nullable().default(null),
  classificationConfidence: z.number().nullable().default(null),
  confidence: z.number().min(0).max(1),
  agentType: z.string().nullable().default(null),
  playbook: z.object({
    playbookId: z.number().optional(), version: z.number().optional(),
    nodeId: z.string().optional(), nodeType: z.string().optional(),
  }).nullable().default(null),
  toolCalls: z.array(z.unknown()).default([]),
  guardrail: z.unknown().optional(),
  policyViolations: z.array(z.unknown()).default([]),
  piiTypes: z.array(z.string()).default([]),
  handoffReason: z.string().nullable().default(null),
  sideEffectsSuppressed: z.literal(true),
});

export type SimulationResult = z.infer<typeof simulationResult>;

/** Error envelopes intentionally omit preview details. Do not render them as
 * successful results or advance the isolated conversation on a rejected turn. */
export function readSupportSimulationResult(value: unknown): SimulationResult {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const response = value as Record<string, unknown>;
    if (response.success === false) {
      throw new Error(typeof response.error === 'string' && response.error.trim()
        ? response.error : 'The reply preview could not be generated. Please try again.');
    }
  }
  const parsed = simulationResult.safeParse(value);
  if (!parsed.success) throw new Error('The reply preview returned an incomplete response. Please try again.');
  return parsed.data;
}
