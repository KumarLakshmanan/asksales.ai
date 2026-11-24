import { policyEngine, type PolicyRule } from '../PolicyEngine.js';
import { policyRulesFromConfig } from '../PolicyRuleSchema.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';

/** Applies rules whose inputs are produced by NLU. Keeping this separate makes
 * it impossible for intent escalation to silently run against an empty intent. */
export class PostClassificationPolicyStage implements PipelineStage {
  name = 'PostClassificationPolicy';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    const rules = policyRulesFromConfig(ctx.metadata?.agentConfig?.escalationRules) as PolicyRule[];
    // An exact value from the immutable active playbook is not a free-form
    // request for immediate human takeover. Keep every fixed safety rule, but
    // let the playbook handle its own configured callback/handoff choice.
    const activeSelection = ctx.metadata?.activePlaybookSelection;
    const effectiveRules = activeSelection
      ? rules.filter((rule) => rule.type !== 'auto_escalate_intent')
      : rules;
    const evaluation = policyEngine.evaluateAfterClassification(ctx, effectiveRules);
    ctx.metadata = {
      ...ctx.metadata,
      postClassificationPolicy: evaluation,
      ...(activeSelection ? { playbookSelectionPolicyOverride: 'auto_escalate_intent' } : {}),
    };
    ctx.policyViolations.push(...evaluation.violations);
    const block = evaluation.enforcements.find((item) => item.action === 'block');
    if (block) throw new PipelineHalt(block.detail || 'Blocked by support policy.', ctx, 'blocked');
    const escalate = evaluation.enforcements.find((item) => item.action === 'escalate');
    if (escalate && ctx.message.metadata?.executionMode !== 'advisory') {
      throw new PipelineHalt(escalate.detail || 'Escalated by intent policy.', ctx, 'human_handoff');
    }
    return ctx;
  }
}
