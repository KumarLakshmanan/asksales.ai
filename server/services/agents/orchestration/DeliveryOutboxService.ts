import crypto from 'node:crypto';
import { assertCustomerDeliveryReady, currentCustomerDeliveryReceipt, CustomerDeliverySetupError, deliverySetupFailure, withCustomerDeliveryReceipt } from '../../assistants/CustomerDeliveryGate.js';
import { assertConversationDeliveryReady } from '../../assistants/ConversationDeliveryGate.js';
import type { AssistantProvenance } from '../../../../shared/outreachAssistants.js';
import { assistantDeliveryMetadata, assistantsRuntimeEnabled, currentAssistant } from '../../assistants/AssistantContext.js';
import { assistantProvenanceCurrent, assertAssistantFresh, withPublishedAssistant } from '../../assistants/AssistantFreshness.js';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { logger } from '../../../utils/logger.js';
import { AUTOMATIC_REPLY_DISABLED, automaticSupportReplyAllowed, isAutomaticSupportDelivery, socialDraftChannel } from './SupportAutoReplyService.js';
import { currentSupportTurn, sealSupportTurn, supportTurnDeliveryMetadata, supportTurnRetryAllowed, withSupportTurnRetryLease } from './SupportConversationTurn.js';
import {
  supportDeliveryOutboxTable,
  type DeliveryOutboxPayload,
  type SupportDeliveryOutboxRecord,
} from '../../../models/supportOrchestration/schema.js';

export interface DeliveryDecisionIdentity {
  userId: number;
  conversationId: number;
  channel: string;
  inboundProviderMessageId?: string;
  inboundMessageId?: number;
  playbookRunId?: number;
  playbookNodeId?: string;
  responseVersion?: number;
  partIndex?: number;
  idempotencyKey?: string;
}

export type DeliveryClaim =
  | { state: 'claimed'; action: SupportDeliveryOutboxRecord }
  | { state: 'drafted'; action: SupportDeliveryOutboxRecord }
  | { state: 'already_sent'; action: SupportDeliveryOutboxRecord }
  | { state: 'uncertain'; action: SupportDeliveryOutboxRecord };

export function createDeliveryDecisionKey(identity: DeliveryDecisionIdentity): string {
  const sourceMessage = identity.idempotencyKey
    ? `idempotency:${identity.idempotencyKey}`
    : identity.inboundProviderMessageId
    || (identity.inboundMessageId ? `local:${identity.inboundMessageId}` : 'missing-provider-id');
  const stable = [
    identity.userId,
    identity.conversationId,
    identity.channel,
    sourceMessage,
    identity.playbookRunId ?? 'no-playbook',
    identity.playbookNodeId ?? 'no-node',
    identity.responseVersion ?? 1,
    identity.partIndex ?? 0,
    ...(currentAssistant() ? [currentAssistant()!.provenance.assistantId,currentAssistant()!.provenance.revision,currentAssistant()!.provenance.bindingId] : []),
  ].join(':');
  return `support:${crypto.createHash('sha256').update(stable).digest('hex')}`;
}

export class DeliveryOutboxService {
  private async deliveryAuthorization(identity: DeliveryDecisionIdentity, payload: DeliveryOutboxPayload) {
    const expected = currentCustomerDeliveryReceipt() || payload.metadata?.customerDeliveryAssistant as AssistantProvenance | undefined || currentAssistant()?.provenance;
    const receipt = expected
      ? await assertCustomerDeliveryReady({ userId: identity.userId, channel: identity.channel.replace(/^gmail$/, 'email').replace(/_comment$/, ''), accountId: expected.accountId, surface: expected.surface, expected })
      : await assertConversationDeliveryReady(identity.userId, identity.conversationId, undefined, identity.channel.endsWith('_comment') ? 'public_comment' : 'private');
    return { ...payload, metadata: { ...payload.metadata, customerDeliveryAssistant: receipt } };
  }

  async enqueue(identity: DeliveryDecisionIdentity, payload: DeliveryOutboxPayload): Promise<SupportDeliveryOutboxRecord> {
    payload = await this.deliveryAuthorization(identity, payload);
    await assertAssistantFresh();
    await sealSupportTurn();
    payload = { ...payload, metadata: { ...payload.metadata, ...supportTurnDeliveryMetadata(), ...assistantDeliveryMetadata(),
      sourceMessageIds: currentSupportTurn()?.messageIds || payload.metadata?.sourceMessageIds || (identity.inboundMessageId ? [identity.inboundMessageId] : []),
    } };
    const decisionKey = createDeliveryDecisionKey(identity);
    const [created] = await db.insert(supportDeliveryOutboxTable).values({
      userId: identity.userId,
      conversationId: identity.conversationId,
      channel: identity.channel,
      decisionKey,
      inboundProviderMessageId: identity.inboundProviderMessageId ?? null,
      playbookRunId: identity.playbookRunId ?? null,
      responseVersion: identity.responseVersion ?? 1,
      status: 'pending',
      payload,
    }).onConflictDoNothing({ target: supportDeliveryOutboxTable.decisionKey }).returning();
    if (created) return created;
    const [existing] = await db.select().from(supportDeliveryOutboxTable)
      .where(eq(supportDeliveryOutboxTable.decisionKey, decisionKey)).limit(1);
    if (!existing) throw new Error('Delivery action could not be enqueued or loaded.');
    return existing;
  }

