export const INBOX_CHANNELS = [
  "email",
  "whatsapp",
  "instagram",
  "facebook",
  "sms",
] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];
import type { CustomerDeliveryReadiness } from './customerDeliveryReadiness.js';

export interface InboxReplyAvailability {
  canReply: boolean;
  reason: string | null;
  accountLabel: string | null;
  providerAccountId: string | null;
  senderId?: number;
  requiresTemplate?: boolean;
  assistant?: CustomerDeliveryReadiness;
}

export interface InboxItem {
  key: string;
  kind: "conversation" | "legacy";
  id: number;
  channel: InboxChannel;
  leadId: number;
  leadName: string;
  leadEmail: string | null;
  leadPhone: string | null;
  leadCompany: string | null;
  leadAvatar: string | null;
  recipient: string | null;
  subject: string | null;
  preview: string;
  activityAt: string;
  unreadCount: number;
  totalMessages: number;
  status: string;
  integrationProvider: string | null;
  reply: InboxReplyAvailability;
}

export interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
  unreadThreads: Record<InboxChannel | "all", number>;
}
