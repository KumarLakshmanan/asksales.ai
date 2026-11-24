import { sql } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { HANDOFF_FIELD, HANDOFF_DECLINE_ACK, hasCustomerHandoffConsent, validatedHandoffChoice } from '../../orchestration/HandoffConsent.js';
import { matchExactPlaybookChoice, type SupportChoiceManifest } from '../../orchestration/SupportChoiceDelivery.js';

/** Resolve only the most recently delivered offer in this exact conversation.
 * A stale/foreign button or an unrelated booking Yes must never grant handoff. */
export class HandoffConsentStage implements PipelineStage {
  name = 'HandoffConsent';
  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.activeHandoff || ctx.metadata?.skipAgentGeneration
      || ctx.message.channel.endsWith('_comment') || ctx.message.metadata?.dryRun) return ctx;
    const widget = ctx.message.channel === 'web' && ctx.message.conversationId < 0
      && ctx.message.metadata?.conversationKind === 'support_widget';
    const result = widget ? await db.execute(sql`
      SELECT sent.metadata->'handoffChoice' AS choice
      FROM support_chat_messages sent
      JOIN support_chat_sessions session ON session.id=sent.session_id
      JOIN team_members member ON member.id=session.member_id AND member.user_id=${ctx.message.userId}
      WHERE sent.session_id=${-ctx.message.conversationId} AND sent.role='assistant'
        AND sent.processing_status='completed' AND sent.created_at > NOW()-INTERVAL '24 hours'
        AND (${Number(ctx.message.metadata?.widgetMessageId || 0)}=0 OR sent.id<${Number(ctx.message.metadata?.widgetMessageId || 0)})
      ORDER BY sent.created_at DESC,sent.id DESC LIMIT 1
    `) : await db.execute(sql`
      SELECT a.payload->'choice' AS choice, m.metadata->'nativeSelection' AS selection
      FROM outreach_messages sent
      LEFT JOIN support_delivery_outbox a ON a.id=sent.delivery_action_id
        AND a.user_id=sent.user_id AND a.conversation_id=sent.conversation_id
        AND a.status='sent' AND a.channel=${ctx.message.channel}
      LEFT JOIN outreach_messages m ON m.id=${ctx.message.messageId || 0}
        AND m.user_id=sent.user_id AND m.conversation_id=sent.conversation_id AND m.direction='inbound'
      WHERE sent.user_id=${ctx.message.userId} AND sent.conversation_id=${ctx.message.conversationId}
        AND sent.direction='outbound' AND sent.status IN ('sent','delivered','read')
        AND COALESCE(sent.metadata->>'deleted','false') <> 'true'
        AND sent.sent_at > NOW() - INTERVAL '24 hours'
        AND (${ctx.message.messageId || 0}=0 OR sent.id < ${ctx.message.messageId || 0})
      ORDER BY sent.sent_at DESC, sent.id DESC LIMIT 1
    `);
    const row = result.rows[0] as { choice?: SupportChoiceManifest; selection?: { id?: string } } | undefined;
    const selection = row?.selection?.id;
    const choice = validatedHandoffChoice(row?.choice);
    ctx.metadata = { ...ctx.metadata, handoffOfferValidated: Boolean(choice) };
    const native = selection?.startsWith('handoff_v1_');
    const option = choice && native ? choice.options.find(item => item.id === selection) : undefined;
    const typed = choice && !selection ? matchExactPlaybookChoice({
      key: HANDOFF_FIELD, type: 'boolean', prompt: choice.prompt, required: true, pii: 'none',
    }, ctx.message.inboundText) : undefined;
    if (native && !option) {
      ctx.metadata = { ...ctx.metadata, handoffConsentRejected: true };
      this.continueChat(ctx, 'That earlier choice is no longer active. Please tell me if you would like a human support agent, or ask your next question.');
    } else if (option?.value === 'true' || typed?.value === true) {
      ctx.metadata = { ...ctx.metadata, verifiedHandoffConsent: true, activePlaybookSelection: undefined, activePlaybookCount: undefined };
    } else if (option?.value === 'false' || typed?.value === false) {
      ctx.metadata = { ...ctx.metadata, handoffConsentRejected: true };
      this.continueChat(ctx, HANDOFF_DECLINE_ACK);
    } else if (selection && choice) {
      // A booking/template/other button is not acceptance of this offer.
      ctx.metadata = { ...ctx.metadata, handoffConsentRejected: true };
    }
    if (hasCustomerHandoffConsent(ctx)) ctx.metadata = { ...ctx.metadata, customerRequestedHandoff: true };
    return ctx;
  }

  private continueChat(ctx: PipelineContext, replyText: string): void {
    ctx.agentResult = { replyText, escalated: false, confidence: 1, groundingStatus: 'not_required',
      handoff: { required: false }, effectProposals: [], toolCallsExecuted: [] };
    ctx.metadata = { ...ctx.metadata, skipAgentGeneration: true, suppressBusinessEffects: true };
  }
}
