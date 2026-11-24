import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { auditService } from '../AuditService.js';

/** Durable decision boundary: delivery and post-processing cannot start until
 * the exact approved draft and its evidence/tool state have an audit identity. */
export class DecisionAuditStage implements PipelineStage {
  name = 'DecisionAudit';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    await auditService.createDecision(ctx, ctx.metadata?.startTime || Date.now());
    return ctx;
  }
}
