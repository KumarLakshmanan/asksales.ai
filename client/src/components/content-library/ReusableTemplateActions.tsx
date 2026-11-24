"use client";

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { sanitizeEmailPreviewHtml } from '@/lib/contentTemplateRendering';
import { readLibraryDraft } from '@/lib/libraryDraft';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

interface ReviewTemplate { id: number; version: number; name: string; subject?: string; content: string; htmlContent?: string; variables?: string[]; isApproved?: boolean }

export function ReusableTemplateActions({ templateId, kind }: { templateId: number; kind: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ReviewTemplate | null>(null);
  const [error, setError] = useState('');
  const [uncertainCopy, setUncertainCopy] = useState(false);
  const run = async (action: () => Promise<void>, copying = false) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) {
      const status = (cause as { status?: number }).status;
      const uncertain = copying && (!status || status >= 500);
      if (uncertain) setUncertainCopy(true);
      setError(`${cause instanceof Error ? cause.message : 'Action failed.'}${uncertain ? ' Check the library before copying again; the copy may already exist.' : ''}`);
    } finally {
      await queryClient.invalidateQueries({ queryKey: [`${kind}-templates`] });
      await queryClient.invalidateQueries({ queryKey: ['content-template-versions', templateId] });
      lock.current = false; setBusy(false);
    }
  };
  return <div className="mt-2 space-y-2">
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy || uncertainCopy} onClick={() => void run(async () => {
        await api.post(`/api/content/templates/${templateId}/duplicate`);
        toast({ title: 'Reusable template duplicated', description: 'Review and approve the copy before reuse.' });
      }, true)}>Duplicate template</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => setReview(await api.get<ReviewTemplate>(`/api/content/templates/${templateId}`)))}>Review template</Button>
    </div>
    {error && !review && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(null); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Review {review?.name}</DialogTitle><DialogDescription>Version {review?.version} · {review?.isApproved ? 'Approved for reuse' : 'Needs approval'}. Approval applies to this reusable copy, not to a campaign or published post.</DialogDescription></DialogHeader>
        {review?.subject && <p className="text-sm font-medium">Subject: {review.subject}</p>}
        <pre className="whitespace-pre-wrap break-words rounded-md border p-3 font-sans text-sm">{review ? [readLibraryDraft(review.content).subject, readLibraryDraft(review.content).body].filter(Boolean).join('\n\n') : ''}</pre>
        {review?.htmlContent && <iframe title="Reusable template HTML proof" sandbox="" srcDoc={sanitizeEmailPreviewHtml(review.htmlContent)} className="h-72 w-full border bg-white" />}
        <p className="text-xs text-muted-foreground">{review?.variables?.length ? `Variables to resolve for each recipient: ${review.variables.join(', ')}` : 'No declared variables.'}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Close</Button>
          <Button disabled={busy} onClick={() => void run(async () => {
            if (!review) return;
            const approved = await api.post<ReviewTemplate>(`/api/content/templates/${templateId}/approve`, { expectedVersion: review.version });
            setReview(approved); toast({ title: 'Template approved for reuse' });
          })}>{busy ? 'Approving…' : 'Approve reviewed version'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
