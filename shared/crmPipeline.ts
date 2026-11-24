import type { CrmConfiguration, CrmStage, CrmStageType } from './crmConfiguration.js';

export interface CrmPipelineContext {
  stages: Array<Pick<CrmStage, 'key' | 'label' | 'type'>>;
  currentStageKey: string;
}

export interface CrmStageDecision {
  stageKey: string | null;
  outcome: 'unchanged' | 'active' | 'won' | 'lost';
  evidence: 'none' | 'progress' | 'explicit_acceptance' | 'explicit_rejection';
  confidence: number;
}

export const UNCHANGED_CRM_DECISION: CrmStageDecision = {
  stageKey: null, outcome: 'unchanged', evidence: 'none', confidence: 0,
};

const LEGACY_STAGE_ALIASES: Record<string, string> = {
  negotiation: 'negotiations', ticket_closed: 'ticket_close', converted: 'won', rejected: 'lost',
};
const LEGACY_ACTIVE_STAGES = new Set(['contacted', 'interested', 'qualified', 'negotiations', 'demo',
  'proposal_sent', 'ticket_open', 'ticket_close']);

/** References come from owner configuration or validated agent output, never
 * keyword matching against customer messages. */
export function resolveCrmStageReference(stages: CrmStage[], reference: string): CrmStage | undefined {
  const value = reference.trim().toLocaleLowerCase();
  const exact = stages.find(stage => stage.key === reference.trim())
    || stages.find(stage => stage.label.trim().toLocaleLowerCase() === value);
  if (exact) return exact;
  const canonical = LEGACY_STAGE_ALIASES[value] || value;
  const legacy = stages.find(stage => stage.key === canonical);
  if (legacy) return legacy;
  if (canonical === 'won' || canonical === 'lost') return stages.find(stage => stage.type === canonical);
  return undefined;
}

export function crmStageForOutcome(stages: CrmStage[], type: CrmStageType, preferred?: string | null): CrmStage | undefined {
  const requested = preferred ? resolveCrmStageReference(stages, preferred) : undefined;
  return requested?.type === type ? requested
    : stages.find(stage => stage.key === type && stage.type === type) || stages.find(stage => stage.type === type);
}

export function parseCrmStageDecision(value: unknown, context?: CrmPipelineContext): CrmStageDecision | undefined {
  if (!context || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const decision = value as Record<string, unknown>;
  if (typeof decision.confidence !== 'number' || !Number.isFinite(decision.confidence)
    || decision.confidence < 0 || decision.confidence > 1) return undefined;
  if (decision.outcome === 'unchanged' && decision.stageKey === null && decision.evidence === 'none') {
    return { ...UNCHANGED_CRM_DECISION, confidence: decision.confidence };
  }
  const stage = context.stages.find(stage => stage.key === decision.stageKey);
  if (!stage || stage.type === 'entry' || stage.type !== decision.outcome) return undefined;
  const evidence = stage.type === 'won' ? 'explicit_acceptance' : stage.type === 'lost' ? 'explicit_rejection' : 'progress';
  if (decision.evidence !== evidence) return undefined;
  return { stageKey: stage.key, outcome: stage.type, evidence, confidence: decision.confidence };
}

export function selectAutomaticCrmStage(configuration: CrmConfiguration, currentStageKey: string, input: {
  decision?: CrmStageDecision;
  legacyStage?: string;
  verifiedOutcome?: 'won' | 'lost';
  verifiedProgress?: string;
}): CrmStage | undefined {
  const { stages } = configuration;
  const current = stages.find(stage => stage.key === currentStageKey);
  // Customer replies and routine support work cannot reopen a closed deal.
  if (current?.type === 'won' || current?.type === 'lost') return current;
  if (input.verifiedOutcome) return crmStageForOutcome(stages, input.verifiedOutcome, input.decision?.stageKey);
  if (input.verifiedProgress) {
    const verified = resolveCrmStageReference(stages, input.verifiedProgress);
    if (verified?.type === 'active') return verified;
  }
  if (input.decision) {
    const decision = parseCrmStageDecision(input.decision, { stages, currentStageKey });
    if (!decision || decision.outcome === 'unchanged') return undefined;
    const threshold = decision.outcome === 'active' ? 0.85 : 0.95;
    if (decision.confidence < threshold) return undefined;
    return stages.find(stage => stage.key === decision.stageKey);
  }
  // Old specialist signals remain compatible with renamed/custom stages.
  // Closing a sale still requires explicit customer or verified tool evidence.
  const reference = input.legacyStage || '';
  const resolved = resolveCrmStageReference(stages, reference);
  if (resolved?.type === 'active') return resolved;
  const canonical = LEGACY_STAGE_ALIASES[reference.toLocaleLowerCase()] || reference.toLocaleLowerCase();
  if (!LEGACY_ACTIVE_STAGES.has(canonical)) return undefined;
  return current?.type === 'active' ? current : stages.find(stage => stage.type === 'active');
}

export function crmContactStatusForStage(stage: CrmStage, currentStatus?: string | null): string {
  if (stage.type === 'won' || stage.type === 'lost') return stage.type;
  if (stage.type === 'entry') return 'new';
  if (!currentStatus || ['new', 'won', 'lost', 'converted', 'rejected'].includes(currentStatus)) return 'contacted';
  return currentStatus;
}

export function crmLeadStatusForStage(stage: CrmStage | undefined, status: string): string {
  if (stage?.type === 'won') return 'converted';
  if (stage?.type === 'lost') return 'lost';
  if (stage?.type === 'entry') return 'new';
  if (stage?.key === 'interested') return 'interested';
  if (stage?.type === 'active' && ['won', 'lost', 'converted', 'rejected'].includes(status)) return 'contacted';
  return status === 'won' ? 'converted' : status;
}