  async claim(identity: DeliveryDecisionIdentity, payload: DeliveryOutboxPayload): Promise<DeliveryClaim> {
    payload = await this.deliveryAuthorization(identity, payload);
    await assertAssistantFresh();
    await sealSupportTurn();
    payload = { ...payload, metadata: { ...payload.metadata, ...supportTurnDeliveryMetadata(), ...assistantDeliveryMetadata(),
      sourceMessageIds: currentSupportTurn()?.messageIds || payload.metadata?.sourceMessageIds || (identity.inboundMessageId ? [identity.inboundMessageId] : []),
    } };
    const decisionKey = createDeliveryDecisionKey(identity);
    const [created] = await db.insert(supportDeliveryOutboxTable).values({
      userId: identity.userId,
      conversationId: identity.conversationId,
      channel: identity.channel,
      decisionKey,
      inboundProviderMessageId: identity.inboundProviderMessageId ?? null,
      playbookRunId: identity.playbookRunId ?? null,
      responseVersion: identity.responseVersion ?? 1,
      status: 'pending',
      payload,
    }).onConflictDoNothing({ target: supportDeliveryOutboxTable.decisionKey }).returning();

    const action = created || (await db.select()
      .from(supportDeliveryOutboxTable)
      .where(eq(supportDeliveryOutboxTable.decisionKey, decisionKey))
      .limit(1))[0];
    if (!action) throw new Error('Delivery action could not be created or loaded.');
    if (action.status === 'drafted') return { state: 'drafted', action };
    if (action.status === 'sent') return { state: 'already_sent', action };
    if (action.status === 'setup_required' || (!action.payload.metadata?.assistant && !action.payload.metadata?.customerDeliveryAssistant))
      throw new CustomerDeliverySetupError('queued_setup_review_required', 'This unsent delivery requires a new assistant setup review. Automatic replay is blocked.');
    const savedReceipt = (action.payload.metadata?.customerDeliveryAssistant || action.payload.metadata?.assistant) as AssistantProvenance;
    await assertCustomerDeliveryReady({ userId: action.userId, channel: savedReceipt.channel, accountId: savedReceipt.accountId, surface: savedReceipt.surface, expected: savedReceipt });
    if (action.status === 'sending' || action.status === 'uncertain') {
      return { state: 'uncertain', action };
    }
    if (!await supportTurnRetryAllowed(action.payload.metadata)) throw new Error('Support reply was superseded; old delivery suppressed.');
    if (await this.suppressDisabledAutomaticReply(action)) {
      if (socialDraftChannel(action.channel)) return { state: 'drafted', action: { ...action, status: 'drafted' } };
      throw new Error(AUTOMATIC_REPLY_DISABLED);
    }
    if (action.attemptCount >= action.maxAttempts
      || (action.status === 'failed' && (!action.nextAttemptAt || action.nextAttemptAt > new Date()))) {
      throw new Error(action.nextAttemptAt
        ? 'This delivery retry is scheduled for a later time.'
        : 'This delivery failure requires review before a new send request.');
    }

    const [claimed] = await db.update(supportDeliveryOutboxTable)
      .set({
        status: 'sending',
        sendingAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
        nextAttemptAt: null,
        attemptCount: action.attemptCount + 1,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(supportDeliveryOutboxTable.id, action.id),
        inArray(supportDeliveryOutboxTable.status, ['pending', 'failed']),
        sql`${supportDeliveryOutboxTable.attemptCount} < ${supportDeliveryOutboxTable.maxAttempts}`,
        or(
          eq(supportDeliveryOutboxTable.status, 'pending'),
          lte(supportDeliveryOutboxTable.nextAttemptAt, new Date()),
        ),
      ))
      .returning();
    if (!claimed) {
      const [current] = await db.select()
        .from(supportDeliveryOutboxTable)
        .where(eq(supportDeliveryOutboxTable.id, action.id))
        .limit(1);
      if (current?.status === 'sent') return { state: 'already_sent', action: current };
      if (current) return { state: 'uncertain', action: current };
      throw new Error('Delivery action disappeared while being claimed.');
    }
    return { state: 'claimed', action: claimed };
  }

  async markSent(id: number, providerMessageId?: string | null): Promise<void> {
    await db.update(supportDeliveryOutboxTable).set({
      status: 'sent',
      providerMessageId: providerMessageId ?? null,
      sentAt: new Date(),
      leaseExpiresAt: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
      lastError: null,
    }).where(eq(supportDeliveryOutboxTable.id, id));
  }

