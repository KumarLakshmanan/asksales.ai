import { logger } from '../../../../utils/logger.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';
import { supportAutoReplyEnabled } from '../../../../../shared/supportAutoReplies.js';
import { currentAssistant } from '../../../assistants/AssistantContext.js';
import { assistantAgentConfig } from '../../../assistants/AssistantResolver.js';

export function agentSupportsChannel(channelScope: unknown, channel: string): boolean {
  return supportAutoReplyEnabled({ channelScope }, channel);
}

export function assignmentAgentAvailabilityError(
  config: { enabled?: boolean; channelScope?: unknown; metadata?: unknown } | null | undefined,
  channel: string | null,
): string | null {
  if (!config?.enabled) return 'The assigned specialist must exist and be enabled.';
  if (channel && !supportAutoReplyEnabled(config, channel)) {
    return `The assigned specialist is not enabled for ${channel}.`;
  }
  return null;
}

export class AgentConfigurationStage implements PipelineStage {
  name = 'AgentConfiguration';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    try {
      const assistant = currentAssistant();
      if (assistant) {
        ctx.metadata = {...ctx.metadata,agentConfig:assistantAgentConfig(assistant.configuration,assistant.provenance.assistantId)};
        return ctx;
      }
      throw new PipelineHalt('No explicitly assigned assistant is available for this receiving account.', ctx, 'no_op');
    } catch (error) {
      if (error instanceof PipelineHalt) throw error;
      logger.error({ err: error, userId: ctx.message.userId }, '[AgentConfigurationStage] Failed to load AI configuration');
      throw new PipelineHalt('AI configuration could not be verified.', ctx, 'no_op');
    }
  }
}
