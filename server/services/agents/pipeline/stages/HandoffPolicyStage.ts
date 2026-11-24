import { getActiveAiAgentConfig } from '../../../../models/aiAgentConfigs/functions.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';
import { currentAssistant } from '../../../assistants/AssistantContext.js';

/** Resolve before privacy/safety checks, which can themselves request handoff. */
export class HandoffPolicyStage implements PipelineStage {
  name = 'HandoffPolicy';
  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    try {
      const config = currentAssistant() ? ctx.metadata?.agentConfig : await getActiveAiAgentConfig(ctx.message.userId);
      const metadata = config?.metadata as { handoffPolicy?: { mode?: string; bookingSearchUrl?: string } } | undefined;
      ctx.metadata = { ...ctx.metadata, ownerHandoffPolicy: metadata?.handoffPolicy?.mode === 'customer_requests_only'
        ? { mode: 'customer_requests_only', bookingSearchUrl: metadata.handoffPolicy.bookingSearchUrl } : null };
      return ctx;
    } catch {
      throw new PipelineHalt('Handoff policy could not be verified.', ctx, 'no_op');
    }
  }
}
