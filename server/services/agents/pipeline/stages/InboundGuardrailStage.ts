import { guardrailService } from '../GuardrailService.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';

export class InboundGuardrailStage implements PipelineStage {
  name = 'InboundGuardrail';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    const result = await guardrailService.checkInbound(ctx.message.inboundText);
    ctx.metadata = { ...ctx.metadata, inboundGuardrail: result };
    if (!result.safe) {
      ctx.policyViolations.push({
        ruleId: 'inbound_guardrail',
        ruleType: 'input_safety',
        message: result.reason || 'Inbound content failed safety checks.',
      });
      if (result.action === 'emergency_escalation') {
        ctx.metadata = { ...ctx.metadata, emergencyEscalation: true, emergencyCategories: result.categories || [] };
      }
      throw new PipelineHalt(
        result.reason || 'Inbound content failed safety checks.',
        ctx,
        result.action === 'refuse' ? 'blocked' : 'human_handoff',
      );
    }
    return ctx;
  }
}
