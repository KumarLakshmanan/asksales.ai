import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { assistantResourceIds } from '../assistants/AssistantContext.js';
import { knowledgeBigintArray } from '../knowledge/KnowledgeSql.js';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenantKnowledgeTransaction } from '../knowledge/KnowledgeTenantTransaction.js';
import { storageService } from '../StorageService.js';
import { SUPPORT_REQUEST_SERVICES, confidentSemanticIntent, type SupportSemanticIntent } from '../agents/orchestration/SupportSemanticIntent.js';

export interface ApprovedSupportDocument {
  id: number;
  userId: number;
  businessProfileId: number | null;
  storageFileId: number;
  title: string;
  service: SupportSemanticIntent['service'];
  checksum: string;
}

const MAX_PDF_BYTES = 20 * 1024 * 1024;
export function approvedPdfBytesMatch(buffer: Buffer, mimeType: string, checksum: string): boolean {
  return mimeType === 'application/pdf' && buffer.length > 8 && buffer.length <= MAX_PDF_BYTES
    && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
    && crypto.createHash('sha256').update(buffer).digest('hex') === checksum;
}

export function requestedDocumentService(input: {
  semanticRequest?: SupportSemanticIntent; channel: string; publicReply?: boolean; outboundFirstTouch?: boolean;
  authenticatedWidget?: boolean;
  playbookDirective?: { documentService?: unknown; capability?: { name?: string; validationErrors?: string[] } };
}): SupportSemanticIntent['service'] | null {
  if (!(input.channel === 'whatsapp' || (input.channel === 'web' && input.authenticatedWidget === true)) || input.publicReply || input.outboundFirstTouch) return null;
  const directive = input.playbookDirective;
  if (directive?.capability?.name === 'asset.deliver') {
    return !directive.capability.validationErrors?.length
      && (SUPPORT_REQUEST_SERVICES as readonly unknown[]).includes(directive.documentService)
      ? directive.documentService as SupportSemanticIntent['service'] : null;
  }
  const request = confidentSemanticIntent(input.semanticRequest);
  return request?.explicit && request.action === 'document' ? request.service : null;
}

function documentRow(row: Record<string, unknown>): ApprovedSupportDocument {
  return { id: Number(row.id), userId: Number(row.user_id),
    businessProfileId: row.business_profile_id == null ? null : Number(row.business_profile_id),
    storageFileId: Number(row.storage_file_id), title: String(row.title),
    service: row.service as SupportSemanticIntent['service'], checksum: String(row.checksum) };
}

export class ApprovedSupportDocuments {
  /** Explicit operator approval of an inspected binary; KB publication alone is
   * never consent to distribute its original file. No inbound/model values call this. */
  async approve(input: { userId: number; businessProfileId?: number | null; storageFileId: number;
    title: string; service: SupportSemanticIntent['service']; checksum: string; approvalReason: string }) {
    if (!SUPPORT_REQUEST_SERVICES.includes(input.service) || !input.title.trim() || input.title.length > 180
      || !input.approvalReason.trim() || !/^[a-f0-9]{64}$/.test(input.checksum)) throw new Error('Invalid document approval.');
    const file = await storageService.downloadFile(input.storageFileId, input.userId);
    if (!file || file.file.userId !== input.userId || !approvedPdfBytesMatch(file.buffer, file.file.mimeType || '', input.checksum)) {
      throw new Error('The owned PDF does not match the exact inspected binary.');
    }
    return withTenantKnowledgeTransaction(input.userId, async tx => {
      if (input.businessProfileId != null) {
        const profile = await tx.execute(sql`SELECT id FROM company_settings WHERE id=${input.businessProfileId} AND user_id=${input.userId}`);
        if (!profile.rows.length) throw new Error('The business profile is not owned by this tenant.');
      }
      const result = await tx.execute(sql`INSERT INTO support_approved_documents
        (user_id,business_profile_id,storage_file_id,title,service,checksum,approval_reason,approved_by)
        SELECT ${input.userId},${input.businessProfileId ?? null},f.id,${input.title.trim()},${input.service},
          ${input.checksum},${input.approvalReason.trim()},${input.userId}
        FROM storage_files f WHERE f.id=${input.storageFileId} AND f.user_id=${input.userId}
          AND f.is_deleted=false AND f.mime_type='application/pdf'
        ON CONFLICT(business_profile_id, user_id,storage_file_id,service,checksum) DO NOTHING RETURNING *`);
      // Repeating approval must not silently republish a withdrawn association.
      return result.rows[0] ? documentRow(result.rows[0] as Record<string, unknown>) : null;
    });
  }

