"use client";

import { selectedBusinessProfileId } from '@/lib/business-profile';

import { getAuthHeaders } from '@/lib/authHeaders';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileText, Pencil, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import api, { buildApiUrl } from '@/lib/api';
import { DOCUMENT_TOPICS, documentIsAvailable, documentTopicLabel, type SupportLibraryDocument } from '@/lib/support-documents';
import { useToast } from '@/hooks/use-toast';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { LoadingState } from '@/components/ui/loading-state';
import { SearchInput } from '@/components/ui/search-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithReadRetry } from "@/lib/api-client";

type Profile = { id: number; companyName?: string; company_name?: string; name?: string };
const emptyForm = { title: '', description: '', service: 'resort', businessProfileId: '', storageFileId: 0 };

export default function SupportDocumentsPage() {
  const { toast } = useToast();
  const [documents, setDocuments] = useState<SupportLibraryDocument[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<SupportLibraryDocument | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState<SupportLibraryDocument | null>(null);
  const [withdraw, setWithdraw] = useState<SupportLibraryDocument | null>(null);
  const [reason, setReason] = useState('');
  const [certified, setCertified] = useState(false);
  const [reviewedChecksum, setReviewedChecksum] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [items, businessProfiles] = await Promise.all([
        api.get<SupportLibraryDocument[]>('/api/settings/support-documents'),
        api.get<Profile[]>('/api/settings/business-profiles'),
      ]);
      setDocuments(items); setProfiles(businessProfiles);
    } catch (err) { setError(err instanceof Error ? err.message : 'Documents could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const notifyFailure = (err: unknown) => toast({ title: 'Document action failed',
    description: err instanceof Error ? err.message : 'Try again.', variant: 'destructive' });
  const openDraft = (document: SupportLibraryDocument | null) => {
    setEditing(document); setFile(null);
    setForm(document ? { title: document.title, description: document.description, service: document.service,
      businessProfileId: document.businessProfileId ? String(document.businessProfileId) : '', storageFileId: document.storageFileId } : emptyForm);
    setEditOpen(true);
  };
  const saveDraft = async () => {
    if (!form.title.trim() || (!file && !form.storageFileId)) return;
    setBusy(true);
    try {
      let storageFileId = form.storageFileId;
      if (file) {
        if (file.type !== 'application/pdf' || file.size > 20 * 1024 * 1024) throw new Error('Choose a PDF no larger than 20 MB.');
        const body = new FormData(); body.append('file', file);
        const stored = await api.postForm<{ id: number }>('/api/settings/storage/files', body);
        storageFileId = stored.id;
        setForm(current => ({ ...current, storageFileId })); setFile(null);
      }
      const input = { ...form, storageFileId, businessProfileId: form.businessProfileId ? Number(form.businessProfileId) : null,
        ...(editing ? { revision: editing.revision } : {}) };
      if (editing) await api.put(`/api/settings/support-documents/${editing.id}`, input);
      else await api.post('/api/settings/support-documents', input);
      setEditOpen(false); await load(); toast({ title: 'Draft saved', description: 'Review and approve the PDF before customer sharing.' });
    } catch (err) { notifyFailure(err); }
    finally { setBusy(false); }
  };
  const download = async (document: SupportLibraryDocument) => {
    setBusy(true);
    try {
      const response = await fetchWithReadRetry(buildApiUrl(`/api/settings/support-documents/${document.id}/content`), {
        credentials: 'include', headers: getAuthHeaders(),
      });
      if (!response.ok) throw new Error('The PDF could not be downloaded. Refresh and try again.');
      const blob = await response.blob();
      const href = URL.createObjectURL(blob); const link = window.document.createElement('a');
      link.href = href; link.download = `${document.title}.pdf`; link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setReviewedChecksum(document.checksum);
    } catch (err) { notifyFailure(err); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!review || !certified || !reason.trim() || reviewedChecksum !== review.checksum) return;
    setBusy(true);
    try {
      await api.post(`/api/settings/support-documents/${review.id}/publish`, { revision: review.revision,
        checksum: review.checksum, certified, reason, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
      setReview(null); await load(); toast({ title: 'Document approved', description: 'Available for relevant WhatsApp and webchat requests and published playbook steps.' });
    } catch (err) { notifyFailure(err); }
    finally { setBusy(false); }
  };
  const withdrawDocument = async () => {
    if (!withdraw || !reason.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/settings/support-documents/${withdraw.id}/withdraw`, { revision: withdraw.revision, reason });
      setWithdraw(null); await load(); toast({ title: 'Document withdrawn', description: 'The file is retained, but automatic sharing is stopped.' });
    } catch (err) { notifyFailure(err); }
    finally { setBusy(false); }
  };
  const approvalBlocker = !review ? '' : !reviewedChecksum || reviewedChecksum !== review.checksum
    ? 'Download the current PDF before approving it.'
    : !certified ? 'Confirm that you reviewed the PDF and have permission to share it.'
    : !reason.trim() ? 'Add an approval note to continue.' : '';
  const filtered = documents.filter(document => (filter === 'all' || (filter === 'published' ? documentIsAvailable(document) : document.status === filter))
    && `${document.title} ${document.description} ${documentTopicLabel(document.service)}`.toLowerCase().includes(query.toLowerCase()));
  const profileLabel = (id: number | null) => id ? profiles.find(profile => profile.id === id)?.companyName
    || profiles.find(profile => profile.id === id)?.company_name || `Profile ${id}` : 'Current business';

  return <div className="mx-auto w-full max-w-screen-xl space-y-6 px-4 py-5 sm:px-6 lg:py-7">
    <Link href="/dashboard/knowledge-base" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Knowledge base</Link>
    <PageHeader icon={FileText} title="Documents" subtitle="Approved brochures, menus and factsheets your support agents can share"
      actions={<div className="flex gap-2"><Button variant="outline" size="sm" disabled={loading || busy} onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button><Button size="sm" onClick={() => openDraft(null)}><Plus className="mr-2 h-4 w-4" />Add document</Button></div>} />
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><p className="text-sm font-medium">Approve once — agents find the right document</p><p className="mt-1 max-w-2xl text-xs text-muted-foreground">No playbook linking needed. AI searches approved documents using the customer’s request, topic and your description. Matching PDFs can be shared through WhatsApp or secure webchat downloads.</p></div></div>
    </div>
    <div className="flex flex-col gap-3 sm:flex-row"><SearchInput aria-label="Search documents" value={query} onValueChange={setQuery} placeholder="Search documents or topics…" wrapperClassName="flex-1" />
      <select aria-label="Document status" className="h-10 rounded-md border bg-background px-3 text-sm" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All documents</option><option value="published">Approved for sharing</option><option value="draft">Drafts</option><option value="withdrawn">Withdrawn</option></select></div>
    {error ? <Callout tone="danger" actions={<Button variant="outline" onClick={() => void load()}>Retry loading</Button>}>{error}</Callout>
      : loading ? <LoadingState className="py-16" label="Loading documents…" showLabel />
      : !filtered.length ? <div className="rounded-xl border border-dashed bg-card px-6 py-16 text-center"><FileText className="mx-auto h-8 w-8 text-muted-foreground" /><h2 className="mt-4 font-semibold">{documents.length ? 'No documents match this view' : 'Give your agents the right document'}</h2><p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">Add a PDF, describe who it helps, and approve the exact file. Your agents and document steps can then find it automatically.</p><Button className="mt-5" variant="outline" onClick={() => openDraft(null)}>Add document</Button></div>
      : <div className="space-y-3">{filtered.map(document => <article key={document.id} aria-label={document.title} className="rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:justify-between"><div className="flex min-w-0 gap-3"><div className="flex h-11 w-10 shrink-0 items-center justify-center rounded-md border bg-muted text-primary"><FileText className="h-5 w-5" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="break-words text-base font-semibold">{document.title}</h2><Badge variant={documentIsAvailable(document) ? 'default' : 'secondary'}>{documentIsAvailable(document) ? 'Approved' : document.status === 'published' ? 'Expired' : document.status === 'draft' ? 'Draft' : 'Withdrawn'}</Badge></div><p className="mt-1 max-w-2xl break-words text-sm text-muted-foreground">{document.description || 'Add a description to help AI choose this document.'}</p><div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline">{documentTopicLabel(document.service)}</Badge><span className="text-muted-foreground">{profileLabel(document.businessProfileId)} · PDF · Revision {document.revision}</span></div></div></div>
          <div className="flex shrink-0 flex-wrap gap-2 sm:max-w-64 sm:justify-end"><Button size="sm" variant="outline" disabled={busy} onClick={() => void download(document)}><Download className="mr-1.5 h-3.5 w-3.5" />Download</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => openDraft(document)}><Pencil className="mr-1.5 h-3.5 w-3.5" />Edit</Button>{documentIsAvailable(document) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setWithdraw(document); setReason(''); }}>Withdraw</Button> : <Button size="sm" disabled={busy} onClick={() => { setReview(document); setCertified(false); setReviewedChecksum(''); setReason(''); setExpiresAt(''); }}>Review and approve</Button>}</div></div>
      </article>)}</div>}
    <Dialog open={editOpen} onOpenChange={open => { if (!busy) setEditOpen(open); }}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{editing ? 'Edit document' : 'Add document'}</DialogTitle><DialogDescription>{editing ? 'Saving changes stops the old approval. Review and approve the updated draft before sharing again.' : 'Upload a customer-facing PDF. It stays private until you approve sharing.'}</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void saveDraft(); }} className="space-y-4">
        <label className="block space-y-1 text-sm">Title<Input required maxLength={180} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Corporate day-offsite brochure" /></label>
        <label className="block space-y-1 text-sm">When should this be shared?<Textarea maxLength={2000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="For companies planning a one-day offsite. Includes meeting-room packages, meals and terms. Not for overnight stays." /></label>
        <label className="block space-y-1 text-sm">Topic<select className="h-10 w-full rounded-md border bg-background px-3" value={form.service} onChange={event => setForm({ ...form, service: event.target.value })}>{DOCUMENT_TOPICS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="block space-y-1 text-sm">Business or property<select className="h-10 w-full rounded-md border bg-background px-3" value={form.businessProfileId} onChange={event => setForm({ ...form, businessProfileId: event.target.value })}><option value="">Current business</option>{profiles.filter(profile => profile.id === selectedBusinessProfileId()).map(profile => <option key={profile.id} value={profile.id}>{profile.companyName || profile.company_name || profile.name || `Profile ${profile.id}`}</option>)}</select></label>
        <label className="block space-y-1 text-sm">{editing ? 'Replace PDF (optional)' : 'PDF file'}<Input type="file" accept="application/pdf,.pdf" onChange={event => setFile(event.target.files?.[0] || null)} /></label><p className="text-xs text-muted-foreground">PDF only, up to 20 MB. Original files are preserved. Uploading does not certify accuracy, sharing rights or malware safety.</p>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setEditOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || !form.title.trim() || (!file && !form.storageFileId)}>{busy ? 'Saving…' : 'Save draft'}</Button></DialogFooter>
      </form></DialogContent></Dialog>
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(null); }}><DialogContent><DialogHeader><DialogTitle>Approve customer sharing</DialogTitle><DialogDescription>Review every page of {review?.title}. Approval applies to this exact PDF, topic and business scope.</DialogDescription></DialogHeader>
      <Button variant="outline" disabled={busy || !review} onClick={() => review && void download(review)}><Download className="mr-2 h-4 w-4" />Download PDF to review</Button>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={certified} onChange={event => setCertified(event.target.checked)} />I reviewed the PDF, confirmed its accuracy, and have permission to share it with customers.</label>
      <label className="block space-y-1 text-sm">Approval note<Textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} placeholder="Current approved brochure for customer enquiries." /></label>
      <label className="block space-y-1 text-sm">Stop sharing after (optional)<Input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label>
      <p className="break-all font-mono text-[10px] text-muted-foreground">SHA-256: {review?.checksum}</p>
      {approvalBlocker && <p role="status" className="text-xs text-muted-foreground">{approvalBlocker}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Cancel</Button><Button disabled={busy || !certified || !reason.trim() || reviewedChecksum !== review?.checksum} onClick={() => void publish()}>{busy ? 'Approving…' : 'Approve for sharing'}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={Boolean(withdraw)} onOpenChange={open => { if (!open && !busy) setWithdraw(null); }}><DialogContent><DialogHeader><DialogTitle>Withdraw {withdraw?.title}?</DialogTitle><DialogDescription>Stop new automatic sends. The file and audit history are retained; messages already delivered cannot be recalled.</DialogDescription></DialogHeader><label className="block space-y-1 text-sm">Reason<Textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></label><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setWithdraw(null)}>Cancel</Button><Button disabled={busy || !reason.trim()} onClick={() => void withdrawDocument()}>{busy ? 'Withdrawing…' : 'Withdraw document'}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