  async markFailed(id: number, error: string, outcomeUncertain: boolean, retryable = true): Promise<void> {
    const [current] = await db.select({
      attemptCount: supportDeliveryOutboxTable.attemptCount,
      maxAttempts: supportDeliveryOutboxTable.maxAttempts,
    }).from(supportDeliveryOutboxTable).where(eq(supportDeliveryOutboxTable.id, id)).limit(1);
    const exhausted = Number(current?.attemptCount || 0) >= Number(current?.maxAttempts || 5);
    const retryDelayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.max(0, Number(current?.attemptCount || 1) - 1)));
    await db.update(supportDeliveryOutboxTable).set({
      status: outcomeUncertain ? 'uncertain' : 'failed',
      lastError: error.slice(0, 2000),
      leaseExpiresAt: null,
      nextAttemptAt: outcomeUncertain || exhausted || !retryable ? null : new Date(Date.now() + retryDelayMs),
      updatedAt: new Date(),
    }).where(and(eq(supportDeliveryOutboxTable.id, id), inArray(supportDeliveryOutboxTable.status, ['pending', 'sending', 'failed'])));
  }

  /**
   * A crashed sender cannot be retried blindly: the provider may have accepted
   * the request just before the process died. Expired leases therefore become
   * operator-reconcilable, never automatically resendable.
   */
  async reconcileExpiredLeases(): Promise<number> {
    return db.transaction(async (tx: typeof db) => {
      const result = await tx.update(supportDeliveryOutboxTable).set({
        status: 'uncertain',
        lastError: 'Delivery worker lease expired after the provider call may have started.',
        leaseExpiresAt: null,
        nextAttemptAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(supportDeliveryOutboxTable.status, 'sending'),
        sql`${supportDeliveryOutboxTable.leaseExpiresAt} <= NOW()`,
      )).returning();
      for (const action of result) {
        if (action.payload.metadata?.dispatchKind === 'proposal_delivery') {
          // Keep the customer offer and its durable receipt in the same state
          // even if the original sender crashed before persisting its result.
          await tx.execute(sql`UPDATE proposals SET status='delivery_unknown',updated_at=NOW() WHERE id=${Number(action.payload.metadata.proposalId)} AND user_id=${action.userId} AND status='sending' AND metadata->'deliveryAttempt'->>'actionId'=${String(action.id)}`);
        }
      }
      return result.length;
    });
  }

  private async claimAction(id: number): Promise<SupportDeliveryOutboxRecord | null> {
    const [action] = await db.select().from(supportDeliveryOutboxTable).where(eq(supportDeliveryOutboxTable.id, id)).limit(1);
    if (action && await this.suppressSupersededReply(action)) return null;
    if (action && await this.suppressDisabledAutomaticReply(action)) return null;
    const [claimed] = await db.update(supportDeliveryOutboxTable).set({
      status: 'sending',
      sendingAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
      nextAttemptAt: null,
      attemptCount: sql`${supportDeliveryOutboxTable.attemptCount} + 1`,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(supportDeliveryOutboxTable.id, id),
      inArray(supportDeliveryOutboxTable.status, ['pending', 'failed']),
      sql`${supportDeliveryOutboxTable.attemptCount} < ${supportDeliveryOutboxTable.maxAttempts}`,
      or(
        eq(supportDeliveryOutboxTable.status, 'pending'),
        lte(supportDeliveryOutboxTable.nextAttemptAt, new Date()),
      ),
    )).returning();
    return claimed || null;
  }

  private async suppressSupersededReply(action: SupportDeliveryOutboxRecord): Promise<boolean> {
    const turnCurrent = await supportTurnRetryAllowed(action.payload.metadata);
    if (turnCurrent) {
        const receipt = (action.payload.metadata?.assistant || action.payload.metadata?.customerDeliveryAssistant) as AssistantProvenance | undefined;
        let failure;
        try {
          if (!receipt) throw new CustomerDeliverySetupError('queued_setup_review_required', 'This delivery has no reviewed assistant assignment. Prepare a new reviewed delivery.');
          await assertCustomerDeliveryReady({ userId: action.userId, channel: receipt.channel, accountId: receipt.accountId, surface: receipt.surface, expected: receipt });
          if (action.payload.metadata?.assistant && !await assistantProvenanceCurrent(action.payload.metadata.assistant))
            throw new CustomerDeliverySetupError('assignment_changed', 'The original support assistant changed before delivery. Review its assignment.');
          return false;
        } catch (error) {
          failure = deliverySetupFailure(error);
          if (!failure) throw error;
        }
        await db.update(supportDeliveryOutboxTable).set({ status: 'setup_required', nextAttemptAt: null, leaseExpiresAt: null,
          lastError: `${failure.code}:${failure.reason}: ${failure.error}`, updatedAt: new Date() })
          .where(and(eq(supportDeliveryOutboxTable.id, action.id), inArray(supportDeliveryOutboxTable.status, ['pending','failed'])));
        return true;
    }
    await db.update(supportDeliveryOutboxTable).set({ status: action.payload.metadata?.assistant || assistantsRuntimeEnabled() ? 'cancelled' : 'failed', nextAttemptAt: null,
      lastError: 'Support reply superseded by newer input or ownership; resend suppressed.', updatedAt: new Date(),
    }).where(and(eq(supportDeliveryOutboxTable.id, action.id), inArray(supportDeliveryOutboxTable.status, ['pending', 'failed'])));
    return true;
  }

  private async suppressDisabledAutomaticReply(action: SupportDeliveryOutboxRecord): Promise<boolean> {
    if (!isAutomaticSupportDelivery(action.payload.metadata)
      || await automaticSupportReplyAllowed(action.userId, action.channel,
        action.payload.phoneNumberId || String(action.payload.metadata?.providerAccountId || ''),action.payload.metadata)) return false;
    if (action.payload.metadata?.assistant) {
      await db.update(supportDeliveryOutboxTable).set({status:'cancelled',nextAttemptAt:null,leaseExpiresAt:null,
        lastError:'The assistant assignment is no longer enabled.',updatedAt:new Date()})
        .where(and(eq(supportDeliveryOutboxTable.id,action.id),inArray(supportDeliveryOutboxTable.status,['pending','failed','drafted','sending'])));
      return true;
    }
    if (socialDraftChannel(action.channel)) {
      await this.saveDraft(action);
      return true;
    }
    // Cancel unsent work permanently; re-enabling a platform must not send stale replies.
    await db.update(supportDeliveryOutboxTable).set({
      status: 'failed', lastError: AUTOMATIC_REPLY_DISABLED, nextAttemptAt: null,
      leaseExpiresAt: null, updatedAt: new Date(),
    }).where(and(
      eq(supportDeliveryOutboxTable.id, action.id),
      eq(supportDeliveryOutboxTable.userId, action.userId),
      inArray(supportDeliveryOutboxTable.status, ['pending', 'failed']),
    ));
    return true;
  }

  /** Also used immediately before a provider call after asynchronous media preparation. */
  async holdIfDisabled(action: SupportDeliveryOutboxRecord): Promise<boolean> {
    if (action.status === 'drafted') return true;
    return this.suppressDisabledAutomaticReply(action);
  }

  async draft(identity: DeliveryDecisionIdentity, payload: DeliveryOutboxPayload): Promise<SupportDeliveryOutboxRecord> {
    const action = await this.enqueue(identity, payload);
    if (action.status === 'sent') return action;
    if (action.status === 'uncertain') throw new Error('Uncertain delivery requires reconciliation before drafting.');
    await this.saveDraft(action);
    return { ...action, status: 'drafted' };
  }

  /** A draft is a terminal delivery decision, not a retryable send failure. */
  private async saveDraft(action: SupportDeliveryOutboxRecord): Promise<void> {
    if (action.status === 'drafted') return; // Discarded drafts must never be resurrected.
    const turn = currentSupportTurn();
    const { redactPiiWithStableTokens } = await import('./PrivacyVaultService.js');
    const content = redactPiiWithStableTokens(action.payload.text).redactedText;
    const metadata = {
      ...action.payload.metadata,
      origin: 'ai', replySurface: action.channel.endsWith('_comment') ? 'comment' : 'message',
      ...(action.channel.endsWith('_comment') ? { commentId: action.payload.recipient } : {}),
      recipient: action.payload.recipient,
      sourceTurnId: turn?.id || (action.payload.metadata?.supportTurn as { id?: string } | undefined)?.id || null,
      sourceMessageIds: turn?.messageIds || action.payload.metadata?.sourceMessageIds || [],
      suppressionReason: AUTOMATIC_REPLY_DISABLED,
      choice: action.payload.choice,
    };
    await db.transaction(async (tx: typeof db) => {
      const result = await tx.execute(sql`UPDATE support_delivery_outbox SET status='drafted',
        next_attempt_at=NULL, lease_expires_at=NULL, last_error=${AUTOMATIC_REPLY_DISABLED}, updated_at=NOW()
        WHERE id=${action.id} AND user_id=${action.userId} AND status IN ('pending','failed','sending') RETURNING id`);
      if (!result.rows.length) return; // Never rewrite a confirmed or uncertain provider outcome.
      const inserted = await tx.execute(sql`INSERT INTO outreach_messages
        (conversation_id,user_id,direction,content,redacted_content,status,is_ai_generated,is_automatic,is_read,
         message_kind,delivery_action_id,provider_account_id,phone_number_id,metadata)
        SELECT c.id,${action.userId},'outbound',${content},${content},'draft',TRUE,TRUE,TRUE,'reply',${action.id},
          c.provider_account_id,${action.payload.phoneNumberId || null},${JSON.stringify(metadata)}::jsonb
        FROM outreach_conversations c WHERE c.id=${action.conversationId} AND c.user_id=${action.userId}
        ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO NOTHING RETURNING id`);
      if (!inserted.rows.length) {
        const existing = await tx.execute(sql`SELECT id FROM outreach_messages WHERE delivery_action_id=${action.id} AND user_id=${action.userId}`);
        if (!existing.rows.length) throw new Error('Draft conversation could not be verified.');
        await tx.execute(sql`UPDATE outreach_messages SET status='draft',provider_call_state='not_started',
          sent_at=NULL,delivered_at=NULL,read_at=NULL,confirmed_at=NULL,is_read=TRUE,
          metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify(metadata)}::jsonb,updated_at=NOW()
          WHERE delivery_action_id=${action.id} AND user_id=${action.userId} AND status IN ('pending','sending','failed','draft')`);
      } else {
        await tx.execute(sql`UPDATE outreach_conversations SET total_messages=COALESCE(total_messages,0)+1,
          last_message_at=NOW(),last_message_preview=${`Draft: ${content}`.slice(0,200)},updated_at=NOW()
          WHERE id=${action.conversationId} AND user_id=${action.userId}`);
      }
      await tx.execute(sql`UPDATE agent_audit_logs SET delivery_status='drafted',delivery_deferred=FALSE
        WHERE user_id=${action.userId} AND delivery_action_id=${action.id}`);
    });
    const drafts = await db.execute(sql`SELECT id FROM outreach_messages WHERE delivery_action_id=${action.id} AND user_id=${action.userId} AND status='draft'`);
    const messageId = Number(drafts.rows[0]?.id || 0);
    if (messageId && !action.channel.endsWith('_comment')) {
      const media = (action.payload.metadata?.draftMedia || []) as Array<{ derivativeStorageFileId: number; name: string }>;
      const document = (action.payload.metadata?.draftDocument || action.payload.metadata?.document) as { storageFileId?: number; title?: string } | undefined;
      const assets = [...media.map(item => ({ id: item.derivativeStorageFileId, name: item.name })),
        ...(document?.storageFileId ? [{ id: document.storageFileId, name: `${document.title || 'Document'}.pdf` }] : [])];
      if (assets.length) {
        const [{ outreachAttachmentService }, { storageService }] = await Promise.all([import('../../OutreachAttachmentService.js'), import('../../StorageService.js')]);
        for (const asset of assets.slice(0,5)) {
          const params = { userId: action.userId, messageId, direction: 'outbound' as const, deliveryStatus: 'pending' as const,
            fileName: asset.name, source: 'ai_draft_asset', providerAttachmentId: `draft:${action.id}:asset:${asset.id}` };
          try {
            const file = await storageService.downloadFile(asset.id, action.userId);
            if (!file) throw new Error('Draft attachment is unavailable.');
            await outreachAttachmentService.persistInboundBuffer({ ...params, buffer: file.buffer, mimeType: file.file.mimeType || 'application/octet-stream' });
          } catch (error) { await outreachAttachmentService.recordInboundFailure({ ...params, error }); }
        }
      }
    }
    const { webSocketEmitter } = await import('../WebSocketEmitter.js');
    webSocketEmitter.emit(action.userId, 'outreach_message_updated', { conversationId: action.conversationId, channel: action.channel.replace(/_comment$/, '') });
  }

  async completeClaimedAction(
    claimed: SupportDeliveryOutboxRecord,
    providerMessageId: string | null,
    onConfirmed?: (tx: Pick<typeof db,'execute'>) => Promise<void>,
  ): Promise<void> {
    const payload = claimed.payload;
    let persistedMessageId: number | null = null;
    await db.transaction(async (tx: typeof db) => {
      const [sent] = await tx.update(supportDeliveryOutboxTable).set({
        status: 'sent',
        payload,
        providerMessageId,
        sentAt: new Date(),
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(
        eq(supportDeliveryOutboxTable.id, claimed.id),
        eq(supportDeliveryOutboxTable.userId, claimed.userId),
        eq(supportDeliveryOutboxTable.status, 'sending'),
      )).returning({ id: supportDeliveryOutboxTable.id });
      if (!sent) throw new Error('Delivery action changed before completion could be committed.');
      await tx.execute(sql`
        UPDATE agent_audit_logs
        SET delivery_status = 'sent',
            delivery_deferred = FALSE,
            provider_message_id = ${providerMessageId}
        WHERE user_id = ${claimed.userId}
          AND delivery_action_id = ${claimed.id}
      `);

      let adopted = false;
      if (providerMessageId) {
        const { reconcileSocialSend } = await import('../../SocialMessagePersistence.js');
        adopted = Boolean(await reconcileSocialSend(tx, { userId: claimed.userId, conversationId: claimed.conversationId,
          providerId: providerMessageId, deliveryActionId: claimed.id }));
      }
      const persisted = await tx.execute(sql`
        INSERT INTO outreach_messages (
          conversation_id, user_id, direction, content, external_message_id, provider_message_id, waba_message_id,
          phone_number_id, message_type, status, provider_call_state, provider_account_id, confirmed_at,
          sent_at, is_ai_generated, is_automatic, message_kind, metadata, delivery_action_id, subject,follow_up_origin_message_id,follow_up_step,redacted_content,campaign_id
        ) VALUES (
          ${claimed.conversationId}, ${claimed.userId}, 'outbound', ${payload.text}, ${providerMessageId}, ${providerMessageId},
          ${claimed.channel === 'whatsapp' ? providerMessageId : null}, ${payload.phoneNumberId || null},
          ${payload.metadata?.dispatchKind === 'support_document' ? 'document' : payload.choice ? 'interactive' : 'text'}, 'sent', 'confirmed',
          ${payload.phoneNumberId || (typeof payload.metadata?.providerAccountId === 'string' ? payload.metadata.providerAccountId : null)},
          NOW(), NOW(), ${payload.metadata?.isAiGenerated !== false}, ${isAutomaticSupportDelivery(payload.metadata)
            || (payload.metadata?.dispatchKind === 'campaign_email_reply' && payload.metadata?.autoReply === true)},
          ${payload.metadata?.messageKind === 'follow_up' ? 'follow_up' : payload.metadata?.messageKind === 'proposal' ? 'proposal' : 'reply'},
          ${JSON.stringify(payload.metadata || {})}::jsonb, ${claimed.id}, ${payload.subject || null},
          ${payload.metadata?.messageKind === 'follow_up' ? Number(payload.metadata.anchorMessageId) : null},
          ${payload.metadata?.messageKind === 'follow_up' ? Number(payload.metadata.followUpStep)+1 : 0},${payload.text},
          ${Number(payload.metadata?.campaignId) > 0 ? Number(payload.metadata?.campaignId) : null}
        )
        ON CONFLICT (delivery_action_id) WHERE delivery_action_id IS NOT NULL DO UPDATE SET
          status = CASE WHEN outreach_messages.status IN ('delivered','read') THEN outreach_messages.status ELSE 'sent' END,
          is_ai_generated = EXCLUDED.is_ai_generated,
          is_automatic = EXCLUDED.is_automatic,
          message_kind = EXCLUDED.message_kind,
          follow_up_origin_message_id = EXCLUDED.follow_up_origin_message_id,
          follow_up_step = EXCLUDED.follow_up_step,
          redacted_content = EXCLUDED.redacted_content,
          metadata = COALESCE(outreach_messages.metadata,'{}'::jsonb) || EXCLUDED.metadata || '{"origin":"api"}'::jsonb,
          external_message_id = EXCLUDED.external_message_id,
          provider_message_id = EXCLUDED.external_message_id,
          provider_call_state = 'confirmed',
          provider_account_id = EXCLUDED.provider_account_id,
          confirmed_at = NOW(),
          sent_at = COALESCE(outreach_messages.sent_at,EXCLUDED.sent_at),
          error_message = NULL
        RETURNING id
      `);
      if (persisted.rows.length > 0) {
        persistedMessageId = Number(persisted.rows[0].id);
        await tx.execute(sql`
          UPDATE outreach_conversations
          SET last_message_at = NOW(),
              last_message_by = 'user',
              last_message_preview = ${payload.text.substring(0, 200)},
              total_messages = COALESCE(total_messages, 0) + ${adopted ? 0 : 1},
              updated_at = NOW()
          WHERE id = ${claimed.conversationId}
            AND user_id = ${claimed.userId}
        `);
      }
      if (onConfirmed) await onConfirmed(tx);
    });
    if (payload.metadata?.assistantAway) {
      const {confirmAssistantAwayMessage}=await import('../../assistants/AssistantAvailability.js');
      await confirmAssistantAwayMessage(payload.metadata);
    }
    if (persistedMessageId && payload.metadata?.assistant && payload.metadata?.messageKind !== 'follow_up' && !payload.metadata?.suppressAssistantFollowUp) {
      try {
        const {scheduleAssistantFollowUp}=await import('../../assistants/AssistantFollowUps.js');
        await scheduleAssistantFollowUp(persistedMessageId);
      } catch (error) { logger.warn({err:error,conversationId:claimed.conversationId},'Could not schedule assistant check-in after confirmed reply'); }
    } else if (persistedMessageId && payload.metadata?.messageKind !== 'follow_up' && !payload.metadata?.suppressAssistantFollowUp && ['whatsapp', 'instagram', 'facebook'].includes(claimed.channel)) {
      // Scheduling is post-commit. A scheduling failure must not retry a reply
      // already accepted by the provider; the message remains durably sent.
      try {
        const { activateSocialFollowUpForAnchor } = await import('../../socialFollowUpService.js');
        await activateSocialFollowUpForAnchor(persistedMessageId);
      } catch (error) {
        logger.warn({ err: error, conversationId: claimed.conversationId }, 'Could not schedule support inactivity follow-up');
      }
    }
  }

  private async dispatchPipelineMessage(action: SupportDeliveryOutboxRecord): Promise<void> {
    const claimed = await this.claimAction(action.id);
    if (!claimed) return;
    if (await this.holdIfDisabled(claimed)) return;
    await this.sendClaimedPipelineMessage(claimed);
  }

  /** Sends one already-claimed WhatsApp/Instagram/Facebook message and records
   * the outcome (sent, retryable failure, or uncertain). Callers that claimed
   * the action themselves use this instead of calling providers directly, so
   * every path classifies provider errors the same way. */
  async sendClaimedPipelineMessage(claimed: SupportDeliveryOutboxRecord): Promise<{ sent: boolean; providerMessageId: string | null }> {
    const payload = claimed.payload;
    let providerMessageId: string | null = null;
    let providerCallStarted = false;
    try {
      if (claimed.channel === 'whatsapp') {
        const { whatsappApiService } = await import('../../whatsappApiService.js');
        providerCallStarted = true;
        const result = payload.choice
          ? await whatsappApiService.sendChoice({
            userId: claimed.userId,
            phoneNumberId: payload.phoneNumberId || undefined,
            to: payload.recipient,
            text: payload.text,
            contextMessageId: payload.replyToProviderMessageId || undefined,
            choice: payload.choice,
          })
          : await whatsappApiService.sendText({
          userId: claimed.userId,
          phoneNumberId: payload.phoneNumberId || undefined,
          to: payload.recipient,
          text: payload.text,
          contextMessageId: payload.replyToProviderMessageId || undefined,
          });
        providerMessageId = result.messages?.[0]?.id || null;
      } else if (claimed.channel === 'instagram') {
        const { sendInstagramDM } = await import('../../instagramService.js');
        providerCallStarted = true;
        const result = await sendInstagramDM({
          recipientId: payload.recipient,
          message: payload.text,
          userId: claimed.userId,
          conversationId: claimed.conversationId,
          messageId: claimed.id,
          providerAccountId: typeof payload.metadata?.providerAccountId === 'string'
            ? payload.metadata.providerAccountId
            : undefined,
          choice: payload.choice,
        });
        if (!result.success) {
          providerCallStarted = result.deliveryAttempted === true;
          throw Object.assign(new Error(result.error || 'Instagram rejected the reply.'), {
            deliveryAttempted: result.deliveryAttempted === true,
            outcomeUncertain: result.outcomeUnknown === true,
            retryable: result.retryable !== false,
          });
        }
        providerMessageId = result.externalMessageId || null;
      } else if (claimed.channel === 'facebook') {
        const { sendFacebookDM } = await import('../../FacebookMessengerService.js');
        providerCallStarted = true;
        const result = await sendFacebookDM({
          conversationId: claimed.conversationId,
          recipientId: payload.recipient,
          message: payload.text,
          userId: claimed.userId,
          providerAccountId: typeof payload.metadata?.providerAccountId === 'string'
            ? payload.metadata.providerAccountId
            : undefined,
          choice: payload.choice,
        });
        if (!result.success) {
          providerCallStarted = result.deliveryAttempted === true;
          throw Object.assign(new Error(result.error || 'Facebook rejected the reply.'), {
            deliveryAttempted: result.deliveryAttempted === true,
            outcomeUncertain: result.outcomeUnknown === true,
            retryable: result.retryable !== false,
          });
        }
        providerMessageId = result.externalMessageId || null;
      } else {
        await this.markFailed(claimed.id, `No durable dispatcher is registered for ${claimed.channel}.`, false);
        return { sent: false, providerMessageId: null };
      }

      await this.completeClaimedAction(claimed, providerMessageId);
      return { sent: true, providerMessageId };
    } catch (error) {
      const providerError = error as { deliveryAttempted?: boolean; outcomeUncertain?: boolean; retryable?: boolean };
      const attempted = providerCallStarted && providerError?.deliveryAttempted !== false;
      const outcomeUncertain = attempted && providerError?.outcomeUncertain !== false;
      await this.markFailed(
        claimed.id,
        error instanceof Error ? error.message : 'Delivery retry failed.',
        outcomeUncertain,
        providerError?.retryable !== false,
      );
      logger.error({ err: error, deliveryActionId: claimed.id }, '[DeliveryOutbox] Durable retry failed');
      return { sent: false, providerMessageId: null };
    }
  }

  private async dispatchPublicComment(action: SupportDeliveryOutboxRecord): Promise<void> {
    const claimed = await this.claimAction(action.id);
    if (!claimed) return;
    if (await this.holdIfDisabled(claimed)) return;
    const channel = claimed.channel.replace(/_comment$/, '');
    let providerAccepted = false;
    try {
      const {
        sendFacebookCommentReply,
        sendInstagramCommentReply,
      } = await import('../../../controllers/webhooksController.js');
      const result = channel === 'instagram'
        ? await sendInstagramCommentReply(
          claimed.userId,
          claimed.payload.recipient,
          claimed.payload.text,
          typeof claimed.payload.metadata?.providerAccountId === 'string'
            ? claimed.payload.metadata.providerAccountId
            : undefined,
        )
        : channel === 'facebook'
          ? await sendFacebookCommentReply(claimed.userId, claimed.payload.recipient, claimed.payload.text, typeof claimed.payload.metadata?.providerAccountId === 'string' ? claimed.payload.metadata.providerAccountId : undefined)
          : {
              success: false,
              providerMessageId: null,
              outcomeUncertain: false,
              error: `No public-comment dispatcher is registered for ${claimed.channel}.`,
            };
      if (!result.success) {
        await this.markFailed(
          claimed.id,
          result.error || 'Provider rejected public comment reply.',
          result.outcomeUncertain,
        );
        return;
      }
      providerAccepted = true;
      await this.completeClaimedAction(claimed, result.providerMessageId);
    } catch (error) {
      await this.markFailed(
        claimed.id,
        error instanceof Error ? error.message : 'Public comment retry failed.',
        providerAccepted,
      );
      logger.error({ err: error, deliveryActionId: claimed.id }, '[DeliveryOutbox] Public comment retry failed');
    }
  }

  async processAction(id: number): Promise<void> {
    const [action] = await db.select().from(supportDeliveryOutboxTable)
      .where(eq(supportDeliveryOutboxTable.id, id)).limit(1);
    if (!action || !['pending', 'failed'].includes(action.status)) return;
    const receipt = action.payload.metadata?.customerDeliveryAssistant as AssistantProvenance | undefined;
    if (!receipt && !action.payload.metadata?.assistant) {
      await db.update(supportDeliveryOutboxTable).set({ status: 'setup_required', nextAttemptAt: null, leaseExpiresAt: null,
        lastError: 'ASSISTANT_SETUP_REQUIRED: This legacy delivery needs a new reviewed assistant assignment.', updatedAt: new Date() })
        .where(and(eq(supportDeliveryOutboxTable.id, action.id), inArray(supportDeliveryOutboxTable.status, ['pending','failed'])));
      return;
    }
    if (receipt) {
      try { await assertCustomerDeliveryReady({ userId: action.userId, channel: receipt.channel, accountId: receipt.accountId, surface: receipt.surface, expected: receipt }); }
      catch (error) {
        const setup = deliverySetupFailure(error);
        if (!setup) throw error;
        await db.update(supportDeliveryOutboxTable).set({ status: 'setup_required', nextAttemptAt: null, leaseExpiresAt: null,
          lastError: `${setup.code}:${setup.reason}: ${setup.error}`, updatedAt: new Date() })
          .where(and(eq(supportDeliveryOutboxTable.id, action.id), inArray(supportDeliveryOutboxTable.status, ['pending','failed'])));
        return;
      }
    }
    if (action.payload.metadata?.dispatchKind === 'campaign_email_reply') {
      const { emailReplyService } = await import('../../EmailReplyService.js');
      const result = await emailReplyService.sendSmartReply(Number(action.payload.metadata.sentMessageId), undefined,
        action.userId, [], { actionId: action.id, conversationId: action.conversationId });
      if (!result.success) await db.update(supportDeliveryOutboxTable).set({status:'cancelled',nextAttemptAt:null,
        lastError:result.error || 'Campaign reply requires review',updatedAt:new Date()}).where(and(
          eq(supportDeliveryOutboxTable.id,action.id),eq(supportDeliveryOutboxTable.userId,action.userId),
          inArray(supportDeliveryOutboxTable.status,['pending','failed']),
          eq(supportDeliveryOutboxTable.attemptCount,action.attemptCount),
        ));
      return;
    }
    if (await this.suppressSupersededReply(action)) return;
    if (receipt && !action.payload.metadata?.assistant) return withCustomerDeliveryReceipt(receipt, () =>
      withSupportTurnRetryLease(action.payload.metadata, () => this.processOwnedAction(action)));
    return withPublishedAssistant(action.payload.metadata?.assistant, () =>
      withSupportTurnRetryLease(action.payload.metadata, () => this.processOwnedAction(action)));
  }

  private async processOwnedAction(action: SupportDeliveryOutboxRecord): Promise<void> {
    if (await this.suppressDisabledAutomaticReply(action)) return;
    const kind = String(action.payload.metadata?.dispatchKind || '');
    if (kind === 'assistant_follow_up') {
      const claimed=await this.claimAction(action.id);
      if (claimed) await (await import('../../assistants/AssistantFollowUps.js')).assistantFollowUps.dispatchClaimed(claimed);
      return;
    }
    if (kind === 'email_smart_reply') {
      const sentMessageId=Number(action.payload.metadata?.sentMessageId);
      if (sentMessageId>0) await (await import('../../EmailReplyService.js')).emailReplyService.sendSmartReply(sentMessageId,undefined,action.userId,[],
        {actionId:action.id,conversationId:action.conversationId});
      return;
    }
    if (kind === 'support_document') {
      const claimed = await this.claimAction(action.id);
      if (claimed) {
        const { supportDocumentDelivery } = await import('../../supportDocuments/SupportDocumentDelivery.js');
        await supportDocumentDelivery.dispatchClaimed(claimed);
      }
      return;
    }
    if (kind === 'proposal_delivery') {
      const { proposalDeliveryService } = await import('../../ProposalDeliveryService.js');
      await proposalDeliveryService.retryOutboxAction(action);
      return;
    }
    if (kind === 'public_comment') {
      await this.dispatchPublicComment(action);
      return;
    }
    if (kind === 'pipeline_message' || kind === 'pipeline_choice') {
      await this.dispatchPipelineMessage(action);
      return;
    }
    if (kind === 'voice_reply' && (action.channel === 'whatsapp' || action.channel === 'instagram' || action.channel === 'facebook')) {
      const { outreachVoiceReplyDeliveryService } = await import('../../OutreachVoiceReplyDeliveryService.js');
      await outreachVoiceReplyDeliveryService.deliver({ userId: action.userId, conversationId: action.conversationId,
        channel: action.channel, senderIdentifier: action.payload.recipient, phoneNumberId: action.payload.phoneNumberId || undefined,
        rawMessageId: action.inboundProviderMessageId || undefined, replyText: action.payload.text, playbookRunId: action.playbookRunId || undefined,
        providerAccountId: typeof action.payload.metadata?.providerAccountId === 'string' ? action.payload.metadata.providerAccountId : undefined });
      return;
    }
    const claimed = await this.claimAction(action.id);
    if (claimed) await this.markFailed(claimed.id, `No immediate delivery handler is registered for dispatch kind "${kind || 'missing'}".`, false);
  }

  async processReady(limit = 25): Promise<{ processed: number; expired: number }> {
    const expired = await this.reconcileExpiredLeases();
    const ready = await db.select().from(supportDeliveryOutboxTable).where(and(
      inArray(supportDeliveryOutboxTable.status, ['pending', 'failed']),
      sql`${supportDeliveryOutboxTable.attemptCount} < ${supportDeliveryOutboxTable.maxAttempts}`,
      or(
        eq(supportDeliveryOutboxTable.status, 'pending'),
        lte(supportDeliveryOutboxTable.nextAttemptAt, new Date()),
      ),
    )).orderBy(supportDeliveryOutboxTable.createdAt).limit(Math.max(1, Math.min(limit, 100)));
    let processed = 0;
    for (const action of ready) {
      const kind = String(action.payload.metadata?.dispatchKind || '');
      try {
        if (kind === 'campaign_email_reply') {
          await this.processAction(action.id);
          processed += 1;
          continue;
        }
        if (action.payload.metadata?.supportTurn || action.payload.metadata?.assistant || action.payload.metadata?.customerDeliveryAssistant) {
          await this.processAction(action.id);
          processed += 1;
          continue;
        }
        if (await this.suppressDisabledAutomaticReply(action)) continue;
        if (kind === 'support_document') {
          await this.processAction(action.id);
          processed += 1;
        } else if (kind === 'proposal_delivery') {
          const { proposalDeliveryService } = await import('../../ProposalDeliveryService.js');
          await proposalDeliveryService.retryOutboxAction(action);
          processed += 1;
        } else if (kind === 'pipeline_message' || kind === 'pipeline_choice') {
          await this.dispatchPipelineMessage(action);
          processed += 1;
        } else if (kind === 'public_comment') {
          await this.dispatchPublicComment(action);
          processed += 1;
        } else if (kind === 'email_smart_reply') {
          const sentMessageId = Number(action.payload.metadata?.sentMessageId);
          if (!Number.isSafeInteger(sentMessageId) || sentMessageId <= 0) continue;
          const { emailReplyService } = await import('../../EmailReplyService.js');
          await emailReplyService.sendSmartReply(sentMessageId, action.payload.text, action.userId, [], {
            actionId: action.id, conversationId: action.conversationId,
          });
          processed += 1;
        } else if (kind === 'manual_support_reply') {
          const { supportReplyDeliveryService } = await import('../../SupportReplyDeliveryService.js');
          await supportReplyDeliveryService.retryDeliveryAction(action);
          processed += 1;
        } else if (kind === 'voice_reply') {
          const { outreachVoiceReplyDeliveryService } = await import('../../OutreachVoiceReplyDeliveryService.js');
          await outreachVoiceReplyDeliveryService.deliver({
            userId: action.userId,
            conversationId: action.conversationId,
            channel: action.channel,
            senderIdentifier: action.payload.recipient,
            phoneNumberId: action.payload.phoneNumberId || undefined,
            rawMessageId: action.inboundProviderMessageId || undefined,
            replyText: action.payload.text,
            playbookRunId: action.playbookRunId || undefined,
          });
          processed += 1;
        } else {
          const claimed = await this.claimAction(action.id);
          if (claimed) {
            await this.markFailed(
              claimed.id,
              `No durable retry handler is registered for dispatch kind "${kind || 'missing'}".`,
              false,
            );
            processed += 1;
          }
        }
      } catch (error) {
        logger.error({ err: error, deliveryActionId: action.id, kind }, '[DeliveryOutbox] Retry handler failed');
      }
    }
    return { processed, expired };
  }
}

export const deliveryOutboxService = new DeliveryOutboxService();
