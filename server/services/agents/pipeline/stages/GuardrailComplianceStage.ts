import type { PipelineStage } from "../PipelineStage.js";
import type { PipelineContext } from "../ChannelGateway.js";
import { guardrailService } from "../GuardrailService.js";
import { logger } from "../../../../utils/logger.js";
import { PipelineHalt } from '../PipelineStage.js';
import { knowledgeGateway } from '../../../knowledge/KnowledgeGateway.js';

export class GuardrailComplianceStage implements PipelineStage {
  name = "GuardrailCompliance";

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (!ctx.agentResult?.replyText) return ctx;

    try {
      const contacts = ctx.agentResult.toolCallsExecuted?.filter(tool => tool.name === 'get_hotel_info' && tool.success)
        .flatMap(tool => {
          const record = tool.result as Record<string, unknown> | null;
          return ['phone', 'email', 'address'].map(key => record?.[key]).filter((value): value is string => typeof value === 'string');
        }) || [];
      const knowledge = ctx.contextLanes?.knowledge;
      if (knowledge?.status === 'sufficient' && ctx.metadata?.knowledgeQuery) {
        const contactEvidence = knowledge.evidence.filter(evidence => evidence.verifiedBusinessContacts?.length);
        if (contactEvidence.length) {
          try {
            // Publications can be withdrawn while the model is responding.
            // Only current server evidence confers this exemption; user-upload
            // reference lanes never authorize a public business contact.
            const current = await knowledgeGateway.revalidateEvidence(ctx.metadata.knowledgeQuery, contactEvidence);
            contacts.push(...current.flatMap(evidence => evidence.verifiedBusinessContacts || []));
          } catch { /* Authorization unavailable: retain normal PII masking. */ }
        }
      }
      ctx.metadata = { ...ctx.metadata, businessPiiAllowlist: contacts };
      const guardrailResult = await guardrailService.checkOutbound(ctx.agentResult.replyText, ctx);
      ctx.guardrailResult = guardrailResult;

      // Update replyText with safe/redacted content
      ctx.agentResult.replyText = guardrailResult.finalText;

      if (!guardrailResult.safe) {
        logger.warn(
          { conversationId: ctx.message.conversationId, violations: guardrailResult.violations },
          '[GuardrailComplianceStage] Guardrail/Policy safety check failed'
        );

        ctx.agentResult.escalated = true;
        ctx.agentResult.escalationReason = guardrailResult.violations.join(", ");
        throw new PipelineHalt(
          ctx.agentResult.escalationReason || 'Outbound response failed safety checks.',
          ctx,
          guardrailResult.action === 'refuse' ? 'blocked' : 'human_handoff',
        );
      }
    } catch (err) {
      if (err instanceof PipelineHalt) throw err;
      logger.error({ err }, '[GuardrailComplianceStage] Guardrail execution failed');
      ctx.policyViolations.push({
        ruleId: 'outbound_guardrail_unavailable',
        ruleType: 'output_safety',
        message: 'Outbound response safety could not be verified.',
      });
      throw new PipelineHalt(
        'Outbound response safety could not be verified.',
        ctx,
        'human_handoff',
      );
    }

    return ctx;
  }
}
