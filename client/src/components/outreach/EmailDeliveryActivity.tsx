"use client";
import { Check, CheckCheck, Clock, Eye, AlertCircle, MousePointer2 } from 'lucide-react';
import type { OutreachMessage } from './types';
function receiptTime(value?: string | null) { return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not reported'; }
export function EmailDeliveryActivity({ message }: { message: OutreachMessage }) {
  const openedAt = message.emailTracking?.openedAt || message.readAt;
  const opened = Boolean(openedAt) || message.status === 'read';
  const failed = ['failed', 'bounced', 'rejected'].includes(message.status);
  const sent = Boolean(message.sentAt) || ['sent', 'delivered', 'read'].includes(message.status);
  const delivered = Boolean(message.deliveredAt) || message.status === 'delivered';
  const held = message.status === 'manual_review' || message.status === 'draft';
  const label = failed ? (message.status === 'bounced' ? 'Bounced' : 'Failed') : held ? (message.status === 'draft' ? 'Draft' : 'Pending confirmation') : opened ? 'Opened' : delivered ? 'Delivered' : sent ? 'Sent' : message.status === 'sending' ? 'Sending' : message.status === 'pending' ? 'Pending' : message.status.charAt(0).toUpperCase() + message.status.slice(1);
  const Icon = failed ? AlertCircle : held ? Clock : opened ? Eye : delivered ? CheckCheck : sent ? Check : Clock;
  const clicks = Array.isArray(message.metadata?.clicks) ? message.metadata.clicks : [];
  return <details className="text-xs text-muted-foreground">
    <summary className="flex w-fit cursor-pointer items-center gap-2 rounded py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><Icon className={`h-3.5 w-3.5 ${failed ? 'text-destructive' : openedAt || delivered ? 'text-emerald-600' : ''}`} /><span>{label}</span>{openedAt && message.emailTracking?.source === 'image_load' && <span className="text-[10px]">· image loaded</span>}{clicks.length > 0 && <span className="inline-flex items-center gap-1"><MousePointer2 className="h-3 w-3" />{clicks.length} link events</span>}<span className="ml-2 underline underline-offset-2">Delivery activity</span></summary>
    <dl className="my-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg bg-muted/50 p-3"><dt>Sent</dt><dd>{receiptTime(message.sentAt)}</dd><dt>Delivered</dt><dd>{receiptTime(message.deliveredAt)}</dd><dt>Opened</dt><dd>{receiptTime(openedAt)}</dd>{message.emailTracking?.openCount ? <><dt>Image loads</dt><dd>{message.emailTracking.openCount}</dd></> : null}{clicks.length > 0 && <><dt>Link clicks</dt><dd>{clicks.length} provider events</dd></>}</dl>
    <p className="mb-2 max-w-xl leading-5">Sent means the sending provider accepted the email. Gmail does not provide delivery receipts. Opens record image loads and may be affected by image blocking or privacy proxies.{!message.emailTracking && !message.readAt ? ' Open tracking is unavailable for this message.' : ''}</p>
  </details>;
}
