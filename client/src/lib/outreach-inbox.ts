export { INBOX_CHANNELS } from '../../../shared/outreachInbox';
export type { InboxChannel, InboxItem, InboxPage, InboxReplyAvailability } from '../../../shared/outreachInbox';

export const INBOX_LABELS = {
  email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', sms: 'SMS',
} as const;
