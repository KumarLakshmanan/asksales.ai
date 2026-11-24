import { businessAuditActor } from '../../tenancy/businessContext.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenantKnowledgeTransaction } from '../knowledge/KnowledgeTenantTransaction.js';
import { storageService } from '../StorageService.js';
import { approvedPdfBytesMatch } from './ApprovedSupportDocuments.js';
import { SUPPORT_REQUEST_SERVICES, type SupportSemanticIntent } from '../agents/orchestration/SupportSemanticIntent.js';
import { recordSupportAdminAudit } from '../agents/orchestration/SupportAdminAuditService.js';

export interface SupportLibraryDocument {
  id: number; title: string; description: string; service: SupportSemanticIntent['service'];
  businessProfileId: number | null; storageFileId: number; checksum: string;
  status: 'draft' | 'published' | 'withdrawn'; revision: number; approvalId: number | null;
  updatedAt: string; expiresAt: string | null;
}
export interface DocumentDraftInput {
  title: string; description: string; service: SupportSemanticIntent['service'];
  storageFileId: number; businessProfileId?: number | null;
}
const rowDocument = (row: Record<string, unknown>): SupportLibraryDocument => ({
  id: Number(row.id), title: String(row.title), description: String(row.description),
  service: row.service as SupportSemanticIntent['service'],
  businessProfileId: row.business_profile_id == null ? null : Number(row.business_profile_id),
  storageFileId: Number(row.storage_file_id), checksum: String(row.checksum),
  status: row.status === 'published' && row.approval_status !== undefined && row.approval_status !== 'published'
    ? 'withdrawn' : row.status as SupportLibraryDocument['status'], revision: Number(row.revision),
  approvalId: row.current_approval_id == null ? null : Number(row.current_approval_id),
  updatedAt: String(row.updated_at), expiresAt: row.expires_at == null ? null : String(row.expires_at),
});
function validateDraft(input: DocumentDraftInput) {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 180
    || typeof input.description !== 'string' || input.description.length > 2000
    || !SUPPORT_REQUEST_SERVICES.includes(input.service)
    || !Number.isSafeInteger(input.storageFileId) || input.storageFileId <= 0
    || (input.businessProfileId != null && (!Number.isSafeInteger(input.businessProfileId) || input.businessProfileId <= 0))) {
    throw new Error('Provide a title, document topic, valid PDF and optional owned business profile.');
  }
}
export class SupportDocumentLibrary {
  private async get(userId: number, id: number): Promise<SupportLibraryDocument | null> {
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`SELECT d.*,a.expires_at,a.status AS approval_status FROM support_document_library d
        LEFT JOIN support_approved_documents a ON a.id=d.current_approval_id AND a.user_id=d.user_id
        WHERE d.id=${id} AND d.user_id=${userId}`);
      return result.rows[0] ? rowDocument(result.rows[0] as Record<string, unknown>) : null;
    });
  }
  private async file(userId: number, fileId: number) {
    const file = await storageService.downloadFile(fileId, userId);
    if (!file || file.file.userId !== userId) throw new Error('Document file not found.');
    const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
    if (!approvedPdfBytesMatch(file.buffer, file.file.mimeType || '', checksum)) throw new Error('Use a PDF no larger than 20 MB.');
    return { ...file, checksum };
  }

  async list(userId: number): Promise<SupportLibraryDocument[]> {
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`SELECT d.*,a.expires_at,a.status AS approval_status FROM support_document_library d
        LEFT JOIN support_approved_documents a ON a.id=d.current_approval_id AND a.user_id=d.user_id
        WHERE d.user_id=${userId} ORDER BY d.updated_at DESC,d.id DESC LIMIT 500`);
      return result.rows.map((row: Record<string, unknown>) => rowDocument(row));
    });
  }

  async save(userId: number, input: DocumentDraftInput, existing?: { id: number; revision: number }) {
    validateDraft(input);
    const file = await this.file(userId, input.storageFileId);
    return withTenantKnowledgeTransaction(userId, async tx => {
      if (input.businessProfileId != null) {
        const profile = await tx.execute(sql`SELECT id FROM company_settings WHERE id=${input.businessProfileId} AND user_id=${userId}`);
        if (!profile.rows.length) throw new Error('Business profile not found.');
      }
      // The DB owner check is independent of the storage adapter's return value.
      const owned = await tx.execute(sql`SELECT id FROM storage_files WHERE id=${input.storageFileId}
        AND user_id=${userId} AND is_deleted=false AND mime_type='application/pdf'`);
      if (!owned.rows.length) throw new Error('Document file not found.');
      let before: Record<string, unknown> | undefined;
      if (existing) {
        const locked = await tx.execute(sql`SELECT * FROM support_document_library WHERE id=${existing.id} AND user_id=${userId} FOR UPDATE`);
        before = locked.rows[0] as Record<string, unknown> | undefined;
        if (!before) throw new Error('Document not found.');
        if (Number(before.revision) !== existing.revision) throw new Error('Document changed. Refresh before saving.');
        await tx.execute(sql`UPDATE support_approved_documents SET status='withdrawn',withdrawn_at=NOW(),
          withdrawal_reason='Document edited; new owner approval required.'
          WHERE id=${before.current_approval_id ?? null} AND user_id=${userId} AND status='published'`);
      }
      const result = existing
        ? await tx.execute(sql`UPDATE support_document_library SET title=${input.title.trim()},description=${input.description.trim()},
            service=${input.service},business_profile_id=${input.businessProfileId ?? requireBusinessScope().businessProfileId},storage_file_id=${input.storageFileId},
            checksum=${file.checksum},status='draft',current_approval_id=NULL,revision=revision+1,updated_at=NOW()
            WHERE id=${existing.id} AND user_id=${userId} RETURNING *`)
        : await tx.execute(sql`INSERT INTO support_document_library(user_id,business_profile_id,storage_file_id,title,description,service,checksum)
            VALUES(${userId},${input.businessProfileId ?? requireBusinessScope().businessProfileId},${input.storageFileId},${input.title.trim()},${input.description.trim()},${input.service},${file.checksum}) RETURNING *`);
      const document = rowDocument(result.rows[0] as Record<string, unknown>);
      await recordSupportAdminAudit(tx, { userId, actorType: 'owner', actorId: userId, action: 'document.draft_saved',
        entityType: 'support_document', entityId: document.id, beforeState: before, afterState: document });
      return document;
    });
  }

  async publish(userId: number, id: number, input: { revision: number; checksum: string; reason: string; certified: boolean; expiresAt?: string | null }) {
    if (input.certified !== true || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) {
      throw new Error('Confirm customer-sharing rights and provide an approval reason.');
    }
    if (input.expiresAt != null && (typeof input.expiresAt !== 'string' || !input.expiresAt.trim())) throw new Error('Provide a valid expiry date.');
    const expiry = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) throw new Error('Expiry must be in the future.');
    // Take a snapshot for slow file IO; recheck revision/checksum under the lock.
    const snapshot = await this.get(userId, id);
    if (!snapshot) throw new Error('Document not found.');
    if (snapshot.revision !== input.revision || snapshot.checksum !== input.checksum) throw new Error('Document changed. Refresh and review the current PDF.');
    const file = await this.file(userId, snapshot.storageFileId);
    if (file.checksum !== snapshot.checksum) throw new Error('The PDF changed. Upload and review it again.');
    return withTenantKnowledgeTransaction(userId, async tx => {
      const locked = await tx.execute(sql`SELECT * FROM support_document_library WHERE id=${id} AND user_id=${userId} FOR UPDATE`);
      const row = locked.rows[0] as Record<string, unknown> | undefined;
      if (!row || Number(row.revision) !== input.revision || row.checksum !== input.checksum) throw new Error('Document changed. Refresh before publishing.');
      if (snapshot.businessProfileId != null) {
        const profile = await tx.execute(sql`SELECT id FROM company_settings WHERE id=${snapshot.businessProfileId} AND user_id=${userId}`);
        if (!profile.rows.length) throw new Error('Business profile not found.');
      }
      const previousApproval = await tx.execute(sql`SELECT * FROM support_approved_documents
        WHERE user_id=${userId} AND storage_file_id=${snapshot.storageFileId} AND service=${snapshot.service} AND checksum=${snapshot.checksum}`);
      const approved = await tx.execute(sql`INSERT INTO support_approved_documents
        (user_id,business_profile_id,storage_file_id,title,service,checksum,approval_reason,approved_by,expires_at)
        SELECT ${userId},${snapshot.businessProfileId},f.id,${snapshot.title},${snapshot.service},${snapshot.checksum},
          ${input.reason.trim()},${businessAuditActor(userId)},${expiry?.toISOString() ?? null}::timestamptz
        FROM storage_files f WHERE f.id=${snapshot.storageFileId} AND f.user_id=${userId} AND f.is_deleted=false AND f.mime_type='application/pdf'
        ON CONFLICT(business_profile_id, user_id,storage_file_id,service,checksum) DO UPDATE SET status='published',
          title=EXCLUDED.title,business_profile_id=EXCLUDED.business_profile_id,approval_reason=EXCLUDED.approval_reason,
          approved_by=EXCLUDED.approved_by,approved_at=NOW(),expires_at=EXCLUDED.expires_at,withdrawn_at=NULL,withdrawal_reason=NULL RETURNING id`);
      if (!approved.rows[0]) throw new Error('Document file not found.');
      const result = await tx.execute(sql`UPDATE support_document_library SET status='published',current_approval_id=${Number(approved.rows[0].id)},
        revision=revision+1,updated_at=NOW() WHERE id=${id} AND user_id=${userId} RETURNING *`);
      const document = rowDocument({ ...result.rows[0], expires_at: expiry?.toISOString() ?? null });
      await recordSupportAdminAudit(tx, { userId, actorType: 'owner', actorId: userId, action: 'document.published',
        entityType: 'support_document', entityId: id, beforeState: row, afterState: document,
        metadata: { reason: input.reason.trim(), certified: true, checksum: input.checksum, previousApproval: previousApproval.rows[0] ?? null } });
      return document;
    });
  }

  async withdraw(userId: number, id: number, input: { revision: number; reason: string }) {
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) throw new Error('Provide a withdrawal reason.');
    return withTenantKnowledgeTransaction(userId, async tx => {
      const locked = await tx.execute(sql`SELECT * FROM support_document_library WHERE id=${id} AND user_id=${userId} FOR UPDATE`);
      const before = locked.rows[0] as Record<string, unknown> | undefined;
      if (!before) throw new Error('Document not found.');
      if (Number(before.revision) !== input.revision) throw new Error('Document changed. Refresh before withdrawing.');
      await tx.execute(sql`UPDATE support_approved_documents SET status='withdrawn',withdrawn_at=NOW(),withdrawal_reason=${input.reason.trim()}
        WHERE id=${before.current_approval_id ?? null} AND user_id=${userId} AND status='published'`);
      const result = await tx.execute(sql`UPDATE support_document_library SET status='withdrawn',revision=revision+1,updated_at=NOW()
        WHERE id=${id} AND user_id=${userId} RETURNING *`);
      const document = rowDocument(result.rows[0] as Record<string, unknown>);
      await recordSupportAdminAudit(tx, { userId, actorType: 'owner', actorId: userId, action: 'document.withdrawn',
        entityType: 'support_document', entityId: id, beforeState: before, afterState: document, metadata: { reason: input.reason.trim() } });
      return document;
    });
  }

  async download(userId: number, id: number) {
    const document = await this.get(userId, id);
    if (!document) throw new Error('Document not found.');
    const file = await this.file(userId, document.storageFileId);
    if (file.checksum !== document.checksum) throw new Error('Stored PDF changed; upload a new draft.');
    return { buffer: file.buffer, title: document.title };
  }
}
export const supportDocumentLibrary = new SupportDocumentLibrary();
