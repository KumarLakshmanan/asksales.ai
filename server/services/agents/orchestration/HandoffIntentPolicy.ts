import { confidentSemanticIntent, type SupportSemanticIntent } from './SupportSemanticIntent.js';
interface HandoffIntentInput {
  semanticRequest?: SupportSemanticIntent;
  text: string;
  intent: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskFactors: string[];
  modelNeedsHuman: boolean;
}

const MANDATORY_RISK_FACTORS = new Set([
  'legal_threat', 'extreme_dissatisfaction', 'self_harm', 'physical_harm',
  'regulatory_threat', 'chargeback_threat',
]);

/** A model's needsHuman boolean is advisory. Direct takeover is deterministic
 * and requires an explicit person request or a recognized high-impact risk. */
export function shouldRequireDirectHumanHandoff(input: HandoffIntentInput): boolean {
  if (input.riskLevel === 'critical') return true;
  const request = confidentSemanticIntent(input.semanticRequest);
  if (request?.explicit && request.action === 'human') return true;
  if (!input.modelNeedsHuman) return false;
  if (input.riskFactors.some((factor) => MANDATORY_RISK_FACTORS.has(factor))) return true;
  return false;
}
