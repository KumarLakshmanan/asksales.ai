import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { storageService } from '../StorageService.js';
import { whatsappApiService } from '../whatsappApiService.js';
import { getInstagramApiForUser } from '../instagramGraphApiService.js';
import { getFacebookApiForUser } from '../FacebookMessengerService.js';
import { withTenantSupportMediaTransaction } from './SupportMediaTenantTransaction.js';
import { createSupportMediaDeliveryUrl } from './SupportMediaDeliveryUrl.js';
import type { VerifiedSupportMedia } from './types.js';
import { mediaGateway } from './MediaGateway.js';
import { mediaDeliveryDiagnostics, mediaDeliveryFailureCode } from './MediaDeliveryDiagnostics.js';
import { automaticSupportReplyAllowed } from '../agents/orchestration/SupportAutoReplyService.js';
import { deliveryOutboxService } from '../agents/orchestration/DeliveryOutboxService.js';
import { resultRows } from '../../utils/queryRows.js';
export { mediaDeliveryFailureCode } from './MediaDeliveryDiagnostics.js';

export function createMediaPartIdempotencyKey(input: {
  userId: number; inboundId: string; decisionVersion: number; assetVersion: string; partIndex: number; channel: string;
}) {
  return crypto.createHash('sha256').update([
    input.userId, input.inboundId, input.decisionVersion, input.assetVersion, 'image', input.partIndex, input.channel,
  ].join(':')).digest('hex');
}

export function mediaDeliveryOutcomeIsUncertain(error: unknown): boolean {
  const providerError = error as { deliveryAttempted?: boolean; outcomeUncertain?: boolean } | null;
  if (typeof providerError?.outcomeUncertain === 'boolean') return providerError.outcomeUncertain;
  return providerError?.deliveryAttempted === true;
}

