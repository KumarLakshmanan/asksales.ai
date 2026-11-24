import { logger } from '../../../../utils/logger.js';
import { currentSupportTurn } from '../../orchestration/SupportConversationTurn.js';
import {
  privacyVaultService,
  redactPiiWithStableTokens,
  sanitizeStructuredForModel,
} from '../../orchestration/PrivacyVaultService.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';

export class PrivacyStage implements PipelineStage {
  name = 'Privacy';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const original = ctx.message.inboundText || '';
    const preview = redactPiiWithStableTokens(original, ctx.message);
    const preprotected = ctx.message.metadata?.privacyPreprotected as {
      piiTypes?: string[];
      tokenCount?: number;
      vaultId?: number | null;
    } | undefined;
    const structured = sanitizeStructuredForModel({
      leadName: ctx.message.leadName,
      leadCompany: ctx.message.leadCompany,
      senderIdentifier: ctx.message.senderIdentifier,
    });

    // Mutate the only pipeline copy before any classifier, retrieval, model, or
    // audit stage can observe the original customer text.
    ctx.message.inboundText = preview.redactedText;
    ctx.metadata = {
      ...ctx.metadata,
      privacy: {
        piiTypes: preprotected?.piiTypes || preview.piiTypes,
        tokenCount: preprotected?.tokenCount ?? preview.tokenCount,
        vaultId: preprotected?.vaultId ?? null,
        structuredPiiTypes: structured.piiTypes,
      },
      modelIdentity: structured.value,
    };

    if (ctx.message.metadata?.dryRun === true) return ctx;
    // Each inbox fragment was already redacted before enqueue. Re-protecting
    // the joined text with the last message ID would overwrite that original
    // CRM message with the whole batch (including when there is no PII).
    if (currentSupportTurn()) return ctx;
    if (preprotected?.vaultId || ctx.message.metadata?.privacyPreprotected === true) return ctx;

    try {
      const protectedMessage = await privacyVaultService.protectInbound({
        userId: ctx.message.userId,
        conversationId: ctx.message.conversationId,
        channel: ctx.message.channel,
        rawText: original,
        providerMessageId: ctx.message.rawMessageId,
        messageId: ctx.message.messageId,
        entityType: ctx.message.metadata?.conversationKind === 'support_widget'
          ? 'widget_message'
          : undefined,
        entityId: Number(ctx.message.metadata?.widgetMessageId || 0) || undefined,
      });
      ctx.metadata.privacy = {
        piiTypes: protectedMessage.piiTypes,
        tokenCount: protectedMessage.tokenCount,
        vaultId: protectedMessage.vaultId,
        structuredPiiTypes: structured.piiTypes,
      };
    } catch (error) {
      if (preview.tokenCount > 0) {
        logger.error({ err: error, conversationId: ctx.message.conversationId }, '[PrivacyStage] Failed to protect sensitive inbound content');
        throw new PipelineHalt(
          'Sensitive content could not be placed in the restricted privacy vault.',
          ctx,
          'human_handoff',
        );
      }
      logger.warn({ err: error, conversationId: ctx.message.conversationId }, '[PrivacyStage] Could not persist redacted message metadata');
    }

    return ctx;
  }
}
