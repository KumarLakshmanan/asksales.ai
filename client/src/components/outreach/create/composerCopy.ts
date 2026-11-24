/** "an Email account", "an SMS account", "a WhatsApp account". */
export function channelAccountPhrase(label: string) {
  const article = /^[aeiou]/i.test(label) || label === "SMS" ? "an" : "a";
  return `${article} ${label} account`;
}

/**
 * When every loaded contact is blocked for the same reason, the reason is about
 * the sender or channel, not the contact. Show it once instead of on every row.
 */
export function sharedRecipientBlockReason(
  recipients: ReadonlyArray<{ eligible: boolean; reason?: string | null }>,
) {
  if (recipients.length < 2) return null;
  const first = recipients[0];
  if (first.eligible || !first.reason) return null;
  return recipients.every((item) => !item.eligible && item.reason === first.reason)
    ? first.reason
    : null;
}
