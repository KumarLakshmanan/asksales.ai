"use client";

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { Check, LayoutTemplate, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { useOutreachDraftScope } from '@/hooks/use-outreach-draft-scope';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { EMAIL_DESIGNS, renderEmailDesign, type EmailBrand, type EmailDesignId, type EmailDesignPreferences } from '../../../../shared/emailDesigns';

interface DesignSettings { canManage: boolean; preferences: EmailDesignPreferences; brand: EmailBrand }
const ENDPOINT = '/api/settings/outreach/email-designs';
function useDesignSettings(brandToolkitId?: number) {
  const scope = useOutreachDraftScope();
  // Preview with the brand this outreach will be sent with, not just the default.
  const queryKey = ['email-designs', scope, brandToolkitId ?? 'default'];
  return { queryKey, ...useQuery({ queryKey, queryFn: () => api.get<DesignSettings>(brandToolkitId ? `${ENDPOINT}?brandToolkitId=${brandToolkitId}` : ENDPOINT), enabled: !scope.startsWith('anonymous:') && !scope.endsWith(':unselected'), staleTime: 30_000 }) };
}

export function EmailDesignPicker({ value, onChange, body = '', disabled, kind = 'outreach', brandToolkitId }: {
  value?: EmailDesignId; onChange: (id: EmailDesignId) => void; body?: string; disabled?: boolean; kind?: 'outreach' | 'assistant'; brandToolkitId?: number;
}) {
  const [open, setOpen] = useState(false);
  const settings = useDesignSettings(brandToolkitId);
  const [preview, setPreview] = useState<EmailDesignId | undefined>();
  const selected = value ?? settings.data?.preferences[kind] ?? 'classic';
  const active = preview ?? selected;
  const design = EMAIL_DESIGNS.find(item => item.id === selected)!;
  const previewHtml = useMemo(() => open && settings.data ? DOMPurify.sanitize(renderEmailDesign({
    brand: settings.data.brand, designId: active,
    body: body || '<p>Hello Alex,</p><p>Thank you for getting in touch. We’re here to help you plan your next visit.</p><p>Let us know what you have in mind and we’ll help with the next step.</p><p>Warm regards,<br>The team</p>',
  }), { WHOLE_DOCUMENT: true, FORBID_TAGS: ['script', 'form', 'video', 'audio', 'iframe'] }) : '', [open, settings.data, active, body]);
  return <>
    <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setPreview(undefined)} className="gap-2">
      <LayoutTemplate className="h-4 w-4" />Email design <span className="text-muted-foreground">· {design.name}</span>
    </Button></SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-5xl">
        <SheetHeader className="border-b px-6 py-5 text-left"><SheetTitle>Choose an email design</SheetTitle><SheetDescription>Ten layouts, your brand. Your message and links stay the same.</SheetDescription></SheetHeader>
        {settings.isPending ? <div role="status" className="p-8"><Spinner size="sm" label={null} className="mr-2 align-middle" />Loading your brand and designs…</div> : settings.isError ? <div role="alert" className="p-6"><p>Designs could not be loaded.</p><Button variant="outline" onClick={() => void settings.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></div> : <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[320px_minmax(0,1fr)] md:overflow-hidden">
          <div className="grid min-h-0 grid-cols-2 content-start gap-3 border-r bg-muted/20 p-5 md:grid-cols-1 md:overflow-y-auto" role="radiogroup" aria-label="Email designs">
            {EMAIL_DESIGNS.map((item, index) => <button type="button" key={item.id} role="radio" tabIndex={active === item.id ? 0 : -1} aria-checked={active === item.id} onClick={() => setPreview(item.id)} onKeyDown={event => {
              if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? EMAIL_DESIGNS.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + EMAIL_DESIGNS.length) % EMAIL_DESIGNS.length;
              setPreview(EMAIL_DESIGNS[next].id);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }} className={`rounded-xl border p-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${active === item.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border bg-card hover:border-primary/50'}`}>
              <div className="mb-3 flex h-20 items-center justify-center rounded-lg p-3" style={{ background: item.background }} aria-hidden="true"><div className="w-4/5 bg-white p-2 shadow-sm" style={{ borderRadius: item.radius / 2, borderTop: `3px solid ${item.accent}` }}><div className="mb-2 h-2 w-1/3 rounded bg-slate-300"/><div className="h-1 rounded bg-slate-200"/><div className="mt-1 h-1 w-4/5 rounded bg-slate-200"/></div></div>
              <span className="flex items-center justify-between text-sm font-semibold">{item.name}{active === item.id && <Check className="h-4 w-4 text-primary" />}</span><span className="mt-1 block text-xs text-muted-foreground">{item.description}</span>
            </button>)}
          </div>
          <div className="min-h-0 min-w-0 bg-muted/30 p-5 md:overflow-y-auto"><p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Preview · {EMAIL_DESIGNS.find(item => item.id === active)?.name}</p><iframe title="Email design preview" srcDoc={previewHtml} sandbox="allow-same-origin" referrerPolicy="no-referrer" className="h-[620px] w-full rounded-xl border bg-white" /><p className="mt-3 text-xs text-muted-foreground">Gmail and other inboxes may adjust spacing. Images depend on the recipient’s image settings.</p></div>
        </div>}
        <footer className="flex items-center justify-between gap-3 border-t bg-background p-4"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!settings.data || settings.isError} onClick={() => { onChange(active); setOpen(false); }}>Use {EMAIL_DESIGNS.find(item => item.id === active)?.name}</Button></footer>
      </SheetContent>
    </Sheet>
  </>;
}

