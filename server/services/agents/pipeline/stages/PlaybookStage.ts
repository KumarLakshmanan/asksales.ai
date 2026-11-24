import { playbookEngine } from '../../orchestration/PlaybookEngine.js';
import { contactProfileService, type ContactProfileSnapshot } from '../../orchestration/ContactProfileService.js';
import { supportEffectLedgerService } from '../../orchestration/SupportEffectLedgerService.js';
import { supportPlaybookVersionsTable, type PlaybookGraph } from '../../../../models/supportOrchestration/schema.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import { logger } from '../../../../utils/logger.js';
import type { PipelineContext } from '../ChannelGateway.js';
import { PipelineHalt, type PipelineStage } from '../PipelineStage.js';
import { classifyMediaIntent } from '../../../supportMedia/MediaIntentClassifier.js';

export class PlaybookStage implements PipelineStage {
  name = 'Playbook';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.historyStatus === 'unavailable') {
      ctx.metadata = { ...ctx.metadata, suppressBusinessEffects: true };
      return ctx;
    }
    // Internal assistants answer staff questions without running customer intake.
    if (ctx.message.metadata?.executionMode === 'advisory'
      && ['support_member', 'owner_support'].includes(String(ctx.message.metadata?.conversationKind))) return ctx;
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    if (ctx.metadata?.suspendPlaybookForHandoff === true) return ctx;
    const activeAgentType = ctx.metadata?.agentConfig?.agentType;
    if (!activeAgentType) return ctx;
    let profileSnapshot: ContactProfileSnapshot | null = ctx.message.metadata?.executionMode === 'preview'
      && ctx.message.metadata?.mockContactProfile?.knownName === true
      ? {
        contactId: 0,
        leadId: 0,
        fields: { fullName: { value: '[NAME_1]', vaultRef: 0, trust: 'provider' as const } },
      }
      : null;
    if (!ctx.message.metadata?.publicReply && ctx.message.conversationId > 0 && ctx.message.metadata?.executionMode !== 'preview') {
      try {
        profileSnapshot = await contactProfileService.loadForConversation(ctx.message.userId, ctx.message.conversationId);
      } catch (error) {
        logger.warn({ err: error, conversationId: ctx.message.conversationId }, '[PlaybookStage] CRM profile hydration failed; journey will collect missing data');
      }
    } else if (!ctx.message.metadata?.publicReply && ctx.message.leadId && ctx.message.metadata?.executionMode !== 'preview') {
      try {
        profileSnapshot = await contactProfileService.loadForLead(
          ctx.message.userId,
          ctx.message.leadId,
          ctx.message.conversationId,
        );
      } catch (error) {
        logger.warn({ err: error, leadId: ctx.message.leadId }, '[PlaybookStage] CRM profile hydration by lead failed');
      }
    }
    if (!ctx.message.metadata?.publicReply && ctx.message.metadata?.executionMode === 'customer' && ctx.message.conversationId > 0
      && !ctx.metadata?.bookingNameCollection) {
      const correction = await contactProfileService.handleExplicitNameCorrection({
        userId: ctx.message.userId,
        conversationId: ctx.message.conversationId,
        inboundText: ctx.message.inboundText,
        inboundVaultId: Number(ctx.metadata?.privacy?.vaultId || 0) || null,
        profile: profileSnapshot,
      });
      if (correction.handled && correction.replyText) {
        let replyText = correction.replyText;
        // A CRM correction is a temporary governed interruption. A Yes/No
        // resolving it must never double as consent for the outstanding
        // booking, callback, or other journey action. Re-present the exact
        // schema-owned collect prompt and require a fresh customer answer.
        if (correction.outcome === 'updated' || correction.outcome === 'cancelled') {
          const outstandingPrompt = await playbookEngine.getOutstandingCollectPrompt({
            userId: ctx.message.userId,
            conversationId: ctx.message.conversationId,
            agentType: activeAgentType,
            profileSnapshot,
          });
          if (outstandingPrompt) replyText = `${replyText}\n\n${outstandingPrompt}`;
        }
        ctx.agentResult = {
          replyText,
          intent: 'contact_profile_correction',
          outcome: 'answered',
          confidence: 1,
          confidenceReason: 'Deterministic CRM correction confirmation policy.',
          groundingStatus: 'not_required',
          claimEvidence: [],
          toolCallsExecuted: [],
          effectProposals: [],
          escalated: false,
        };
        ctx.metadata = { ...ctx.metadata, skipAgentGeneration: true, contactProfileCorrection: correction.outcome };
        return ctx;
      }
    }
    const mediaIntent = classifyMediaIntent({
      semanticRequest: ctx.nlu?.semanticRequest,
      text: ctx.message.inboundText,
      intent: ctx.nlu?.intent,
      helpfulEnabled: true,
      publicReply: ctx.message.metadata?.publicReply === true,
      outboundFirstTouch: ctx.message.metadata?.outboundFirstTouch === true,
    }).intent;
    const directive = await playbookEngine.resolve({
      userId: ctx.message.userId,
      conversationId: ctx.message.conversationId,
      channel: ctx.message.channel,
      intent: ctx.nlu?.intent,
      mediaIntent,
      semanticRequest: ctx.nlu?.semanticRequest,
      inboundText: ctx.message.inboundText,
      agentType: activeAgentType,
      entities: ctx.nlu?.entities,
      privacyVaultId: ctx.message.metadata?.executionMode === 'preview' && ctx.metadata?.privacy?.tokenCount > 0
        ? -1 : Number(ctx.metadata?.privacy?.vaultId || 0) || null,
      contactAvailable: Boolean(ctx.message.senderIdentifier && ctx.message.senderIdentifier !== 'unknown'),
      eventKey: ctx.message.rawMessageId || (ctx.message.messageId ? `message:${ctx.message.messageId}` : undefined),
      dryRun: ctx.message.metadata?.dryRun === true,
      readOnlyDraft: ['outreach_draft','smart_reply','reply_enhancement','email_smart_reply'].includes(String(ctx.message.metadata?.conversationKind))
        && ctx.message.metadata?.dryRun === true,
      profileSnapshot,
    });
    if (!directive) return ctx;
    ctx.metadata = { ...ctx.metadata, playbookDirective: directive,
      ...(directive.readOnlyInformation ? { suppressBusinessEffects: true } : {}) };
    if (directive.journey && ctx.message.metadata?.executionMode === 'customer') {
      const [version] = await db.select({ graph: supportPlaybookVersionsTable.graph })
        .from(supportPlaybookVersionsTable)
        .where(and(
          eq(supportPlaybookVersionsTable.playbookId, directive.playbookId),
          eq(supportPlaybookVersionsTable.version, directive.version),
        )).limit(1);
      const graph = version?.graph as PlaybookGraph | undefined;
      const definitions = new Map((graph?.fields || []).map((field) => [field.key, field]));
      for (const [fieldKey, state] of Object.entries(directive.journey.fields)) {
        const field = definitions.get(fieldKey);
        if (!field?.profileBinding || state.source !== 'customer' || !state.vaultRef
          || (state as { bookingNameConfirmed?: boolean }).bookingNameConfirmed) continue;
        await supportEffectLedgerService.runOnce({
          userId: ctx.message.userId,
          conversationId: ctx.message.conversationId,
          channel: ctx.message.channel,
          inboundProviderMessageId: ctx.message.rawMessageId,
          inboundMessageId: ctx.message.messageId,
          effectType: `contact_profile:${directive.runId}:${fieldKey}`.slice(0, 80),
          version: 1,
        }, async () => {
          await contactProfileService.writeBackCollectedField({
            userId: ctx.message.userId,
            conversationId: ctx.message.conversationId,
            runId: directive.runId,
            field,
            state: state as Parameters<typeof contactProfileService.writeBackCollectedField>[0]['state'],
          });
        });
      }
    }
    if (directive.capability?.validationErrors?.length) {
      throw new PipelineHalt(
        `Published capability prerequisites were not satisfied: ${directive.capability.validationErrors.join(' ')}`,
        ctx,
        'human_handoff',
      );
    }
    if (directive.escalate) {
      throw new PipelineHalt(
        directive.instruction || `Playbook ${directive.playbookId} requested human handoff.`,
        ctx,
        'human_handoff',
      );
    }
    if (directive.complete) {
      ctx.metadata.playbookCompleted = true;
    }
    return ctx;
  }
}
