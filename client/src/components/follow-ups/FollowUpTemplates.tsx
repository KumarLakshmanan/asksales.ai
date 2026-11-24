"use client";

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useOutreachDraftScope } from '@/hooks/use-outreach-draft-scope';
import Link from 'next/link';
import { Plus, FileText } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { usePaginatedContentTemplates } from '@/hooks/use-paginated-content-templates';
import { followUpTemplateType, type FollowUpChannel } from '../../../../shared/followUpChannels';
import { readLibraryDraft } from '@/lib/libraryDraft';
import { AssistantTemplatePreview } from '@/components/outreach/assistants/AssistantTemplatePreview';
import { followUpRequest } from '@/lib/follow-up-request';
import { contentRequestKey } from '@/lib/content-request-key';
import { creatorSessionScope } from '@/lib/creator-session';
import { findUnknownTemplateVariables } from '../../../../shared/templateVariables';

interface TemplateDialogProps {
  returnFocusRef?: RefObject<HTMLElement | null>;
  channel: FollowUpChannel; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (template: Template) => void;
}

interface Template { id: number; name: string; subject?: string; content: string; isApproved?: boolean }

export function FollowUpTemplateDialog(props: TemplateDialogProps) {
  const scope = useOutreachDraftScope();
  return <FollowUpTemplateForm key={`${scope}:${props.channel}`} {...props} />;
}

function FollowUpTemplateForm({ channel, open, onOpenChange, onCreated, returnFocusRef }: TemplateDialogProps) {
  const [name, setName] = useState(''); const [subject, setSubject] = useState(''); const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const intent = useRef<{
    body: { name: string; type: string; content: string; subject: string | null; category: string; tags: string[] };
    receipt: ReturnType<typeof contentRequestKey>;
  } | null>(null);
  const { toast } = useToast();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const unknownVariables = findUnknownTemplateVariables(`${channel === 'email' ? subject : ''}\n${content}`);
  // A normal cancelled draft is private ephemeral text. An uncertain create
  // keeps that same in-memory intent until its receipt can be recovered.
  useEffect(() => {
    if (!open && !intent.current) { setName(''); setSubject(''); setContent(''); setError(''); }
  }, [open]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (pending.current || !name.trim() || !content.trim() || unknownVariables.length) return;
    pending.current = true; setSaving(true); setError('');
    if (!intent.current) {
      const body = { name: name.trim(), type: followUpTemplateType(channel), content: content.trim(),
        subject: channel === 'email' ? subject.trim() || null : null, category: 'follow_up', tags: ['follow-up', channel] };
      // Reuse the API client's receipt namespace and retain its exact key even
      // if an earlier response finishes after the UI deadline.
      intent.current = { body, receipt: contentRequestKey('/api/content/templates', JSON.stringify(body), creatorSessionScope()) };
    }
    const attempt = intent.current;
    try {
      const template = await followUpRequest(async signal => {
        const receipt = await attempt.receipt;
        if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
        return api.post<Template>('/api/content/templates', attempt.body, { signal, headers: { 'Idempotency-Key': receipt.key } });
      });
      if (!mounted.current) return;
      if (!Number.isSafeInteger(template?.id) || template.id <= 0 || typeof template.content !== 'string') throw new Error('This template could not be saved. Please try again.');
      intent.current = null; setUnconfirmed(false);
      onCreated(template); onOpenChange(false); setName(''); setSubject(''); setContent('');
      toast({ title: 'Follow-up template created', description: 'Review and approve it in the template library before automated use.' });
    } catch (cause) {
      if (!mounted.current) return;
      const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
      const uncertain = !(status >= 400 && status < 500);
      if (!uncertain) intent.current = null;
      setUnconfirmed(uncertain);
      const detail = cause instanceof Error ? cause.message : 'Unable to save template.';
      setError(uncertain ? `${detail} The create result is unconfirmed. Retry the same create to recover its receipt, or review the template library. Closing does not cancel a server save.` : detail);
    } finally { pending.current = false; if (mounted.current) setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}><DialogContent className="max-w-xl" onCloseAutoFocus={event => { if (returnFocusRef?.current?.isConnected) { event.preventDefault(); returnFocusRef.current.focus(); } }}><DialogHeader><DialogTitle>Create follow-up template</DialogTitle><DialogDescription>Save reusable wording for {channel}. Customer details are filled in when the follow-up is sent.</DialogDescription></DialogHeader>
    <form onSubmit={save}><fieldset disabled={saving || unconfirmed} className="min-w-0 space-y-4">
      <div className="space-y-2"><Label htmlFor="follow-up-template-name">Template name</Label><Input id="follow-up-template-name" value={name} onChange={e => setName(e.target.value)} required maxLength={200} placeholder="A friendly check-in" /></div>
      {channel === 'email' && <div className="space-y-2"><Label htmlFor="follow-up-template-subject">Subject (optional)</Label><Input id="follow-up-template-subject" value={subject} onChange={e => setSubject(e.target.value)} /><p className="text-xs text-muted-foreground">Follow-ups in an existing email thread keep its original subject.</p></div>}
      <div className="space-y-2"><Label htmlFor="follow-up-template-content">Message</Label><Textarea id="follow-up-template-content" value={content} onChange={e => setContent(e.target.value)} required rows={7} placeholder="Hi {{first_name}}, just checking whether you still need help." /><p className="text-xs text-muted-foreground">Use {'{{first_name}}'}, {'{{full_name}}'}, or {'{{your_company_name}}'} to personalize your message.</p></div>
      <AssistantTemplatePreview channel={channel} template={{id:0,name:name.trim() || 'new follow-up',channels:[channel],preview:[channel === 'email' ? subject : '',content].filter(Boolean).join('\n\n'),status:'Draft · Business approval required before automated use'}} />
      {unknownVariables.length > 0 && <p role="alert" className="text-sm text-destructive">Unsupported variables: {unknownVariables.join(', ')}. Correct them before saving.</p>}
    </fieldset>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}{unconfirmed && <> <Link className="underline" href={`/dashboard/saved-templates/${channel === 'instagram' || channel === 'facebook' ? 'dm' : channel}`}>Review template library</Link></>}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{unconfirmed ? 'Close draft' : 'Cancel'}</Button><Button type="submit" loading={saving} disabled={!name.trim() || !content.trim() || unknownVariables.length > 0}>{unconfirmed ? 'Retry same create' : 'Create template'}</Button></div>
    </form>
  </DialogContent></Dialog>;
}

