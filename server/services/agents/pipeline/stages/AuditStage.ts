import type { PipelineStage } from "../PipelineStage.js";
import type { PipelineContext } from "../ChannelGateway.js";
import { auditService } from "../AuditService.js";
import { logger } from "../../../../utils/logger.js";

export class AuditStage implements PipelineStage {
  name = "Audit";

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const startTime = ctx.metadata?.startTime || Date.now();
    
    // Default outcome for regular successful pipeline execution is auto_sent
    let outcome: 'auto_sent' | 'drafted' | 'ready_for_channel_delivery' | 'pending_approval' | 'human_handoff' | 'blocked' | 'error' =
      ctx.metadata?.deliveryStatus === 'drafted' ? 'drafted' : ctx.metadata?.deliveryDeferred === true && ctx.message.metadata?.dryRun !== true
        ? 'ready_for_channel_delivery'
        : 'auto_sent';
    if (ctx.agentResult?.escalated || ctx.metadata?.capabilityHandoffCommitted === true) {
      outcome = 'human_handoff';
    }

    try {
      const audit = await auditService.finalize(ctx, outcome, startTime);
      if (audit?.id) ctx.metadata = { ...ctx.metadata, auditLogId: audit.id };
    } catch (err) {
      logger.error({ err }, '[AuditStage] Failed to save agent decision audit log');
    }

    return ctx;
  }
}
