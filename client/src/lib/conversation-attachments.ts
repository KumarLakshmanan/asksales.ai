export const MAX_CONVERSATION_ATTACHMENTS = 5;
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

export const CONVERSATION_ATTACHMENT_ACCEPT =
  '.pdf,.json,.txt,.csv,.docx,.xlsx';

export interface ConversationAttachment {
  fileId: number;
  name: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
  extractionSource?: string;
  extractionWarnings?: string[];
}

export interface PendingConversationAttachment extends ConversationAttachment {
  localId: string;
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
