/**
 * Message tracking: one record per outreach launch and the delivery state of
 * every message it created. Shared by the API and the tracking pages.
 */

/** One message's place in its journey, derived from the saved message row. */
export const deliveryStates = [
  'scheduled', 'waiting', 'waiting_limit', 'sending', 'sent', 'delivered', 'read',
  'failed', 'expired', 'needs_attention', 'cancelled',
] as const;
export type DeliveryState = typeof deliveryStates[number];

/** Plain-language name for each state, used on screen and in downloads. */
export const deliveryStateLabels: Record<DeliveryState, string> = {
  scheduled: 'Scheduled', waiting: 'Waiting to send', waiting_limit: 'Waiting for sending limit', sending: 'Sending',
  sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', expired: 'Expired',
  needs_attention: 'Needs attention', cancelled: 'Cancelled',
};

/** The groups a person filters the recipient list by. */
export const recipientFilters = ['all', 'waiting', 'sent', 'delivered', 'read', 'failed', 'needs_attention', 'cancelled'] as const;
export type RecipientFilter = typeof recipientFilters[number];

export const recipientFilterStates: Record<Exclude<RecipientFilter, 'all'>, readonly DeliveryState[]> = {
  waiting: ['scheduled', 'waiting', 'waiting_limit', 'sending'],
  sent: ['sent'],
  delivered: ['delivered'],
  read: ['read'],
  failed: ['failed', 'expired'],
  needs_attention: ['needs_attention'],
  cancelled: ['cancelled'],
};

export interface BatchCounts {
  total: number;
  scheduled: number;
  waiting: number;
  waitingLimit: number;
  sending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  expired: number;
  needsAttention: number;
  cancelled: number;
}

export const emptyBatchCounts = (): BatchCounts => ({
  total: 0, scheduled: 0, waiting: 0, waitingLimit: 0, sending: 0, sent: 0, delivered: 0, read: 0,
  failed: 0, expired: 0, needsAttention: 0, cancelled: 0,
});

/** Accepted by the provider: sent, and everything that later got a delivery or read receipt. */
export const reachedCount = (counts: BatchCounts) => counts.sent + counts.delivered + counts.read;
/** A read receipt implies delivery. */
export const deliveredCount = (counts: BatchCounts) => counts.delivered + counts.read;
export const waitingCount = (counts: BatchCounts) => counts.scheduled + counts.waiting + counts.waitingLimit + counts.sending;
export const failedCount = (counts: BatchCounts) => counts.failed + counts.expired;

export const recipientFilterCount = (counts: BatchCounts, filter: RecipientFilter): number => {
  switch (filter) {
    case 'all': return counts.total;
    case 'waiting': return waitingCount(counts);
    case 'sent': return counts.sent;
    case 'delivered': return counts.delivered;
    case 'read': return counts.read;
    case 'failed': return failedCount(counts);
    case 'needs_attention': return counts.needsAttention;
    case 'cancelled': return counts.cancelled;
  }
};

/**
 * Whether the channel tells us a message was delivered or read. Without
 * receipts, delivered and read are unknown rather than zero.
 */
export type ReceiptSupport = 'full' | 'partial' | 'none';

/** Channels whose provider sends no delivery or read receipts back. */
export const channelsWithoutReceipts = ['gmail', 'sms', 'linkedin', 'x', 'twitter'] as const;

export type OutreachBatchSource = 'new_outreach' | 'prepared' | 'assistant' | 'legacy_inferred' | 'legacy_prepared';
export type OutreachBatchAdmission = 'admitting' | 'queued' | 'interrupted';

/** The single word shown for a whole outreach. */
export type OutreachProgress = 'preparing' | 'scheduled' | 'sending' | 'waiting_limit' | 'needs_attention' | 'not_sent' | 'finished_with_failures' | 'finished';

/** Still has messages to send; the page keeps refreshing while it does. */
export const activeOutreachProgress: readonly OutreachProgress[] = ['preparing', 'scheduled', 'sending', 'waiting_limit'];

export function outreachProgress(counts: BatchCounts, admission: OutreachBatchAdmission): OutreachProgress {
  if (admission === 'admitting') return 'preparing';
  const waiting = waitingCount(counts);
  if (waiting > 0 && waiting === counts.scheduled && reachedCount(counts) === 0) return 'scheduled';
  // Every unsent message is held by a sending limit (daily allowance or WhatsApp's), so nothing is going out now.
  if (waiting > 0 && waiting === counts.waitingLimit) return 'waiting_limit';
  if (waiting > 0) return 'sending';
  if (counts.needsAttention > 0) return 'needs_attention';
  // Nothing left to send. Say plainly when none, or only some, of it got through.
  if (failedCount(counts) > 0) return reachedCount(counts) === 0 ? 'not_sent' : 'finished_with_failures';
  return 'finished';
}

