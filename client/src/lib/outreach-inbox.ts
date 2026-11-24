export { INBOX_CHANNELS, INBOX_ORIGIN_FILTERS } from '../../../shared/outreachInbox';
export type { InboxChannel, InboxItem, InboxOriginFilter, InboxPage, InboxReplyAvailability, OutreachMessageOrigin } from '../../../shared/outreachInbox';

/** Filter chip names: how a conversation started, plus threads the AI replied in. */
export const INBOX_ORIGIN_LABELS = {
  outreach: 'Outreach', customer: 'Customer started', manual: 'Manual in AskSales', native_app: 'From phone/web app', ai: 'AI handled',
} as const;

export const INBOX_LABELS = {
  email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', sms: 'SMS',
} as const;
