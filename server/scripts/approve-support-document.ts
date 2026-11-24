import { parseArgs } from 'node:util';
import { approvedSupportDocuments, approvedPdfBytesMatch } from '../services/supportDocuments/ApprovedSupportDocuments.js';
import { SUPPORT_REQUEST_SERVICES, type SupportSemanticIntent } from '../services/agents/orchestration/SupportSemanticIntent.js';
import { storageService } from '../services/StorageService.js';

// Operator-only command. It never sends a file or takes approval from a model.
const { values } = parseArgs({ options: {
  'user-id': { type: 'string' }, 'file-id': { type: 'string' }, 'profile-id': { type: 'string' },
  service: { type: 'string' }, title: { type: 'string' }, checksum: { type: 'string' },
  reason: { type: 'string' }, apply: { type: 'boolean', default: false },
  'withdraw-id': { type: 'string' },
  library: { type: 'boolean', default: false }, description: { type: 'string' },
} });
const userId = Number(values['user-id']); const fileId = Number(values['file-id']);
const profileId = values['profile-id'] ? Number(values['profile-id']) : null;
if (values['withdraw-id']) {
  const documentId = Number(values['withdraw-id']);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(documentId) || documentId <= 0 || !values.reason?.trim()) {
    throw new Error('Provide owner, approval ID and withdrawal reason.');
  }
  const applied = values.apply ? await approvedSupportDocuments.withdraw(userId,documentId,values.reason) : false;
  console.log(JSON.stringify({ dryRun: !values.apply, applied, userId, documentId, operation: 'withdraw' }));
  process.exit(0);
}
if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0
  || (profileId !== null && (!Number.isSafeInteger(profileId) || profileId <= 0))
  || !SUPPORT_REQUEST_SERVICES.includes(values.service as SupportSemanticIntent['service'])
  || !values.title || !values.reason || !values.checksum) throw new Error('Provide owner, exact file/checksum, topic, title and recorded approval reason.');
const file = await storageService.downloadFile(fileId,userId);
if (!file || file.file.userId !== userId || !approvedPdfBytesMatch(file.buffer,file.file.mimeType || '',values.checksum)) {
  throw new Error('The stored owned PDF does not match the approved binary.');
}
if (values.library) {
  if (!values.description?.trim()) throw new Error('Library publication requires an accurate customer-facing description.');
  const { supportDocumentLibrary } = await import('../services/supportDocuments/SupportDocumentLibrary.js');
  const existing = (await supportDocumentLibrary.list(userId)).filter(item => item.storageFileId === fileId && item.service === values.service);
  if (existing.length) {
    // Never overwrite an edited draft or revive a withdrawn approval by rerunning
    // a release command. Existing matching publications are safe to retry.
    if (existing.length !== 1 || existing[0].status !== 'published' || existing[0].checksum !== values.checksum
      || existing[0].businessProfileId !== profileId || existing[0].title !== values.title
      || existing[0].description !== values.description) throw new Error('Existing library entry differs; review it in Documents.');
    console.log(JSON.stringify({ applied: false, alreadyPublished: true, libraryId: existing[0].id, userId, fileId }));
  } else if (values.apply) {
    const draft = await supportDocumentLibrary.save(userId, { storageFileId: fileId, businessProfileId: profileId,
      title: values.title, service: values.service as SupportSemanticIntent['service'], description: values.description });
    if (draft.checksum !== values.checksum) throw new Error('PDF changed while preparing its draft; review before publishing.');
    const published = await supportDocumentLibrary.publish(userId, draft.id, { revision: draft.revision,
      checksum: values.checksum, certified: true, reason: values.reason });
    console.log(JSON.stringify({ applied: true, libraryId: published.id, documentId: published.approvalId, userId, fileId }));
  } else {
    console.log(JSON.stringify({ dryRun: true, valid: true, userId, fileId, service: values.service, checksum: values.checksum, operation: 'publish_library' }));
  }
  process.exit(0);
}
if (values.apply) {
  const result = await approvedSupportDocuments.approve({ userId, storageFileId: fileId, businessProfileId: profileId,
    title: values.title, service: values.service as SupportSemanticIntent['service'], checksum: values.checksum, approvalReason: values.reason });
  console.log(JSON.stringify({ applied: Boolean(result), documentId: result?.id || null, fileId, userId }));
} else {
  console.log(JSON.stringify({ dryRun: true, valid: true, userId, fileId, service: values.service, checksum: values.checksum }));
}
process.exit(0);
