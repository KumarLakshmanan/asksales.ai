import { INBOX_CHANNEL_LABELS, type InboxChannel } from '../../shared/outreachInbox.js';

const LABEL_LIMIT = 200;

/**
 * Buttons send the agent full instructions (exact lead IDs, review rules). The
 * chat shows this short label instead. Dropped when it adds nothing.
 */
export function shortDisplayContent(displayContent: unknown, content: string): string | undefined {
  if (typeof displayContent !== 'string') return undefined;
  const label = displayContent.replace(/\s+/g, ' ').trim().slice(0, LABEL_LIMIT);
  return label && label !== content.trim() ? label : undefined;
}

export function outreachPrepareLabel(channel: InboxChannel | null, leadCount: number): string {
  const channelName = channel ? `${INBOX_CHANNEL_LABELS[channel]} ` : '';
  return `Prepare ${channelName}outreach for ${leadCount} selected ${leadCount === 1 ? 'lead' : 'leads'}`;
}
