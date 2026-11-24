import { policyEngine, type PolicyRule } from '../PolicyEngine.js';
import { policyRulesFromConfig } from '../PolicyRuleSchema.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';

export class PreGenerationPolicyStage implements PipelineStage {
  name = 'PreGenerationPolicy';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    const rules = this.rulesFromContext(ctx);
    const evaluation = policyEngine.evaluateBeforeClassification(ctx, rules);
    ctx.metadata = { ...ctx.metadata, preGenerationPolicy: evaluation };
    ctx.policyViolations.push(...evaluation.violations);

    const block = evaluation.enforcements.find((item) => item.action === 'block');
    if (block) throw new PipelineHalt(block.detail || 'Blocked by support policy.', ctx, 'blocked');

    const escalate = evaluation.enforcements.find((item) => item.action === 'escalate');
    if (escalate && ctx.message.metadata?.executionMode !== 'advisory') {
      throw new PipelineHalt(escalate.detail || 'Escalated by support policy.', ctx, 'human_handoff');
    }

    const outsideHours = evaluation.enforcements.find((item) => item.action === 'auto_reply_with_hours');
    if (outsideHours) {
      ctx.agentResult = {
        replyText: outsideHours.detail || 'We are currently outside support hours. A team member will respond when support reopens.',
        escalated: false,
        confidence: 1,
      };
      ctx.metadata = {
        ...ctx.metadata,
        skipAgentGeneration: true,
        suppressBusinessEffects: true,
        systemDirective: 'outside_operating_hours_acknowledgement',
      };
    }

    return ctx;
  }

  private rulesFromContext(ctx: PipelineContext): PolicyRule[] {
    return policyRulesFromConfig(ctx.metadata?.agentConfig?.escalationRules) as PolicyRule[];
  }
}
