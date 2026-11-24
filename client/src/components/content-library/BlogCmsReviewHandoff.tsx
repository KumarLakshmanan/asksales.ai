"use client";

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { readLibraryDraft } from '@/lib/libraryDraft';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface CmsProject { id: number; userId: number; name: string; domain: string; brandToolkitId: number | null; businessProfileId: number | null }
interface CmsBlog { id: number; userId: number; title: string; content: string; version: number; brandToolkitId: number | null; businessProfileId: number | null }
export function BlogCmsReviewHandoff({ assetId }: { assetId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source = useQuery({ queryKey: ['cms-review-source', assetId], queryFn: () => api.get<CmsBlog>(`/api/content/assets/${assetId}`), enabled: open, staleTime: 0 });
  const projects = useQuery({ queryKey: ['cms-review-projects'], queryFn: () => api.get<{ projects: CmsProject[] }>('/api/ai-visibility/projects'), enabled: open, staleTime: 0 });
  const eligible = (projects.data?.projects || []).filter(project => source.data && project.userId === source.data.userId && Boolean(project.brandToolkitId && project.businessProfileId) && project.brandToolkitId === source.data.brandToolkitId && project.businessProfileId === source.data.businessProfileId);
  const audits = useQuery({ queryKey: ['cms-review-audits', projectId], queryFn: () => api.get<{ audits: Array<{ status: string }> }>(`/api/ai-visibility/projects/${projectId}/audits`), enabled: open && Boolean(projectId), staleTime: 0 });
  const ready = audits.data?.audits.some(audit => ['completed', 'completed_with_warnings'].includes(audit.status));
  const submit = async () => {
    if (busy || !ready || !source.data || !eligible.some(project => String(project.id) === projectId)) return;
    setBusy(true); setError('');
    try {
      const result = await api.post<{ linkId: number }>(`/api/ai-visibility/projects/${projectId}/assets/import-blog`, { contentAssetId: assetId, expectedVersion: source.data.version });
      router.push(`/dashboard/ai-visibility/websites/${projectId}/assets?asset=${result.linkId}`);
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The blog could not be linked. Please retry.'); }
    finally { setBusy(false); }
  };
  return <>
    <Button size="sm" variant="outline" onClick={() => { setProjectId(''); setError(''); setOpen(true); }}>Send to CMS review</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}><DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Choose a website for CMS review</DialogTitle><DialogDescription>This links your saved blog to the website’s existing review workflow. It does not publish, create a remote CMS draft, start an analysis, or charge credits.</DialogDescription></DialogHeader>
      <p className="text-sm text-muted-foreground">Required: an owned website with the same Brand Toolkit and business profile, and a completed analysis. Then review and approve the exact version before creating a WordPress or Shopify draft through a connected CMS.</p>
      {source.isLoading || projects.isLoading ? <p role="status">Loading your draft and websites…</p> : source.isError || projects.isError ? <div role="alert"><p>Websites or the draft could not be loaded. Check your access to AI Visibility.</p><Button variant="outline" onClick={() => { void source.refetch(); void projects.refetch(); }}>Retry</Button></div> : <>
        <div className="rounded-md border p-3 text-sm"><p className="font-medium">{source.data?.title} · version {source.data?.version}</p><p className="mt-1 line-clamp-4 whitespace-pre-wrap text-muted-foreground">{readLibraryDraft(source.data?.content || '').body}</p></div>
        <label className="space-y-1 text-sm font-medium">Website<select aria-label="CMS review website" className="h-10 w-full rounded-md border bg-background px-2" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Choose a matching website</option>{eligible.map(project => <option key={project.id} value={project.id}>{project.name} · {project.domain}</option>)}</select></label>
        {!eligible.length && <p role="status" className="text-sm text-muted-foreground">No owned website matches this draft’s brand and business profile. Set up the website in AI Visibility first.</p>}
        {projectId && (audits.isLoading ? <p role="status">Checking completed analyses…</p> : audits.isError ? <p role="alert">Analysis readiness could not be checked. <button className="underline" onClick={() => void audits.refetch()}>Retry</button></p> : !ready ? <p role="status">Complete an analysis for this website before sending a blog to review.</p> : <p className="text-sm text-muted-foreground">A completed analysis is available. Imported article claims still require editorial review.</p>)}
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => router.push('/dashboard/ai-visibility')}>Website settings</Button><Button disabled={busy || !ready || !projectId || source.isFetching} onClick={() => void submit()}>{busy ? 'Linking draft…' : 'Continue to exact-version review'}</Button></div>
    </DialogContent></Dialog>
  </>;
}
