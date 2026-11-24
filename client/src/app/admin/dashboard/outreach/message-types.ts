/** An SMS or WhatsApp outreach row on the admin outreach pages (snake_case or camelCase API fields). */
export interface AdminPhoneOutreachMessage {
  id: number;
  userName?: string;
  user_name?: string;
  recipientPhone?: string;
  recipient_phone?: string;
  contentPreview?: string;
  content_preview?: string;
  status?: string;
  sentAt?: string;
  sent_at?: string;
}
