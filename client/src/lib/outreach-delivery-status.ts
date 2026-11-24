/**
 * Plain-language delivery status for an outbound outreach message.
 *
 * `manual_review` means the message was handed to the provider but no
 * confirmation came back (a timeout, or no provider receipt). It was neither
 * confirmed sent nor rejected, and it is never retried automatically, so a
 * duplicate cannot reach the customer. We show it as pending confirmation, with
 * what to do next, never as the internal reason text.
 */
export type OutboundDeliveryLabel = 'Sent' | 'Delivered' | 'Read' | 'Failed' | 'Pending' | 'Pending confirmation';

export const UNCONFIRMED_DELIVERY_DETAIL = "The provider didn't confirm whether this message was delivered. It won't be resent automatically, to avoid a duplicate. Check the conversation or the provider's sent log before sending it again.";

/** Older rows stored internal reasons such as "could not be authoritatively confirmed". */
const INTERNAL_UNCERTAIN_REASON = /authoritatively confirmed|did not return a delivery receipt|manual review is required|before reconciliation|outcome (?:is )?(?:unknown|uncertain)/i;

export function outboundDeliveryLabel(status: string | null | undefined): OutboundDeliveryLabel | null {
  switch (status) {
    case 'sent': return 'Sent';
    case 'delivered': return 'Delivered';
    case 'read': case 'seen': return 'Read';
    case 'failed': case 'bounced': case 'rejected': return 'Failed';
    case 'manual_review': return 'Pending confirmation';
    case 'pending': case 'queued': case 'sending': return 'Pending';
    default: return null;
  }
}

/** The note shown under a failed or unconfirmed message; null when there is nothing to explain. */
export function outboundDeliveryDetail(status: string | null | undefined, errorMessage: string | null | undefined): string | null {
  const reason = errorMessage?.trim() || '';
  if (status === 'manual_review') return reason && !INTERNAL_UNCERTAIN_REASON.test(reason) ? reason : UNCONFIRMED_DELIVERY_DETAIL;
  if (status === 'failed' || status === 'bounced' || status === 'rejected') {
    if (!reason) return 'The provider rejected this message.';
    return INTERNAL_UNCERTAIN_REASON.test(reason) ? UNCONFIRMED_DELIVERY_DETAIL : reason;
  }
  return null;
}

/** Use for any provider reason shown to people, e.g. tracking rows that mix old and new wording. */
export function plainDeliveryReason(reason: string): string {
  if (INTERNAL_UNCERTAIN_REASON.test(reason)) return UNCONFIRMED_DELIVERY_DETAIL;
  const known = PLAIN_REASON_PATTERNS.find(([pattern]) => pattern.test(reason));
  if (known) return known[1];
  const code = /^([A-Z][A-Z0-9_]{3,}):\s*/.exec(reason.trim());
  if (code && INTERNAL_REASON_TEXT[code[1]]) return INTERNAL_REASON_TEXT[code[1]];
  // Internal codes such as "ASSISTANT_SETUP_REQUIRED: …" are for logs, not people.
  return code ? reason.trim().slice(code[0].length) : reason;
}

/** Older internal reasons, rewritten as what happened and what to do. */
const PLAIN_REASON_PATTERNS: Array<[RegExp, string]> = [
  [/confirmed official provider account is not ready or no longer matches/i,
    "The sending account was disconnected or changed before these went out. Reconnect it in Integrations, then send again."],
  [/queue confirmation is uncertain/i,
    "We couldn't confirm these were queued. Check the conversation before sending them again, to avoid a duplicate."],
];

/** Plain wording for internal reason codes that reach reports. */
const INTERNAL_REASON_TEXT: Record<string, string> = {
  ASSISTANT_SETUP_REQUIRED: "The account's assistant changed or isn't published, so these weren't sent. Review the assistant in Outreach settings, then send again.",
};
