import { redirect } from 'next/navigation';
import type { InboxChannel } from '../../../../../shared/outreachInbox';

/** Retain contact/conversation links while channel pages share one reply flow. */
export async function redirectOutreachInbox(channel: InboxChannel,
  searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const source = await searchParams;
  const params = new URLSearchParams({ channel });
  const conversation = source.conversationId;
  if (typeof conversation === 'string' && /^\d+$/.test(conversation) && Number(conversation) > 0)
    params.set('thread', `conversation:${conversation}`);
  const lead = source.leadId;
  if (typeof lead === 'string' && /^\d+$/.test(lead) && Number(lead) > 0) params.set('leadId', lead);
  redirect(`/dashboard/outreach/inbox?${params.toString()}`);
}
