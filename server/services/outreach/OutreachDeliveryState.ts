import { sql, type SQL } from 'drizzle-orm';

/**
 * The one definition of where an outbound message stands. Message tracking
 * shows these states directly; campaign Reports folds them into its coarser
 * states with `reportStateSql`, so the two pages can never disagree about a
 * message.
 */

/** Raw statuses, grouped. Older senders and imported history use the second spelling of each. */
export const rawStatuses = {
  read: ['read'],
  delivered: ['delivered'],
  sent: ['sent', 'accepted', 'opened', 'clicked', 'replied'],
  review: ['manual_review', 'setup_required'],
  cancelled: ['cancelled'],
  failed: ['failed', 'bounced'],
  sending: ['sending', 'processing'],
  waiting: ['pending', 'queued'],
} as const;

/**
 * Every raw status a recipient filter's states can come from. Each list is a
 * superset, so it only narrows rows before the exact state is worked out.
 * Delivered, read and needs attention can come from almost any raw status
 * (a receipt or a review flag wins), so they have no list.
 */
export const recipientRawStatuses: Partial<Record<string, readonly string[]>> = {
  sent: rawStatuses.sent,
  // A failed attempt put back in the queue reads as waiting.
  waiting: [...rawStatuses.waiting, ...rawStatuses.sending, ...rawStatuses.failed],
  failed: rawStatuses.failed,
  cancelled: rawStatuses.cancelled,
};

/** Why a waiting message is held back by a sending limit rather than its schedule. */
export const limitReasons = ['daily_allowance', 'provider_limit', 'app_rate_limit'] as const;

const list = (values: readonly string[]) => sql.join(values.map(value => sql`${value}`), sql`,`);

export interface DeliveryStateColumns {
  status: SQL;
  deliveredAt: SQL;
  readAt: SQL;
  /** Boolean: someone has to look at this message before it can go. */
  needsReview: SQL;
  /** Boolean: a failed attempt that has been put back in the queue. */
  requeued: SQL;
  /** Boolean: the message ran out of time in the queue. */
  expired: SQL;
  /** Text: why a waiting message is held. */
  waitReason: SQL;
  /** Timestamp: when a waiting message is next due, or NULL. */
  nextAttemptAt: SQL;
}

/**
 * One delivery state per message. Receipts win over everything; a message put
 * back in the queue is never reported as failed.
 */
export function deliveryStateSql(c: DeliveryStateColumns): SQL {
  return sql`(CASE
  WHEN ${c.status} IN(${list(rawStatuses.read)}) OR ${c.readAt} IS NOT NULL THEN 'read'
  WHEN ${c.status} IN(${list(rawStatuses.delivered)}) OR ${c.deliveredAt} IS NOT NULL THEN 'delivered'
  WHEN ${c.status} IN(${list(rawStatuses.sent)}) THEN 'sent'
  WHEN ${c.needsReview} OR ${c.status} IN(${list(rawStatuses.review)}) THEN 'needs_attention'
  WHEN ${c.status} IN(${list(rawStatuses.cancelled)}) THEN 'cancelled'
  WHEN ${c.status} IN(${list(rawStatuses.failed)}) AND ${c.requeued} THEN 'waiting'
  WHEN ${c.status} IN(${list(rawStatuses.failed)}) AND ${c.expired} THEN 'expired'
  WHEN ${c.status} IN(${list(rawStatuses.failed)}) THEN 'failed'
  WHEN ${c.status} IN(${list(rawStatuses.sending)}) THEN 'sending'
  WHEN ${c.status} IN(${list(rawStatuses.waiting)}) AND ${c.waitReason} IN(${list(limitReasons)}) THEN 'waiting_limit'
  WHEN ${c.status} IN(${list(rawStatuses.waiting)}) AND ${c.nextAttemptAt}>now() THEN 'scheduled'
  WHEN ${c.status} IN(${list(rawStatuses.waiting)}) THEN 'waiting'
  ELSE 'needs_attention' END)`;
}

/** Reports' coarser states, folded from the tracking states. */
export function reportStateSql(state: SQL): SQL {
  return sql`(CASE ${state}
  WHEN 'read' THEN 'delivered' WHEN 'delivered' THEN 'delivered'
  WHEN 'sent' THEN 'accepted'
  WHEN 'needs_attention' THEN 'review'
  WHEN 'scheduled' THEN 'queued' WHEN 'waiting' THEN 'queued' WHEN 'waiting_limit' THEN 'queued'
  WHEN 'sending' THEN 'processing'
  WHEN 'failed' THEN 'failed' WHEN 'expired' THEN 'failed'
  WHEN 'cancelled' THEN 'cancelled'
  ELSE 'review' END)`;
}

/** When a waiting outreach message is next due. Saved as ISO text by the sender. */
const nextAttemptText = sql`COALESCE(m.metadata->'outreachQueue'->>'nextAttemptAt',m.metadata->>'scheduledAt')`;
export const messageNextAttemptAt = sql`(CASE WHEN ${nextAttemptText} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (${nextAttemptText})::timestamptz END)`;

/**
 * The provider error code saved on an `outreach_messages m` row, or NULL when
 * it no longer explains the message.
 *
 * `outreachQueue.providerCode` is written only when WhatsApp's marketing limit
 * (131049) puts a message back in the queue. It explains the message while that
 * retry is waiting or sending, or when nothing else was recorded. A later
 * attempt that ends the message with its own error keeps the old code: on one
 * business, 5,800 failures read "Provider code 131049" beside "the sending
 * account was disconnected" or "insufficient credits", attempts that never
 * reached WhatsApp.
 */
export const messageProviderCode = sql`(CASE WHEN m.status IN(${list([...rawStatuses.waiting, ...rawStatuses.sending])})
    OR m.metadata->'outreachQueue'->>'enqueueNeeded'='true' OR NULLIF(m.error_message,'') IS NULL
  THEN m.metadata->'outreachQueue'->>'providerCode' END)`;

/** The delivery state of an `outreach_messages m` row. */
export const messageDeliveryState = deliveryStateSql({
  status: sql`m.status`, deliveredAt: sql`m.delivered_at`, readAt: sql`m.read_at`,
  needsReview: sql`COALESCE(m.manual_review_required,false)`,
  requeued: sql`m.metadata->'outreachQueue'->>'enqueueNeeded'='true'`,
  expired: sql`(m.metadata->'outreachQueue'->>'reason'='expired' OR COALESCE(m.error_message,'') LIKE '%queue lifetime expired%')`,
  waitReason: sql`m.metadata->'outreachQueue'->>'reason'`,
  nextAttemptAt: messageNextAttemptAt,
});
