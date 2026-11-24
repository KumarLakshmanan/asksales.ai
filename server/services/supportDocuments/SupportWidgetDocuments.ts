import { sql } from 'drizzle-orm';
import { withTenantKnowledgeTransaction } from '../knowledge/KnowledgeTenantTransaction.js';
import { approvedPdfBytesMatch, approvedSupportDocuments, type ApprovedSupportDocument } from './ApprovedSupportDocuments.js';
import { storageService } from '../StorageService.js';

export type WidgetDocumentAttachment = ApprovedSupportDocument;

/** Validate the current approval and exact private bytes before offering or serving a PDF. */
export async function loadApprovedWidgetDocument(document: ApprovedSupportDocument) {
  if (!await approvedSupportDocuments.revalidate(document)) return null;
  const file = await storageService.downloadFile(document.storageFileId, document.userId);
  if (!file || file.file.userId !== document.userId
    || !approvedPdfBytesMatch(file.buffer, file.file.mimeType || '', document.checksum)
    || !await approvedSupportDocuments.revalidate(document)) return null;
  return { buffer: file.buffer, title: document.title };
}

/** Server-side confirmation that this attachment was actually persisted, not a model claim. */
export async function verifyWidgetDocumentReceipt(userId: number, conversationId: number,
  receipt: { sessionId: number; messageId: number; documentId: number }) {
  if (!receipt || receipt.sessionId !== -conversationId
    || ![userId, receipt.sessionId, receipt.messageId, receipt.documentId].every(id => Number.isSafeInteger(id) && id > 0)) return false;
  return withTenantKnowledgeTransaction(userId, async tx => {
    const result = await tx.execute(sql`SELECT m.metadata->'documents' AS documents
      FROM support_chat_messages m JOIN support_chat_sessions s ON s.id=m.session_id
      JOIN team_members member ON member.id=s.member_id JOIN support_teams team ON team.id=member.team_id
      WHERE m.id=${receipt.messageId} AND m.session_id=${receipt.sessionId} AND m.role='assistant'
        AND member.user_id=${userId} AND team.user_id=${userId}`);
    const documents = result.rows[0]?.documents;
    return Array.isArray(documents) && documents.some(item => item?.id === receipt.documentId && item.userId === userId);
  });
}

/** Raw retrieval excerpts are operator evidence, not customer-approved assets.
 * Strip them on both new responses and historical-message reads, along with
 * private storage identifiers and approval internals. */
export function publicWidgetMessage<T extends { metadata?: unknown }>(message: T): T {
  const publicMessage = { ...message } as T & Record<string, unknown>;
  for (const key of ['deferredCommit', 'deferred_commit', 'commitToken', 'commit_token', 'processingExpiresAt', 'processing_expires_at']) delete publicMessage[key];
  if (!message.metadata || typeof message.metadata !== 'object') return { ...publicMessage, sources: [] };
  const metadata = { ...message.metadata as Record<string, unknown> };
  delete metadata.supportTurn; delete metadata.deferredCommit; delete metadata.requestInputHash;
  delete metadata.assistant; delete metadata.assistantAwayReceipt;
  const documents = Array.isArray(metadata.documents) ? metadata.documents
    .filter(item => Number.isSafeInteger(item?.id) && item.id > 0 && typeof item.title === 'string')
    .map(item => ({ id: item.id, title: item.title })) : [];
  return { ...publicMessage, sources: [], metadata: { ...metadata, documents } };
}

/** A session credential is required in addition to the public widget token.
 * Only a document persisted on this session's assistant message is downloadable. */
export async function downloadWidgetDocument(input: { userId: number; teamId: number; sessionId: number;
  sessionToken: string; messageId: number; documentId: number }) {
  if (![input.userId,input.teamId,input.sessionId,input.messageId,input.documentId].every(id => Number.isSafeInteger(id) && id > 0)
    || !input.sessionToken) return null;
  const document = await withTenantKnowledgeTransaction(input.userId, async tx => {
    const result = await tx.execute(sql`SELECT m.metadata->'documents' AS documents
      FROM support_chat_sessions s JOIN team_members member ON member.id=s.member_id
      JOIN support_teams team ON team.id=member.team_id
      JOIN support_chat_messages m ON m.session_id=s.id
      WHERE s.id=${input.sessionId} AND s.public_token=${input.sessionToken}
        AND s.session_expires_at>NOW() AND member.is_active=true AND team.is_active=true
        AND member.user_id=${input.userId} AND team.user_id=${input.userId} AND team.id=${input.teamId}
        AND m.id=${input.messageId} AND m.role='assistant' AND m.processing_status='completed'`);
    const items = result.rows[0]?.documents;
    if (!Array.isArray(items)) return null;
    return items.find((item: WidgetDocumentAttachment) => item?.id === input.documentId && item.userId === input.userId) as WidgetDocumentAttachment | undefined;
  });
  return document ? loadApprovedWidgetDocument(document) : null;
}