export function EmailDesignDefaults() {
  const scope = useOutreachDraftScope();
  return <ScopedEmailDesignDefaults key={scope} />;
}
function ScopedEmailDesignDefaults() {
  const settings = useDesignSettings();
  const cache = useQueryClient();
  const [editing, setEditing] = useState<EmailDesignPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const preferences = editing ?? settings.data?.preferences;
  const save = async () => {
    if (!preferences || busy) return;
    setBusy(true); setNotice('');
    try {
      const result = await api.put<{ preferences: EmailDesignPreferences }>(ENDPOINT, preferences);
      // Previews are cached per brand; update the saved defaults in each of them.
      cache.setQueriesData({ queryKey: settings.queryKey.slice(0, 2) }, (old: DesignSettings | undefined) => old ? { ...old, preferences: result.preferences } : old);
      setEditing(null); setNotice('Email designs saved for this business. New emails use these defaults.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Designs could not be saved.'); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-xl border bg-card p-5" aria-label="Email design defaults"><div><h3 className="font-semibold">Email designs</h3><p className="mt-1 text-sm text-muted-foreground">Choose the default for outreach and automatic assistant replies in this business. Existing messages keep their design.</p></div>
    {settings.isPending ? <p role="status">Loading email designs…</p> : settings.isError ? <Button variant="outline" onClick={() => void settings.refetch()}>Retry loading email designs</Button> : preferences && <>
      <div className="grid gap-4 sm:grid-cols-2">{(['outreach', 'assistant'] as const).map(kind => <div key={kind} className="space-y-2"><p className="text-sm font-medium">{kind === 'outreach' ? 'Outreach emails' : 'Assistant replies'}</p><EmailDesignPicker value={preferences[kind]} kind={kind} disabled={busy || !settings.data?.canManage} onChange={id => { setEditing({ ...preferences, [kind]: id }); setNotice(''); }} /></div>)}</div>
      <div className="flex flex-wrap gap-2"><Button loading={busy} disabled={!editing || !settings.data?.canManage} onClick={() => void save()}>Save email designs</Button><Button variant="ghost" disabled={busy} onClick={() => { setEditing(null); setNotice(''); void settings.refetch(); }}>Reload defaults</Button></div>
    </>}
    {settings.data && !settings.data.canManage && <p className="text-sm text-muted-foreground">Ask the business owner or billing admin to change these defaults.</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
