import type { SocialMessageMetadata } from '../../../../shared/socialMessageMetadata';
/**
 * Shared types for outreach pages
 */

export interface OutreachConversation {
  id: number;
  userId: number;
  leadId: number;
  channel: string;
  providerAccountId?: string | null;
  providerAccountName?: string | null;
  leadName: string | null;
  leadEmail?: string | null;
  leadInstagram?: string | null;
  leadPhone?: string | null;
  leadLinkedin?: string | null;
  leadTwitter?: string | null;
  leadAvatar: string | null;
  leadCompany: string | null;
  subject?: string | null;
  status: string;
  lastMessageAt: string | null;
  lastMessageBy: string | null;
  lastMessagePreview: string | null;
  totalMessages: number;
  unreadCount: number;
  integrationProvider?: string | null;
  threadKey: string;
  externalThreadId?: string | null;
}

export interface OutreachMessage {
  /** Who or what sent an outbound message (outreach, manual, AI, phone app). */
  origin?: import('../../../../shared/outreachInbox').OutreachMessageOrigin | null;
  emailTracking?: { source: 'image_load'; enabled: boolean; openedAt: string | null; openCount: number };
  messageKind?: string;
  followUpStep?: number | null;
  id: number;
  conversationId: number;
  direction: string;
  subject?: string | null;
  content: string;
  htmlContent?: string | null;
  imageUrl?: string | null;
  attachments?: Array<{
    id?: string;
    fileId?: number | null;
    fileName?: string;
    filename?: string;
    originalName?: string;
    path?: string;
    url?: string;
    inlineUrl?: string;
    downloadUrl?: string;
    contentType?: string;
    mimeType?: string;
    size?: number;
    status?: string;
    extractionStatus?: string;
    extractionError?: string | null;
    deliveryStatus?: string;
    deliveryError?: string | null;
    providerAttachmentId?: string | null;
    providerMediaId?: string | null;
    mediaKind?: 'image' | 'video' | 'audio' | 'voice' | 'file' | string | null;
    transcriptionLanguage?: string | null;
  }> | null;
  status: string;
  errorMessage?: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  metadata?: SocialMessageMetadata | null;
  isRead: boolean;
  createdAt: string;
}

export type OutreachChannel = 'email' | 'instagram' | 'sms' | 'whatsapp' | 'facebook' | 'twitter' | 'linkedin';
