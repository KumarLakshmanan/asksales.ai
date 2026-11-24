"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { FollowUpActivity as Activity } from '../../../../shared/followUpActivity';
import type { FollowUpChannel } from '../../../../shared/followUpChannels';
import DOMPurify from 'dompurify';
import { followUpRequest } from '@/lib/follow-up-request';
import { readLibraryDraft } from '@/lib/libraryDraft';

export function followUpMessageText(message: string): string {
  const text = readLibraryDraft(message).body || message;
  if (!/<(?:!doctype|html|body|p|div|table|br|span|a)[\s>]/i.test(text)) return text;
  // Display legacy HTML as text: no scripts, remote images, or tracking loads.
  const safe = DOMPurify.sanitize(text.replace(/<br\s*\/?>|<\/(?:p|div|tr|h[1-6])>/gi, '\n'), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  return new DOMParser().parseFromString(safe, 'text/html').body.textContent?.split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() || '';
}

const PAGE_SIZE = 25;

export function FollowUpHistory({ channel }: { channel: FollowUpChannel }) {
  const { formatDate } = usePreferences();
  const [rows, setRows] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const request = useRef(0);
  const lastOffset = useRef(0);
  const load = useCallback(async (offset = 0) => {
    const generation = ++request.current;
    lastOffset.current = offset;
    setLoading(true); setError('');
    try {
      const result = await followUpRequest(signal => api.get<Activity[]>(`/api/sent-messages?followUps=true&channel=${channel}&limit=${PAGE_SIZE}&offset=${offset}`, { signal }));
      if (generation !== request.current) return;
      setRows(previous => offset ? [...previous, ...result] : result);
      setHasMore(result.length === PAGE_SIZE);
    } catch (cause) {
      if (generation === request.current) setError(cause instanceof Error ? cause.message : 'Unable to load follow-up history.');
    } finally { if (generation === request.current) setLoading(false); }
  }, [channel]);
  useEffect(() => { setRows([]); setHasMore(false); void load(); return () => { request.current += 1; }; }, [load]);

  return <section aria-label={`${channel} follow-up history`} className="rounded-xl border bg-card">
    <div className="flex items-center justify-between gap-4 border-b p-5">
      <div><h2 className="font-semibold">Follow-up history</h2><p className="mt-1 text-sm text-muted-foreground">Messages, sequence steps, and delivery outcomes for this channel.</p></div>
      <Button variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
    </div>
    {error && <div role="alert" className="m-5 rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{error}<Button variant="link" disabled={loading} onClick={() => void load(lastOffset.current)}>Try again</Button></div>}
    {!loading && !error && rows.length === 0 && <div className="px-6 py-14 text-center"><h3 className="font-medium">No follow-ups yet</h3><p className="mt-2 text-sm text-muted-foreground">Sent messages and delivery attempts will appear here when your sequence runs.</p></div>}
    <div className="divide-y">{rows.map(row => {
      const scheduled = !row.authorityReview && ['pending', 'queued'].includes(row.status) && row.scheduledAt && Number.isFinite(new Date(row.scheduledAt).getTime());
      const timestamp = scheduled ? row.scheduledAt : row.sentAt || row.createdAt;
      const status = row.deliveryStatus === 'uncertain' ? 'Delivery uncertain' : row.kind === 'configured_outbox' ? 'Delivery not confirmed' : row.authorityReview ? `Recorded: ${row.status.replaceAll('_', ' ')}` : scheduled ? 'Scheduled' : row.status === 'pending' ? 'Queued' : row.status;
      return <article key={row.activityKey || `${row.kind || 'historical'}:${row.id}:${row.followUpStep ?? ''}`} className="space-y-2 p-5">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{row.leadName || 'Customer'}</h3><Badge variant="outline">Step {row.followUpStep || '—'}</Badge>{row.authorityReview && <Badge variant="outline">Review required</Badge>}<Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'} className="capitalize">{status}</Badge>{timestamp && <time dateTime={timestamp} className="ml-auto text-xs text-muted-foreground">{formatDate(timestamp, { dateStyle: 'medium', timeStyle: 'short' })}</time>}</div>
        {row.authorityReview && <div className="space-y-2 rounded-lg border border-amber-500/30 p-3 text-sm">
          <p>The original dispatch requires authority review. Its delivery outcome is separate from this review.</p>
          <p>Reason: <code className="break-all">{row.authorityReview.reason || 'Unavailable'}</code></p>
          <p className="text-xs text-muted-foreground">Origin: {row.authorityReview.origin.table} #{row.authorityReview.origin.messageId ?? 'Unavailable'} · Owner #{row.authorityReview.origin.userId ?? 'Unavailable'} · Business #{row.authorityReview.origin.businessProfileId ?? 'Unavailable'} · Step {row.authorityReview.origin.step ?? 'Unavailable'}</p>
          {row.kind === 'configured_outbox' && <p>No follow-up delivery is confirmed by this reserved-step record. Recorded delivery attempts appear separately.</p>}
          {row.deliveryStatus === 'uncertain' && <p>Recorded status: {row.status.replaceAll('_', ' ')}</p>}
          <details><summary className="cursor-pointer text-xs font-medium">Stored dispatch authority</summary>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">{([
              ['Owner', 'userId'], ['Business', 'businessProfileId'], ['Business actor', 'businessActorUserId'],
              ['Billing organization', 'billingOrganizationId'], ['Billing actor', 'billingActorUserId'],
            ] as const).map(([label, key]) => <div className="contents" key={key}><dt>{label}</dt><dd>{row.authorityReview?.identity[key] ?? 'Unavailable'}</dd></div>)}</dl>
          </details>
        </div>}
        {row.kind !== 'configured_outbox' && row.deliveryStatus && row.deliveryStatus !== row.status && row.deliveryStatus !== 'uncertain' && <p className="text-xs text-muted-foreground">Recorded delivery status: {row.deliveryStatus.replaceAll('_', ' ')}</p>}
        {row.recordedMessageId && <p className="break-all text-xs text-muted-foreground">Recorded message ID: {row.recordedMessageId}</p>}
        {row.subject && <p className="text-sm font-medium">{row.subject}</p>}
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{followUpMessageText(row.message)}</p>
      </article>;
    })}</div>
    {loading && <div role="status" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><Spinner size="sm" label={null} />Loading history…</div>}
    {hasMore && !error && <div className="border-t p-4 text-center"><Button variant="outline" disabled={loading} onClick={() => void load(rows.length)}>Load older follow-ups</Button></div>}
  </section>;
}
