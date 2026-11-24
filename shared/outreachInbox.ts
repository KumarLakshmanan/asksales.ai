export const INBOX_CHANNELS = [
  "email",
  "whatsapp",
  "instagram",
  "facebook",
  "sms",
] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];
export type InboxSort = "newest" | "oldest";

/** How a conversation started, from its first message. Exactly one per thread. */
export const INBOX_START_ORIGINS = ["outreach", "customer", "manual", "native_app"] as const;
export type InboxStartOrigin = (typeof INBOX_START_ORIGINS)[number];
/** Inbox filters: a start origin, or "ai" for threads the AI assistant replied in. */
export const INBOX_ORIGIN_FILTERS = [...INBOX_START_ORIGINS, "ai"] as const;
export type InboxOriginFilter = (typeof INBOX_ORIGIN_FILTERS)[number];

/** Who or what sent one outbound message, shown above it in the thread. */
export interface OutreachMessageOrigin {
  kind: "outreach" | "manual" | "ai" | "native_app" | "automation";
  /** Plain label, e.g. "AskSales outreach", "Sent from the WhatsApp app". */
  label: string;
  outreachName?: string | null;
  templateName?: string | null;
  followUpStep?: number | null;
}
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
  /** Always sent by the server; optional so older payloads still type-check. */
  origin?: InboxStartOrigin;
  aiHandled?: boolean;
  reply: InboxReplyAvailability;
}

export interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
  unreadThreads: Record<InboxChannel | "all", number>;
  /** Every thread the list can show (read and unread), per channel. */
  totalThreads?: Record<InboxChannel | "all", number>;
  /** Threads per origin filter, for the selected channel (or all channels). */
  originCounts?: Record<InboxOriginFilter, number>;
}
