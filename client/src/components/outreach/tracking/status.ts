import type { StatusTone } from "@/components/ui/status-badge";
import { plainDeliveryReason } from "@/lib/outreach-delivery-status";
import {
  deliveryStateLabels, deliveryStates, trackingChannelLabel,
  type DeliveryState, type OutreachProgress, type OutreachRecipient, type ReceiptSupport, type RecipientFilter,
} from "../../../../../shared/outreachTracking";

const deliveryStateTones: Record<DeliveryState, StatusTone> = {
  scheduled: "info", waiting: "neutral", waiting_limit: "warning", sending: "progress", sent: "success", delivered: "success",
  read: "success", failed: "danger", expired: "danger", needs_attention: "warning", cancelled: "neutral",
};
/** Plain-language name and colour for each message state. The names are shared with the CSV download. */
export const deliveryStateDisplay = Object.fromEntries(deliveryStates.map(state =>
  [state, { label: deliveryStateLabels[state], tone: deliveryStateTones[state] }])) as Record<DeliveryState, { label: string; tone: StatusTone }>;

export const outreachProgressDisplay: Record<OutreachProgress, { label: string; tone: StatusTone }> = {
  preparing: { label: "Preparing", tone: "progress" },
  scheduled: { label: "Scheduled", tone: "info" },
  sending: { label: "Sending", tone: "progress" },
  waiting_limit: { label: "Waiting for sending limit", tone: "warning" },
  needs_attention: { label: "Needs attention", tone: "warning" },
  not_sent: { label: "Not sent", tone: "danger" },
  finished_with_failures: { label: "Finished with failures", tone: "warning" },
  finished: { label: "Finished", tone: "success" },
};

export const recipientFilterLabels: Record<RecipientFilter, string> = {
  all: "All", waiting: "Waiting", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed", needs_attention: "Needs attention",
  cancelled: "Cancelled",
};

/** Shown in place of delivered and read numbers when the channel never reports them. */
export const NOT_REPORTED = "Not reported";

/** A delivered or read number, or "Not reported" when the channel sends no receipts. */
export const receiptValue = (support: ReceiptSupport, value: number) => support === "none" ? NOT_REPORTED : formatCount(value);

/** Why delivered and read are missing or incomplete for this outreach; null when receipts are complete. */
export function receiptNote(support: ReceiptSupport, channel: string): string | null {
  if (support === "none") return `${trackingChannelLabel(channel)} doesn't tell us when a message is delivered or read, so only sent and failed are known.`;
  if (support === "partial") return "Some of the mailboxes used don't report delivery or reads, so delivered and read are lower than the real numbers.";
  return null;
}

/** What the common WhatsApp error codes mean for the person sending. */
const providerCodeHelp: Record<string, string> = {
  "130429": "WhatsApp is limiting how fast this account can send. These are retried automatically.",
  "131026": "This number can't receive the message. It may not be on WhatsApp, or it hasn't accepted WhatsApp's latest terms.",
  "131047": "More than 24 hours have passed since this person last wrote to you, so only an approved template can be sent.",
  "131048": "WhatsApp is limiting this account because recipients have blocked or reported its messages.",
  "131049": "WhatsApp held this back so the person doesn't get too many marketing messages. It is retried later.",
  "131056": "Too many messages were sent to this number in a short time.",
  "132000": "The template was sent with the wrong number of values.",
  "132001": "The template doesn't exist in this language, or it is no longer approved.",
};

export function failureExplanation(providerCode: string | null, reason: string): string {
  if (providerCode && providerCodeHelp[providerCode]) return providerCodeHelp[providerCode];
  if (/queue lifetime expired/i.test(reason)) return "It wasn't sent before its time ran out, so it expired. Send a new outreach to reach these people.";
  if (/sending allowance is disabled/i.test(reason)) return "Daily sending is switched off for this channel. Turn it on in your sending settings, then retry.";
  return plainDeliveryReason(reason);
}

/** The short note under a recipient's status. */
export function recipientNote(recipient: OutreachRecipient): string | null {
  switch (recipient.state) {
    // The same state covers the account's daily allowance and WhatsApp's own limits.
    case "waiting_limit": return recipient.providerCode && providerCodeHelp[recipient.providerCode]
      ? providerCodeHelp[recipient.providerCode] : "Held until your daily sending limit resets";
    case "expired": return "Not sent before its time ran out";
    case "failed":
    case "needs_attention": return recipient.reason ? failureExplanation(recipient.providerCode, recipient.reason) : null;
    default: return null;
  }
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const formatDateTime = (value: string | number | null | undefined) => value ? dateTime.format(new Date(value)) : "";
export const formatCount = (value: number) => value.toLocaleString();
export const formatShare = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";

/** The most recent thing that happened to a message, in words. Follows the state, so a held message never reads as sent. */
export function recipientLastUpdate(recipient: OutreachRecipient): string {
  const at = (label: string, value: string | null, fallback: string) => value ? `${label} ${formatDateTime(value)}` : fallback;
  switch (recipient.state) {
    case "read": return at("Read", recipient.readAt || recipient.deliveredAt || recipient.sentAt, "Read");
    case "delivered": return at("Delivered", recipient.deliveredAt || recipient.sentAt, "Delivered");
    case "sent": return at("Sent", recipient.sentAt, "Sent");
    case "failed":
    case "expired": return at("Failed", recipient.failedAt, "Not sent");
    case "scheduled":
    case "waiting":
    case "waiting_limit": return at("Due", recipient.nextAttemptAt, "Not sent yet");
    case "sending": return "Sending now";
    default: return "Not sent";
  }
}
