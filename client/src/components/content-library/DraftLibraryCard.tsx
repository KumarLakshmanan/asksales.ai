"use client";

import { useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { copyText } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { TemplatePreviewCard } from './TemplatePreviewCard';
import { BlogCmsReviewHandoff } from './BlogCmsReviewHandoff';
import MediaManager from '@/components/MediaManager';
import { buildContentMedia } from '@/lib/contentMedia';
import { libraryCampaignUrl, readLibraryDraft, updateLibraryDraft, reusableLibraryContent, type LibraryTextKind } from '@/lib/libraryDraft';

export interface LibraryDraftAsset {
  id: number; title: string; content: string; type: string; channel: string;
  threadId?: number | null;
  createdAt: string; status?: string; approvalStatus?: string;
  imageUrl?: string | null; imageUrls?: string[] | null; videoUrl?: string | null; videoUrls?: string[] | null;
  brandToolkitId?: number | null; businessProfileId?: number | null;
}

export function DraftLibraryCard({ asset, kind, onPreview, onPrimary, primaryLabel }: { asset: LibraryDraftAsset; kind: LibraryTextKind; onPreview?: () => void; onPrimary?: () => void; primaryLabel?: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // Retire callbacks at close, before the dialog's exit animation unmounts.
  const [editorSession, setEditorSession] = useState(0);
  const editorEpoch = useRef(0);
  useLayoutEffect(() => () => { editorEpoch.current += 1; }, [asset.id]);
  const closeEditor = () => { editorEpoch.current += 1; setEditing(false); };
  const [snapshot, setSnapshot] = useState(asset);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const parsed = readLibraryDraft(asset.content);
  const locked = ['scheduled', 'processing', 'published'].includes(asset.status || '');

  const run = async (action: () => Promise<void>, creates = false) => {
    if (lock.current || uncertain) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) {
      const status = (cause as { status?: number }).status;
      const message = cause instanceof Error ? cause.message : 'The action could not be completed.';
      const mayHaveSaved = creates && (!status || status >= 500);
      if (mayHaveSaved) setUncertain(true);
      setError(mayHaveSaved ? `${message} Check the refreshed library before trying again; the copy may already have been saved.` : message);
      toast({ title: 'Action not completed', description: message, variant: 'destructive' });
    } finally {
      await queryClient.invalidateQueries({ queryKey: [`${kind}-templates`] });
      await queryClient.invalidateQueries({ queryKey: [`${kind}-content-assets`] });
      await queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }, { cancelRefetch: false });
      await queryClient.invalidateQueries({ queryKey: ["content-template-counts"] }, { cancelRefetch: false });
      lock.current = false; setBusy(false);
    }
  };

  const edit = () => void run(async () => {
    const session = ++editorEpoch.current;
    const fresh = await api.get<LibraryDraftAsset>(`/api/content/assets/${asset.id}`);
    if (editorEpoch.current !== session) return;
    const value = readLibraryDraft(fresh.content);
    setEditorSession(session);
    setSnapshot(fresh); setName(fresh.title); setSubject(value.subject); setBody(value.body); setHtml(value.html); setEditing(true);
  });

  const duplicate = () => void run(async () => {
    const fresh = await api.get<LibraryDraftAsset>(`/api/content/assets/${asset.id}`);
    // Explicit allowlist: never copy approval, publication receipts or provider jobs.
    await api.post('/api/content/assets', {
      title: `${fresh.title.slice(0, 248)} (copy)`, content: fresh.content, type: fresh.type,
      channel: fresh.channel, status: 'draft', parentAssetId: fresh.id,
      businessProfileId: fresh.businessProfileId, brandToolkitId: fresh.brandToolkitId,
      imageUrl: fresh.imageUrl, imageUrls: fresh.imageUrls, videoUrl: fresh.videoUrl, videoUrls: fresh.videoUrls,
    });
    toast({ title: 'Draft duplicated', description: 'The copy starts as a new, unapproved draft.' });
  }, true);

  const reusable = () => void run(async () => {
    const fresh = await api.get<LibraryDraftAsset>(`/api/content/assets/${asset.id}`);
    const value = readLibraryDraft(fresh.content);
    await api.post('/api/content/templates', { name: fresh.title, type: kind === 'ad' ? 'ad_copy' : kind === 'dm' ? 'social_message' : kind, content: reusableLibraryContent(kind, fresh.content), category: fresh.channel,
      businessProfileId: fresh.businessProfileId, brandToolkitId: fresh.brandToolkitId,
      ...(kind === 'email' ? { subject: value.subject, htmlContent: value.html || null } : {}) });
    toast({ title: 'Reusable template saved', description: 'A separate text template was created. Your draft and its attachments are unchanged.' });
  }, true);

  return <>
    <TemplatePreviewCard kind={kind} title={asset.title} content={asset.content} subject={parsed.subject}
      category={locked ? 'Live or scheduled' : 'Saved draft'} status={asset.status || 'draft'} createdAt={asset.createdAt}
      imageUrl={asset.imageUrl || undefined} imageUrls={asset.imageUrls || undefined} videoUrl={asset.videoUrl || undefined} videoUrls={asset.videoUrls || undefined}
      onPreview={onPreview} onPrimary={onPrimary || (kind === 'email' || kind === 'sms' ? () => router.push(libraryCampaignUrl(kind, 'asset', asset.id)) : onPreview)} primaryLabel={primaryLabel || (kind === 'email' || kind === 'sms' ? 'Use in campaign' : 'Preview')}
      onCopy={() => void (async () => {
        const extra = typeof parsed.fields.callToAction === 'string' && !parsed.body.includes(parsed.fields.callToAction) ? parsed.fields.callToAction : '';
        const tags = Array.isArray(parsed.fields.hashtags) ? [...new Set(parsed.fields.hashtags.filter((tag): tag is string => typeof tag === 'string').map(tag => `#${tag.replace(/^#+/, '')}`))].filter(tag => !parsed.body.includes(tag)).join(' ') : '';
        try { await copyText([parsed.subject, parsed.body, extra, tags].filter(Boolean).join('\n\n')); toast({ title: 'Draft copied' }); }
        catch { toast({ title: 'Unable to copy', description: 'Open the preview and select the text to copy it manually.', variant: 'destructive' }); }
      })()}
      onEdit={!locked && !busy ? edit : undefined}
      onDelete={!locked && !busy ? () => void run(async () => { await api.delete(`/api/content/assets/${asset.id}`); toast({ title: 'Draft deleted' }); }) : undefined}
      additionalActions={<div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy || uncertain} onClick={duplicate}>Duplicate draft</Button>
          <Button variant="outline" size="sm" disabled={busy || uncertain} onClick={reusable}>Save as reusable template</Button>
          {kind === 'blog' && <BlogCmsReviewHandoff assetId={asset.id} />}
        </div>
        <p className="text-xs text-muted-foreground">{locked ? 'This item is live or scheduled. Cancel or unpublish it before editing.' : 'Saved draft · Review the destination, content and variables before publishing or sending.'}</p>
        {!locked && asset.approvalStatus && <p className="text-xs text-muted-foreground">Review: {asset.approvalStatus === 'draft' ? 'Not yet approved' : asset.approvalStatus.replaceAll('_', ' ')}</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>} />
    <Dialog open={editing} onOpenChange={(open) => { if (!busy && !open) closeEditor(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {kind === 'sms' || kind === 'dm' ? kind.toUpperCase() : kind} draft</DialogTitle><DialogDescription>Saving changes returns this draft to review. Attached media is preserved.</DialogDescription></DialogHeader>
        <Label htmlFor={`draft-name-${asset.id}`}>Draft name</Label><Input id={`draft-name-${asset.id}`} value={name} maxLength={255} onChange={e => setName(e.target.value)} />
        {['email', 'ad', 'blog'].includes(kind) && <><Label htmlFor={`draft-subject-${asset.id}`}>{kind === 'email' ? 'Subject' : kind === 'ad' ? 'Headline' : 'Post title'}</Label><Input id={`draft-subject-${asset.id}`} value={subject} onChange={e => setSubject(e.target.value)} /></>}
        <Label htmlFor={`draft-body-${asset.id}`}>Message</Label><Textarea id={`draft-body-${asset.id}`} rows={9} value={body} onChange={e => setBody(e.target.value)} />
        {kind === 'email' && html && <><Label htmlFor={`draft-html-${asset.id}`}>HTML version (keep in sync with the message)</Label><Textarea id={`draft-html-${asset.id}`} rows={5} value={html} onChange={e => setHtml(e.target.value)} /></>}
        {editing && !locked && <MediaManager key={editorSession} assetId={`db-${snapshot.id}`} threadId={snapshot.threadId || undefined} images={buildContentMedia(snapshot).imageUrls} videos={buildContentMedia(snapshot).videoUrls} onMediaChange={(images, videos) => {
          if (editorEpoch.current !== editorSession) return;
          setSnapshot(previous => editorEpoch.current === editorSession && previous.id === snapshot.id
            ? { ...previous, imageUrl: images[0] || null, videoUrl: videos[0] || null, imageUrls: images, videoUrls: videos }
            : previous);
          void queryClient.invalidateQueries({ queryKey: [`${kind}-content-assets`] }, { cancelRefetch: false });
        }} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={closeEditor}>Cancel</Button>
          <Button disabled={busy || !name.trim() || !body.trim()} onClick={() => void run(async () => {
            await api.put(`/api/content/assets/${asset.id}`, { title: name.trim(), content: updateLibraryDraft(snapshot.content, kind, subject, body, html) });
            toast({ title: 'Draft updated' }); closeEditor();
          })}>{busy ? 'Saving…' : 'Save draft'}</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
