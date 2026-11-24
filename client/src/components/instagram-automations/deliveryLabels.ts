const outcomes: Record<string, string> = {
  sent: 'Accepted by Instagram', completed: 'Completed', queued: 'Waiting to send',
  running: 'Sending', reserved: 'Sending', fulfilling: 'Sending promised content',
  pending: 'Waiting to send', waiting_follow: 'Waiting for a follow',
  pending_follow: 'Waiting for a follow', awaiting_follow: 'Waiting for a follow',
  failed: 'Could not send', skipped: 'Skipped', uncertain: 'Delivery unconfirmed',
  sending: 'Sending', matched: 'Matched',
};
const effects: Record<string, string> = {
  private: 'Private message', public: 'Public reply', promised_content: 'Promised content',
  follow_retry: 'Follow check reply', menu: 'Menu response',
};
export const instagramRunOutcome = (status: string) => outcomes[status] || status.replaceAll('_', ' ');
export const instagramEffectName = (kind: string) => effects[kind] || kind.replaceAll('_', ' ');
export const instagramEffectOutcome = (status: string) => status === 'sent' ? 'accepted' : status;