  async find(userId: number, businessProfileId: number | null, service: SupportSemanticIntent['service']): Promise<ApprovedSupportDocument | null> {
    const ids=assistantResourceIds('documents');
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`SELECT a.* FROM support_approved_documents a
        JOIN storage_files f ON f.id=a.storage_file_id AND f.user_id=a.user_id
        WHERE a.user_id=${userId} AND a.status='published' AND a.withdrawn_at IS NULL
          AND ${ids === undefined ? sql`TRUE` : sql`a.id = ANY(${knowledgeBigintArray([...ids])})`}
          AND (a.expires_at IS NULL OR a.expires_at>NOW()) AND a.service=${service}
          AND a.approved_by=a.user_id AND f.is_deleted=false AND f.mime_type='application/pdf'
          AND (a.business_profile_id IS NULL OR a.business_profile_id=${businessProfileId ?? currentBusinessScope()?.businessProfileId ?? null})
        ORDER BY a.id LIMIT 2`);
      // Multiple approved matches need owner disambiguation, not an arbitrary
      // file choice or inference from a filename.
      return result.rows.length === 1 ? documentRow(result.rows[0] as Record<string, unknown>) : null;
    });
  }

  async revalidate(document: ApprovedSupportDocument): Promise<boolean> {
    const ids=assistantResourceIds('documents');
    return withTenantKnowledgeTransaction(document.userId, async tx => {
      const result = await tx.execute(sql`SELECT a.id FROM support_approved_documents a
        JOIN storage_files f ON f.id=a.storage_file_id AND f.user_id=a.user_id
        WHERE a.id=${document.id} AND a.user_id=${document.userId} AND a.status='published' AND a.withdrawn_at IS NULL
          AND ${ids === undefined ? sql`TRUE` : sql`a.id = ANY(${knowledgeBigintArray([...ids])})`}
          AND (a.expires_at IS NULL OR a.expires_at>NOW()) AND a.service=${document.service}
          AND a.checksum=${document.checksum} AND a.storage_file_id=${document.storageFileId}
          AND a.approved_by=a.user_id AND f.is_deleted=false AND f.mime_type='application/pdf'
          AND a.business_profile_id IS NOT DISTINCT FROM ${document.businessProfileId}::integer`);
      return result.rows.length === 1;
    });
  }

  async candidates(userId: number, businessProfileId: number | null, service: SupportSemanticIntent['service'], libraryId?: number): Promise<Array<{
    document: ApprovedSupportDocument; description: string; libraryId: number | null;
  }>> {
    const ids=assistantResourceIds('documents');
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`SELECT a.*,d.id AS library_id,COALESCE(d.description,'') AS description
        FROM support_approved_documents a JOIN storage_files f ON f.id=a.storage_file_id AND f.user_id=a.user_id
        LEFT JOIN support_document_library d ON d.current_approval_id=a.id AND d.user_id=a.user_id AND d.status='published'
        WHERE a.user_id=${userId} AND a.status='published' AND a.withdrawn_at IS NULL
          AND ${ids === undefined ? sql`TRUE` : sql`a.id = ANY(${knowledgeBigintArray([...ids])})`}
          AND (a.expires_at IS NULL OR a.expires_at>NOW()) AND a.service=${service}
          AND a.approved_by=a.user_id AND f.is_deleted=false AND f.mime_type='application/pdf'
          AND (a.business_profile_id IS NULL OR a.business_profile_id=${businessProfileId ?? currentBusinessScope()?.businessProfileId ?? null})
          AND (${libraryId == null} OR d.id=${libraryId ?? null})
        ORDER BY a.id LIMIT 21`);
      return result.rows.map((row: Record<string, unknown>) => ({ document: documentRow(row),
        description: String(row.description || ''), libraryId: row.library_id == null ? null : Number(row.library_id) }));
    });
  }

  async withdraw(userId: number, documentId: number, reason: string): Promise<boolean> {
    if (!Number.isSafeInteger(documentId) || documentId <= 0 || !reason.trim()) throw new Error('A document and withdrawal reason are required.');
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`UPDATE support_approved_documents SET status='withdrawn',withdrawn_at=NOW(),
        withdrawal_reason=${reason.trim()} WHERE id=${documentId} AND user_id=${userId} AND status='published' RETURNING id`);
      return result.rows.length === 1;
    });
  }
}

export const approvedSupportDocuments = new ApprovedSupportDocuments();