export class SupportMediaDeliveryService {
  async pendingReconciliation(userId: number) {
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      // A process can stop after provider dispatch but before the acknowledgement is persisted.
      await tx.execute(sql`UPDATE support_media_delivery_parts SET status='uncertain',reconciliation_state='pending',
        failure_code='DISPATCH_INTERRUPTED',updated_at=NOW() WHERE user_id=${userId} AND status='sending' AND updated_at < NOW()-INTERVAL '5 minutes'`);
      return resultRows(await tx.execute(sql`SELECT p.id,p.conversation_id,p.channel,p.asset_id,p.status,p.provider_message_id,
        p.failure_code,p.failure_reason,p.attempts,p.updated_at,a.name,
        c.provider_account_id,c.external_thread_id,c.status AS conversation_status
        FROM support_media_delivery_parts p JOIN support_media_assets a ON a.id=p.asset_id AND a.user_id=p.user_id
        LEFT JOIN outreach_conversations c ON c.id=p.conversation_id AND c.user_id=p.user_id AND c.channel=p.channel
        WHERE p.user_id=${userId} AND p.status IN ('uncertain','failed') ORDER BY p.updated_at DESC LIMIT 100`)).map((part) => {
          // Provider messages can contain signed URLs; expose only safe, structured guidance.
          const { failure_reason: _reason, provider_account_id: _account, external_thread_id: _thread, ...safe } = part;
          return { ...safe, ...mediaDeliveryDiagnostics(part) };
        });
    });
  }

  async reconcile(userId: number, partId: number, input: { outcome: 'delivered' | 'not_delivered'; reason: string; providerMessageId?: string }) {
    if (!['delivered', 'not_delivered'].includes(input.outcome) || !input.reason?.trim() || input.reason.length > 2000) {
      throw new Error('Confirm the provider outcome and record the evidence used to verify it.');
    }
    if (input.outcome === 'delivered' && !input.providerMessageId?.trim()) throw new Error('A provider message ID is required to confirm delivery.');
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      const part = resultRows(await tx.execute(sql`SELECT id FROM support_media_delivery_parts
        WHERE id=${partId} AND user_id=${userId} AND status='uncertain' FOR UPDATE`))[0];
      if (!part) throw new Error('An unresolved media delivery was not found.');
      await tx.execute(sql`INSERT INTO support_media_review_audits(user_id,delivery_part_id,decision,reason,provider_message_id)
        VALUES(${userId},${partId},${input.outcome},${input.reason.trim()},${input.providerMessageId?.trim().slice(0,255) || null})`);
      await tx.execute(sql`UPDATE support_media_delivery_parts SET status=${input.outcome === 'delivered' ? 'provider_acknowledged' : 'failed'},
        reconciliation_state='resolved',provider_message_id=COALESCE(${input.providerMessageId?.trim().slice(0,255) || null},provider_message_id),
        failure_code=${input.outcome === 'delivered' ? null : 'CONFIRMED_NOT_DELIVERED'},updated_at=NOW()
        WHERE id=${partId} AND user_id=${userId} AND status='uncertain'`);
      return { resolved: true, retryEligible: input.outcome === 'not_delivered' };
    });
  }

  async retryFailedPart(userId: number, partId: number) {
    const part = await withTenantSupportMediaTransaction(userId, async (tx) => resultRows(await tx.execute(sql`
      SELECT p.*,c.external_thread_id,c.provider_account_id,c.metadata AS conversation_metadata
      FROM support_media_delivery_parts p JOIN outreach_conversations c ON c.id=p.conversation_id AND c.user_id=p.user_id
      WHERE p.id=${partId} AND p.user_id=${userId} AND p.status='failed' AND c.channel=p.channel
        AND c.status<>'closed' LIMIT 1
    `))[0]);
    if (!part || !['whatsapp','instagram','facebook'].includes(String(part.channel)) || !part.external_thread_id) {
      throw new Error('A failed delivery with an active linked provider conversation is required. Verify uncertain deliveries first.');
    }
    if (['instagram', 'facebook'].includes(String(part.channel)) && !part.provider_account_id) {
      throw new Error('This historical conversation has no verified sending account. Wait for a new inbound message on the connected account and send an approved image in that conversation.');
    }
    const originalKey = createMediaPartIdempotencyKey({ userId,
      inboundId: String(part.inbound_provider_message_id || part.inbound_message_id || 'missing'), decisionVersion: 1,
      assetVersion: String(part.asset_version), partIndex: Number(part.part_index), channel: String(part.channel) });
    if (originalKey !== part.idempotency_key) throw new Error('This historical delivery cannot be retried safely. Send an approved image in a new reply.');
    const metadata = (part.conversation_metadata || {}) as Record<string, unknown>;
    const profileId = Number(metadata.businessProfileId || metadata.business_profile_id || 0);
    const verified = await mediaGateway.verify(userId, String(part.channel), {
      intent: part.media_intent === 'explicit' ? 'explicit' : 'helpful', reason: 'Owner retry of confirmed failed delivery',
      selections: [{ evidenceId: String(part.evidence_id), order: 0 }],
    }, { businessProfileId: Number.isSafeInteger(profileId) && profileId > 0 ? profileId : null, audience: 'customer', purpose: 'support_answer' });
    if (verified.length !== 1 || verified[0].checksum !== part.asset_version) throw new Error('The original image is no longer published or allowed for this conversation. Select an approved image in a new reply.');
    await withTenantSupportMediaTransaction(userId, async (tx) => {
      await tx.execute(sql`INSERT INTO support_media_review_audits(user_id,delivery_part_id,decision,reason)
        VALUES(${userId},${partId},'retry','Owner retried a confirmed failed image after current publication and channel verification.')`);
    });
    return this.deliverDirect({ userId, conversationId: Number(part.conversation_id),
      channel: part.channel as 'whatsapp' | 'instagram' | 'facebook', recipient: String(part.external_thread_id),
      providerAccountId: part.provider_account_id ? String(part.provider_account_id) : undefined,
      phoneNumberId: typeof metadata.phoneNumberId === 'string' ? metadata.phoneNumberId : undefined,
      inboundProviderMessageId: part.inbound_provider_message_id ? String(part.inbound_provider_message_id) : undefined,
      inboundMessageId: part.inbound_message_id ? Number(part.inbound_message_id) : undefined,
      decisionAuditId: part.decision_audit_id ? Number(part.decision_audit_id) : undefined,
      partIndexOffset: Number(part.part_index), media: verified });
  }

  async recordDeferredAcknowledgement(input: {
    userId: number; conversationId: number; channel: string; inboundId: string;
    providerMessageId?: string | null; media: VerifiedSupportMedia[];
  }): Promise<void> {
    for (let index = 0; index < input.media.slice(0, 5).length; index++) {
      const media = input.media[index];
      const key = createMediaPartIdempotencyKey({ userId: input.userId, inboundId: input.inboundId,
        decisionVersion: 1, assetVersion: media.checksum, partIndex: index, channel: input.channel });
      await withTenantSupportMediaTransaction(input.userId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO support_media_delivery_parts(
            user_id,conversation_id,channel,inbound_provider_message_id,asset_id,evidence_id,asset_version,
            part_index,media_intent,required,idempotency_key,status,provider_message_id,attempts
          ) VALUES (${input.userId},${input.conversationId},${input.channel},${input.inboundId},${media.assetId},${media.evidenceId},
            ${media.checksum},${index},${media.intent},${media.intent === 'explicit'},${key},'provider_acknowledged',${input.providerMessageId || null},1)
          ON CONFLICT (idempotency_key) DO UPDATE SET status='provider_acknowledged',
            provider_message_id=COALESCE(EXCLUDED.provider_message_id,support_media_delivery_parts.provider_message_id),updated_at=NOW()
        `);
      });
    }
  }

  async deliverDirect(input: {
    userId: number; conversationId: number; channel: 'whatsapp' | 'instagram' | 'facebook';
    recipient: string; phoneNumberId?: string; providerAccountId?: string;
    inboundProviderMessageId?: string; inboundMessageId?: number; decisionAuditId?: number;
    partIndexOffset?: number;
    media: VerifiedSupportMedia[];
  }): Promise<{ status: 'sent' | 'drafted' | 'sent_media_degraded' | 'media_not_supported'; sent: number; failed: number }> {
    const holdMedia = async (media: VerifiedSupportMedia, index: number) => {
      await deliveryOutboxService.draft({ userId: input.userId, conversationId: input.conversationId, channel: input.channel,
        inboundProviderMessageId: input.inboundProviderMessageId, inboundMessageId: input.inboundMessageId,
        partIndex: 3000 + index + (input.partIndexOffset || 0) }, {
        text: media.caption || media.altText || media.name, recipient: input.recipient, phoneNumberId: input.phoneNumberId,
        metadata: { dispatchKind: 'support_media', providerAccountId: input.providerAccountId, draftMedia: [media] },
      });
    };
    if (!await automaticSupportReplyAllowed(input.userId, input.channel, input.phoneNumberId || input.providerAccountId)) {
      for (const [index, media] of input.media.slice(0,5).entries()) await holdMedia(media,index);
      return { status: 'drafted', sent: 0, failed: 0 };
    }
    if (process.env.SUPPORT_MEDIA_DELIVERY_ENABLED === 'false' || input.media.length === 0) {
      return { status: input.media.length ? 'media_not_supported' : 'sent', sent: 0, failed: 0 };
    }
    const inboundId = input.inboundProviderMessageId || String(input.inboundMessageId || 'missing');
    let sent = 0;
    let failed = 0;
    let drafted = false;
    for (let index = 0; index < input.media.slice(0, 5).length; index++) {
      const media = input.media[index];
      const idempotencyKey = createMediaPartIdempotencyKey({
        userId: input.userId, inboundId, decisionVersion: 1, assetVersion: media.checksum, partIndex: index + (input.partIndexOffset || 0), channel: input.channel,
      });
      const claim = await withTenantSupportMediaTransaction(input.userId, async (tx) => {
        const inserted = resultRows(await tx.execute(sql`
          INSERT INTO support_media_delivery_parts(
            user_id,conversation_id,channel,inbound_provider_message_id,inbound_message_id,decision_audit_id,
            asset_id,evidence_id,asset_version,part_index,media_intent,required,idempotency_key,status,attempts
          ) VALUES (${input.userId},${input.conversationId},${input.channel},${input.inboundProviderMessageId || null},
            ${input.inboundMessageId || null},${input.decisionAuditId || null},${media.assetId},${media.evidenceId},${media.checksum},
            ${index + (input.partIndexOffset || 0)},${media.intent},${media.intent === 'explicit'},${idempotencyKey},'sending',1)
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING *
        `));
        if (inserted[0]) return { owned: true, row: inserted[0] };
        const existing = resultRows(await tx.execute(sql`SELECT * FROM support_media_delivery_parts WHERE idempotency_key=${idempotencyKey}`))[0];
        if (existing?.status === 'failed') {
          const reclaimed = resultRows(await tx.execute(sql`
            UPDATE support_media_delivery_parts SET status='sending',attempts=attempts+1,updated_at=NOW()
            WHERE id=${Number(existing.id)} AND status='failed' RETURNING *
          `));
          if (reclaimed[0]) return { owned: true, row: reclaimed[0] };
        }
        return { owned: false, row: existing };
      });
      if (!claim.owned) {
        if (['sent', 'provider_acknowledged'].includes(String(claim.row?.status))) sent++;
        else if (claim.row?.status === 'drafted') drafted = true;
        else failed++;
        continue;
      }
      const claimStillOwned = async () => {
        if (!await automaticSupportReplyAllowed(input.userId, input.channel, input.phoneNumberId || input.providerAccountId)) {
          await holdMedia(media,index);
          drafted = true;
          await withTenantSupportMediaTransaction(input.userId, tx => tx.execute(sql`UPDATE support_media_delivery_parts SET status='drafted',updated_at=NOW()
            WHERE id=${Number(claim.row.id)} AND user_id=${input.userId} AND status='sending'`));
          return false;
        }
        const owned = await withTenantSupportMediaTransaction(input.userId, async (tx) => Boolean(resultRows(await tx.execute(sql`
        SELECT id FROM support_media_delivery_parts WHERE id=${Number(claim.row.id)} AND user_id=${input.userId}
          AND status='sending' AND attempts=${Number(claim.row.attempts)}
      `))[0]));
        if (!owned) return false;
        const conversation = await withTenantSupportMediaTransaction(input.userId, async (tx) => resultRows(await tx.execute(sql`
          SELECT c.business_profile_id FROM outreach_conversations c
          WHERE c.id=${input.conversationId} AND c.user_id=${input.userId} AND c.channel=${input.channel}
            AND c.external_thread_id=${input.recipient} AND c.automation_mode='ai_active'
            AND c.status NOT IN ('closed','unsubscribed')
            AND (${input.channel}='whatsapp' OR c.provider_account_id=${input.providerAccountId || null})
            AND NOT EXISTS (SELECT 1 FROM handoff_queue h WHERE h.user_id=c.user_id AND h.conversation_id=c.id
              AND h.status IN ('waiting','assigned','in_progress') AND h.ai_reply_enabled=FALSE)
        `))[0]);
        const verified = conversation ? await mediaGateway.verify(input.userId, input.channel, {
          intent: media.intent, reason: 'Revalidate current media authorization before dispatch',
          selections: [{ evidenceId: media.evidenceId, order: 0 }],
        }, { businessProfileId: conversation.business_profile_id == null ? null : Number(conversation.business_profile_id),
          audience: 'customer', purpose: 'support_answer' }) : [];
        if (verified.length !== 1 || verified[0].assetId !== media.assetId || verified[0].checksum !== media.checksum
          || verified[0].derivativeStorageFileId !== media.derivativeStorageFileId) {
          throw Object.assign(new Error('The image or conversation is no longer authorized for customer delivery.'), {
            deliveryAttempted: false, outcomeUncertain: false,
          });
        }
        return true;
      };
      let dispatchStarted = false;
      try {
        const file = await storageService.downloadFile(media.derivativeStorageFileId, input.userId);
        if (!file) throw new Error('The verified delivery derivative is unavailable.');
        // A delayed download may outlive reconciliation. Fence the old attempt
        // before every provider dispatch so it cannot race an operator retry.
        if (!await claimStillOwned()) { failed++; continue; }
        let providerMediaId: string | null = null;
        let providerMessageId: string | null = null;
        if (input.channel === 'whatsapp') {
          const upload = await whatsappApiService.uploadMedia({ userId: input.userId, phoneNumberId: input.phoneNumberId,
            buffer: file.buffer, mimeType: media.mimeType, fileName: `${media.name}.jpg` });
          providerMediaId = upload.id;
          if (!await claimStillOwned()) { failed++; continue; }
          dispatchStarted = true;
          const response = await whatsappApiService.sendMedia({ userId: input.userId, phoneNumberId: input.phoneNumberId,
            // Gallery descriptions may contain stale commercial facts and were
            // repeated on every image. The text answer already introduces the
            // gallery; deliver its verified pixels without repeating that copy.
            to: input.recipient, mediaType: 'image', mediaId: upload.id });
          providerMessageId = response.messages?.[0]?.id || null;
        } else {
          if (!input.providerAccountId) throw Object.assign(new Error('The conversation has no verified sending account. Wait for a new inbound message on the connected account.'), {
            errorCode: 'PROVIDER_ACCOUNT_UNBOUND', deliveryAttempted: false, outcomeUncertain: false,
          });
          const signedUrl = createSupportMediaDeliveryUrl({ assetId: media.assetId, checksum: media.checksum });
          if (input.channel === 'instagram') {
            const service = await getInstagramApiForUser(input.userId,
              input.providerAccountId ? { accountIdentifier: input.providerAccountId } : {});
            if (!service) throw new Error('Instagram credentials are unavailable.');
            if (!await claimStillOwned()) { failed++; continue; }
            dispatchStarted = true;
            const response = await service.sendMessageWithAttachment(input.recipient, 'image', signedUrl);
            if (!response.success) throw Object.assign(new Error(response.error || 'Instagram rejected the image.'), {
              errorCode: response.errorCode,
              deliveryAttempted: response.deliveryAttempted,
              outcomeUncertain: response.outcomeUncertain,
            });
            providerMediaId = response.attachmentId || null;
            providerMessageId = response.messageId || null;
          } else {
            const service = await getFacebookApiForUser(input.userId, input.providerAccountId);
            if (!service) throw new Error('Facebook credentials are unavailable.');
            if (!await claimStillOwned()) { failed++; continue; }
            dispatchStarted = true;
            const response = await service.sendMessageWithAttachment(input.recipient, 'image', signedUrl);
            if (!response.success) throw Object.assign(new Error(response.error || 'Facebook rejected the image.'), {
              errorCode: response.errorCode,
              deliveryAttempted: response.deliveryAttempted,
              outcomeUncertain: response.outcomeUncertain,
            });
            providerMessageId = response.messageId || null;
          }
        }
        if (!providerMessageId) throw Object.assign(new Error('The provider returned no message acknowledgement. Verify the conversation before resending.'), {
          deliveryAttempted: true, outcomeUncertain: true,
        });
        await withTenantSupportMediaTransaction(input.userId, async (tx) => {
          await tx.execute(sql`UPDATE support_media_delivery_parts SET status='provider_acknowledged',provider_media_id=${providerMediaId},
            provider_message_id=${providerMessageId},updated_at=NOW() WHERE id=${Number(claim.row.id)} AND status='sending'
              AND attempts=${Number(claim.row.attempts)}`);
        });
        sent++;
      } catch (error) {
        const providerError = error as { deliveryAttempted?: boolean; outcomeUncertain?: boolean } | null;
        const uncertain = mediaDeliveryOutcomeIsUncertain(error)
          || (dispatchStarted && providerError?.deliveryAttempted !== false && providerError?.outcomeUncertain !== false);
        const failureCode = uncertain ? 'PROVIDER_OUTCOME_UNCERTAIN' : mediaDeliveryFailureCode(error);
        await withTenantSupportMediaTransaction(input.userId, async (tx) => {
          await tx.execute(sql`UPDATE support_media_delivery_parts SET status=${uncertain ? 'uncertain' : 'failed'},
            failure_code=${failureCode},
            failure_reason=${error instanceof Error ? error.message.slice(0, 1000) : 'Media delivery failed'},
            reconciliation_state=${uncertain ? 'pending' : 'not_required'},updated_at=NOW()
            WHERE id=${Number(claim.row.id)} AND status='sending' AND attempts=${Number(claim.row.attempts)}`);
        });
        failed++;
      }
    }
    return { status: drafted ? 'drafted' : failed > 0 ? 'sent_media_degraded' : 'sent', sent, failed: drafted ? 0 : failed };
  }
}

export const supportMediaDeliveryService = new SupportMediaDeliveryService();