export interface OutreachBatch {
  id: string;
  name: string;
  channel: string;
  providerAccountId: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  source: OutreachBatchSource;
  admission: OutreachBatchAdmission;
  createdAt: string;
  scheduledAt: string | null;
  expiresAt: string | null;
  /** Recipients in the reviewed launch. */
  requested: number;
  /** Recipients who never got a message row: opted out, invalid number and so on. */
  skipped: number;
  receiptSupport: ReceiptSupport;
}

export interface OutreachBatchListItem extends OutreachBatch {
  counts: BatchCounts;
}

export interface OutreachBatchList {
  items: OutreachBatchListItem[];
  page: number;
  pageSize: number;
  total: number;
  /** Every message of every outreach that matches the filters, not only this page. */
  totals: BatchCounts;
}

export interface OutreachBatchSummary {
  batch: OutreachBatch;
  counts: BatchCounts;
  followUps: BatchCounts;
  skippedReasons: Array<{ reason: string; count: number }>;
  /** Earliest time a waiting message is due; null when nothing waits or no time is recorded. */
  nextAttemptAt: string | null;
  /** The last time anything was sent, delivered, read or failed; null before the first send. */
  lastActivityAt: string | null;
  checkedAt: string;
}

export interface OutreachRecipient {
  messageId: number;
  conversationId: number;
  leadId: number | null;
  name: string;
  /** Phone number, email address or handle, depending on the channel. */
  recipient: string | null;
  state: DeliveryState;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  nextAttemptAt: string | null;
  /** Why the message failed or is being held, as recorded by the sender. */
  reason: string | null;
  providerCode: string | null;
}

export interface OutreachRecipientPage {
  items: OutreachRecipient[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: number | null;
}

export interface OutreachFailureReason {
  reason: string;
  providerCode: string | null;
  count: number;
}

const channelNames: Record<string, string> = {
  whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', gmail: 'Email', resend: 'Email', instagram: 'Instagram',
  facebook: 'Messenger', linkedin: 'LinkedIn', twitter: 'X (Twitter)', web: 'Website chat',
};
export const trackingChannelLabel = (channel: string) =>
  channelNames[channel] || (channel ? channel[0].toUpperCase() + channel.slice(1) : 'Message');

export const outreachTrackingUrl = (id?: string) => id ? `/dashboard/outreach/tracking/${id}` : '/dashboard/outreach/tracking';

/** What happened on one calendar day. Each number is counted on the day that thing happened. */
export interface DailyActivityDay {
  /** YYYY-MM-DD in the requested timezone. */
  date: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

export interface DailyActivity {
  timezone: string;
  from: string;
  to: string;
  /** Every day in the range, including days where nothing happened. */
  days: DailyActivityDay[];
  totals: Omit<DailyActivityDay, 'date'>;
}

export const dailyActivitySeries = ['sent', 'delivered', 'read', 'failed'] as const;
export type DailyActivitySeries = typeof dailyActivitySeries[number];
export const dailyActivityLabels: Record<DailyActivitySeries, string> = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

/** The longest span one day-by-day request may cover. */
export const MAX_DAILY_RANGE_DAYS = 93;

/** How one template performed for the messages sent with it in a date range. */
export interface TemplatePerformance {
  templateName: string;
  templateLanguage: string | null;
  /** Tracked outreaches that used it in the range. */
  outreaches: number;
  sent: number;
  /** Of the messages sent in the range. */
  delivered: number;
  read: number;
  /** Messages with this template that failed in the range. */
  failed: number;
  lastSentAt: string | null;
}

export interface TemplatePerformanceReport {
  timezone: string;
  from: string;
  to: string;
  templates: TemplatePerformance[];
}

/** One day of the sending schedule. Days are the days your sending limit runs on, shown as your local date. */
export interface UpcomingDay {
  date: string;
  /** Messages whose next attempt falls on this day. */
  due: number;
  /** Estimate of how many the daily limit lets through. */
  expectedToSend: number;
  /** Estimate of how many are still waiting at the end of the day. */
  held: number;
  /** Estimate of how many run out of time on this day. */
  willExpire: number;
  /** The outreaches with the most messages due this day. */
  outreaches: Array<{ batchId: string; name: string; due: number }>;
}

export interface UpcomingSchedule {
  timezone: string;
  from: string;
  until: string;
  days: UpcomingDay[];
  /** The daily limit of each channel that has messages waiting, and how much of today's is used. */
  limits: Array<{ channel: string; dailyLimit: number; usedToday: number }>;
  /** When the daily limit next resets. */
  limitResetsAt: string;
  /** Everything waiting right now. */
  waiting: number;
  /** Estimate of what is still waiting after the last day shown. */
  afterRange: number;
}

/** How far ahead the schedule may look. */
export const MAX_UPCOMING_DAYS = 62;