export function FollowUpTemplates({ channel }: { channel: FollowUpChannel }) {
  const [search, setSearch] = useState(''); const [creating, setCreating] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const scope = useOutreachDraftScope();
  const library = usePaginatedContentTemplates<Template>({ type: followUpTemplateType(channel), search, queryKey: `follow-up-templates:${scope}` });
  const libraryPath = channel === 'instagram' || channel === 'facebook' ? 'dm' : channel;
  return <section className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Message templates</h2><p className="mt-1 text-sm text-muted-foreground">Reuse your saved library or create wording for a follow-up step.</p></div><Button ref={createButton} onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" />Create template</Button></div>
    <div className="flex flex-wrap items-center gap-3"><SearchInput aria-label="Search follow-up templates" wrapperClassName="min-w-60 flex-1" value={search} onValueChange={setSearch} placeholder="Search your templates…" /><Button asChild variant="outline"><Link href={`/dashboard/saved-templates/${libraryPath}`}>Open full template library</Link></Button></div>
    {library.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading templates…</p>}
    {library.isError && <div role="alert" className="text-sm text-destructive">Templates could not be loaded. <Button variant="link" onClick={() => void library.refetch()}>Try again</Button></div>}
    {!library.isLoading && !library.isError && library.templates.length === 0 && <p className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">No matching saved templates. Create one above, or choose a generated draft when assigning a follow-up step.</p>}
    <div className="grid gap-4 md:grid-cols-2">{library.templates.map(template => <article key={template.id} className="rounded-xl border bg-card p-5"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" /><h3 className="font-medium">{template.name}</h3></div>{template.subject && <p className="mt-3 text-sm font-medium">{template.subject}</p>}<p className="mt-2 line-clamp-5 whitespace-pre-wrap text-sm text-muted-foreground">{readLibraryDraft(template.content).body}</p>{template.isApproved === false && <p className="mt-3 text-xs text-amber-700">Review and approve in the template library before use.</p>}</article>)}</div>
    {library.hasNextPage && <Button variant="outline" disabled={library.isFetchingNextPage} onClick={() => void library.fetchNextPage()}>Load more templates</Button>}
    <FollowUpTemplateDialog returnFocusRef={createButton} channel={channel} open={creating} onOpenChange={setCreating} onCreated={() => void library.refetch()} />
  </section>;
}
