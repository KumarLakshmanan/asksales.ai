import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { storageService } from '../StorageService.js';
import { whatsappApiService } from '../whatsappApiService.js';
import { deliveryOutboxService } from '../agents/orchestration/DeliveryOutboxService.js';
import { automaticSupportReplyAllowed } from '../agents/orchestration/SupportAutoReplyService.js';
import { approvedPdfBytesMatch, approvedSupportDocuments, type ApprovedSupportDocument } from './ApprovedSupportDocuments.js';
import type { SupportDeliveryOutboxRecord } from '../../models/supportOrchestration/schema.js';

export interface DocumentDeliveryResult { status: 'sent' | 'drafted' | 'unavailable' | 'uncertain'; actionId?: number; providerMessageId?: string | null }

export class SupportDocumentDelivery {
  private async eligible(action: SupportDeliveryOutboxRecord): Promise<boolean> {
    if (!await automaticSupportReplyAllowed(action.userId, 'whatsapp', action.payload.phoneNumberId, action.payload.metadata)) return false;
    const document = action.payload.metadata?.document as ApprovedSupportDocument | undefined;
    if (!document) return false;
    const result = await db.execute(sql`SELECT o.id FROM support_delivery_outbox o
      JOIN outreach_conversations c ON c.id=o.conversation_id AND c.user_id=o.user_id
      WHERE o.id=${action.id} AND o.user_id=${action.userId} AND o.status='sending'
        AND o.attempt_count=${action.attemptCount} AND (o.lease_expires_at AT TIME ZONE 'UTC')>NOW()
        AND c.channel='whatsapp' AND c.external_thread_id=${action.payload.recipient}
        AND c.automation_mode='ai_active' AND c.status NOT IN ('closed','unsubscribed')
        AND (${document.businessProfileId === null} OR
          c.business_profile_id=${document.businessProfileId})
        AND NOT EXISTS (SELECT 1 FROM handoff_queue h WHERE h.user_id=c.user_id AND h.conversation_id=c.id
          AND h.status IN ('waiting','assigned','in_progress'))`);
    return result.rows.length === 1;
  }

  async deliver(input: { document: ApprovedSupportDocument; userId: number; conversationId: number;
    recipient: string; caption: string; phoneNumberId?: string; inboundProviderMessageId?: string; inboundMessageId?: number }): Promise<DocumentDeliveryResult> {
    if (input.document.userId !== input.userId || (!input.inboundProviderMessageId && !input.inboundMessageId)
      || !input.caption.trim() || input.caption.length > 1024) {
      return { status: 'unavailable' };
    }
    const claim = await deliveryOutboxService.claim({ userId: input.userId, conversationId: input.conversationId,
      channel: 'whatsapp', inboundProviderMessageId: input.inboundProviderMessageId, inboundMessageId: input.inboundMessageId,
      partIndex: 2000, responseVersion: 1 }, {
      text: input.caption, recipient: input.recipient, phoneNumberId: input.phoneNumberId,
      metadata: { dispatchKind: 'support_document', document: input.document, messageType: 'document',
        fileName: `support-document-${input.document.id}.pdf`, documentTitle: input.document.title },
    });
    if (claim.state === 'already_sent') return { status: 'sent', actionId: claim.action.id, providerMessageId: claim.action.providerMessageId };
    if (claim.state === 'uncertain') return { status: 'uncertain', actionId: claim.action.id };
    if (claim.state === 'drafted') return { status: 'drafted', actionId: claim.action.id };
    return this.dispatchClaimed(claim.action);
  }

  async dispatchClaimed(action: SupportDeliveryOutboxRecord): Promise<DocumentDeliveryResult> {
    let dispatchStarted = false;
    try {
      if (await deliveryOutboxService.holdIfDisabled(action)) return { status: 'drafted', actionId: action.id };
      const document = action.payload.metadata?.document as ApprovedSupportDocument | undefined;
      if (action.channel !== 'whatsapp' || action.payload.metadata?.dispatchKind !== 'support_document'
        || !document || document.userId !== action.userId || !await this.eligible(action)
        || !await approvedSupportDocuments.revalidate(document)) throw new Error('Document delivery is no longer authorized.');
      const file = await storageService.downloadFile(document.storageFileId, action.userId);
      if (!file || file.file.userId !== action.userId
        || !approvedPdfBytesMatch(file.buffer, file.file.mimeType || '', document.checksum)) {
        throw new Error('The approved PDF is unavailable or its contents changed.');
      }
      if (await deliveryOutboxService.holdIfDisabled(action)) return { status: 'drafted', actionId: action.id };
      if (!await this.eligible(action) || !await approvedSupportDocuments.revalidate(document)) {
        throw new Error('Document approval or conversation eligibility changed.');
      }
      const filename = `support-document-${document.id}.pdf`;
      const uploaded = await whatsappApiService.uploadMedia({ userId: action.userId,
        phoneNumberId: action.payload.phoneNumberId || undefined, buffer: file.buffer, mimeType: 'application/pdf', fileName: filename });
      // Upload is not customer delivery. Recheck withdrawal, human ownership and
      // the outbox lease immediately before the message send.
      if (await deliveryOutboxService.holdIfDisabled(action)) return { status: 'drafted', actionId: action.id };
      if (!await this.eligible(action) || !await approvedSupportDocuments.revalidate(document)) {
        throw new Error('Document approval or conversation eligibility changed before send.');
      }
      dispatchStarted = true;
      const sent = await whatsappApiService.sendMedia({ userId: action.userId,
        phoneNumberId: action.payload.phoneNumberId || undefined, to: action.payload.recipient,
        mediaType: 'document', mediaId: uploaded.id, filename, caption: action.payload.text });
      const providerMessageId = sent.messages?.[0]?.id;
      if (!providerMessageId) throw new Error('WhatsApp document acknowledgement is missing.');
      await deliveryOutboxService.completeClaimedAction(action, providerMessageId);
      return { status: 'sent', actionId: action.id, providerMessageId };
    } catch (error) {
      const providerError = error as { deliveryAttempted?: boolean; outcomeUncertain?: boolean };
      const uncertain = dispatchStarted && providerError.deliveryAttempted !== false && providerError.outcomeUncertain !== false;
      // Fence stale attempts; never convert somebody else's uncertain receipt
      // into retryable failure. A new customer request can start a new delivery.
      await db.execute(sql`UPDATE support_delivery_outbox SET status=${uncertain ? 'uncertain' : 'failed'},
        last_error=${error instanceof Error ? error.message.slice(0, 1000) : 'Document delivery failed.'},
        next_attempt_at=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE id=${action.id} AND user_id=${action.userId} AND status='sending' AND attempt_count=${action.attemptCount}`);
      return { status: uncertain ? 'uncertain' : 'unavailable', actionId: action.id };
    }
  }
}

export const supportDocumentDelivery = new SupportDocumentDelivery();
