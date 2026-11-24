import { hasEmailMarkup } from '../../shared/emailFormatting.js';
import { emailDisplayText } from './emailDisplay.js';

/** Normalize only our recorded email reply format; literal text and other channels retain their meaning. */
export function presentSavedEmailReply<T extends { direction: string; content: string; htmlContent?: string | null; metadata?: unknown }>(message: T): T {
  if (message.direction !== 'outbound') return message;
  const metadata = message.metadata as Record<string, unknown> | null;
  if (!['email_smart_reply', 'campaign_email_reply', 'assistant_follow_up'].includes(String(metadata?.dispatchKind || ''))) return message;
  const formatted = hasEmailMarkup(message.content);
  const htmlContent = message.htmlContent || (typeof metadata?.emailHtml === 'string' ? metadata.emailHtml : formatted ? message.content : null);
  return { ...message, htmlContent, content: formatted ? emailDisplayText(message.content, 'html') : message.content };
}
