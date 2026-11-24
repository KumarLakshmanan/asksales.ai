"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Pencil, Plus, RefreshCw } from 'lucide-react';
import api from '@/lib/admin-api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { SearchInput } from '@/components/ui/search-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AssistantModelPicker } from '@/components/outreach/assistants/AssistantModelPicker';
import { assistantModelProviderLabels, type AdminAssistantModel, type AdminAssistantModelCatalog } from '../../../../shared/assistantModelCatalog';

type ModelForm = Pick<AdminAssistantModel, 'provider' | 'credentialId' | 'model' | 'label' | 'description' | 'enabled' | 'order'>;
const endpoint = '/api/admin/assistant-models';
const selectClass = 'min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm';

export default function AssistantModelCatalog() {
  const [data, setData] = useState<AdminAssistantModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('all');
  const [status, setStatus] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AdminAssistantModel | null>(null);
  const [form, setForm] = useState<ModelForm>({ provider: '', credentialId: null, model: '', label: '', description: '', enabled: true, order: 0 });
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const saveLock = useRef(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await api.get<AdminAssistantModelCatalog>(endpoint)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Model catalog could not be loaded. Try again.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const canManage = Boolean(data?.canManage && !loading && !error && !busy);
  const beginEdit = (entry: AdminAssistantModel | null) => {
    const connection = data?.connections.find(item => item.connected);
    setEditing(entry);
    setForm(entry ? { provider: entry.provider, credentialId: entry.credentialId, model: entry.model, label: entry.label, description: entry.description, enabled: entry.enabled, order: entry.order }
      : { provider: connection?.provider || '', credentialId: connection?.id || null, model: '', label: '', description: '', enabled: true, order: (data?.models.length || 0) + 1 });
    setFormError(''); setOpen(true);
  };
  const persist = async (value: ModelForm, entry: AdminAssistantModel | null, fromEditor: boolean) => {
    if (saveLock.current || !canManage) return;
    saveLock.current = true; setBusy(true); setNotice(''); setFormError('');
    try {
      const body = { ...value, model: value.model.trim(), label: value.label.trim(), description: value.description.trim(), expectedVersion: entry?.version || 0,
        ...(entry && entry.id === null ? { original: { provider: entry.provider, model: entry.model } } : {}) };
      if (entry?.id) await api.put(`${endpoint}/${entry.id}`, body);
      else await api.post(endpoint, body);
      if (fromEditor) setOpen(false);
      setNotice('Model catalog updated. Assistants can select enabled models with configured connections.');
      await load();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Model could not be saved. Try again.';
      if (fromEditor) setFormError(message); else setError(message);
    } finally { saveLock.current = false; setBusy(false); }
  };
  const providers = [...new Set([...(data?.connections.map(item => item.provider) || []), ...(data?.models.map(item => item.provider) || [])])];
  const rows = data?.models.filter(entry => (provider === 'all' || entry.provider === provider)
    && (status === 'all' || (status === 'enabled' ? entry.enabled : !entry.enabled))
    && `${entry.label} ${entry.model} ${entry.description}`.toLowerCase().includes(search.toLowerCase())) || [];
  const previewModels = data?.models.filter(entry => entry.enabled && entry.connected).map(entry => ({ provider: entry.provider, model: entry.model, label: entry.label, description: entry.description, controls: [] as [] })) || [];
  const [preview, setPreview] = useState<{ provider: string; model: string } | null>(null);
  const connection = data?.connections.find(item => item.id === form.credentialId && item.provider === form.provider);
  const valid = Boolean(form.label.trim() && form.model.trim() && !/\s/.test(form.model.trim()) && connection
    && (!form.enabled || connection.connected) && Number.isInteger(form.order) && form.order >= 0 && form.order <= 10000);
  return <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 [&_button:not([role=switch])]:min-h-11">
    <header className="space-y-3"><Link href="/admin/dashboard/integrations/llm" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft aria-hidden className="h-4 w-4" />AI providers</Link>
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">AI model catalog</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Choose which models assistants can use and how they appear.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading || busy} onClick={() => void load()}><RefreshCw aria-hidden className="h-4 w-4" />Refresh</Button><Button disabled={!canManage} onClick={() => beginEdit(null)}><Plus aria-hidden className="h-4 w-4" />Add model</Button></div></div>
    </header>
    {notice && <Callout tone="success" announce>{notice}</Callout>}
    {error && <Callout tone="danger" actions={<Button variant="outline" onClick={() => void load()}>Reload catalog</Button>}>{error}</Callout>}
    {loading && !data && <p role="status" className="p-6 text-sm text-muted-foreground">Loading model catalog…</p>}
    {data && <>
      {!data.canManage && <p className="text-sm text-muted-foreground">Only a super administrator can change the model catalog.</p>}
      <section aria-label="Provider connections" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{data.connections.map(item => <div key={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"><div className="min-w-0"><p className="text-sm font-semibold">{assistantModelProviderLabels[item.provider] || item.provider}</p><p className="mt-1 break-words text-xs text-muted-foreground">{item.name}</p><p className="mt-2 text-xs">{item.connected ? 'Configured' : 'Connection unavailable'}</p></div><Link href="/admin/dashboard/integrations/llm" className="inline-flex min-h-11 items-center gap-1 text-xs text-primary underline underline-offset-4">Manage connection<ArrowRight aria-hidden className="h-3 w-3" /></Link></div>)}{!data.connections.length && <p className="rounded-xl border p-5 text-sm text-muted-foreground">Configure an AI provider connection before adding models.</p>}</section>
      <section aria-label="Model catalog" className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-col gap-3 border-b p-4 md:flex-row"><SearchInput aria-label="Search catalog models" value={search} onValueChange={setSearch} placeholder="Search models" wrapperClassName="flex-1" className="min-h-11" /><select aria-label="Filter models by provider" className={`${selectClass} md:w-48`} value={provider} onChange={event => setProvider(event.target.value)}><option value="all">All providers</option>{providers.map(value => <option key={value} value={value}>{assistantModelProviderLabels[value] || value}</option>)}</select><select aria-label="Filter models by status" className={`${selectClass} md:w-44`} value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></div>
        <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.4fr)_140px_55px_50px] gap-3 border-b bg-muted/30 px-5 py-3 text-xs font-medium max-lg:hidden" aria-hidden><span>Display name</span><span>Provider</span><span>Model ID</span><span>Available to assistants</span><span>Order</span><span>Edit</span></div>
        <div className="divide-y">{rows.map(entry => <article aria-label={`Model: ${entry.label}`} key={entry.id || `${entry.provider}:${entry.model}`} className="grid items-center gap-3 p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.4fr)_140px_55px_50px]">
          <div className="min-w-0"><h2 className="break-words text-sm font-semibold">{entry.label}</h2>{entry.description && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{entry.description}</p>}{!entry.connected && <p className="mt-1 text-xs text-destructive">Connection unavailable</p>}</div>
          <p className="text-xs text-muted-foreground">{assistantModelProviderLabels[entry.provider] || entry.provider}</p><code className="break-all text-xs text-muted-foreground">{entry.model}</code>
          <div className="flex items-center gap-2"><Switch aria-label={`Make ${entry.label} available to assistants`} checked={entry.enabled} disabled={!canManage || (!entry.connected && !entry.enabled) || !entry.credentialId} onCheckedChange={enabled => void persist({ provider: entry.provider, credentialId: entry.credentialId, model: entry.model, label: entry.label, description: entry.description, enabled, order: entry.order }, entry, false)} /><span className="text-xs lg:hidden">Available to assistants</span></div>
          <span className="text-xs"><span className="lg:hidden">Order: </span>{entry.order}</span><Button variant="ghost" size="icon" aria-label={`Edit ${entry.label}`} disabled={!canManage} onClick={() => beginEdit(entry)}><Pencil aria-hidden className="h-4 w-4" /></Button>
        </article>)}</div>
        {!rows.length && <p className="p-8 text-center text-sm text-muted-foreground">{data.models.length ? 'No models match these filters.' : 'No models are configured. Add a model to make it available to assistants.'}</p>}
      </section>
      <section className="rounded-xl border bg-card p-5"><h2 className="text-base font-semibold">Assistant model picker preview</h2><p className="mt-2 text-sm text-muted-foreground">Users choose from enabled models with configured connections.</p><div className="mt-5 max-w-md"><AssistantModelPicker models={previewModels} value={previewModels.some(model => model.provider === preview?.provider && model.model === preview.model) ? preview : null} onChange={setPreview} /></div></section>
    </>}
    <Sheet open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-md [&_button:not([role=switch])]:min-h-11">
      <SheetHeader><SheetTitle>{editing ? 'Edit model' : 'Add model'}</SheetTitle><SheetDescription>Set the name assistants see and the provider connection used for replies.</SheetDescription></SheetHeader>
      <form className="mt-6 flex flex-1 flex-col gap-5" onSubmit={event => { event.preventDefault(); if (valid) void persist(form, editing, true); }}>
        <fieldset disabled={busy} className="space-y-5">
          <div className="space-y-2"><Label htmlFor="catalog-label">Display name</Label><Input id="catalog-label" required maxLength={120} value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} className="min-h-11" /></div>
          <div className="space-y-2"><Label htmlFor="catalog-connection">Provider connection</Label><select id="catalog-connection" required className={selectClass} value={form.credentialId || ''} onChange={event => { const item = data?.connections.find(value => value.id === Number(event.target.value)); setForm({ ...form, credentialId: item?.id || null, provider: item?.provider || '' }); }}><option value="">Choose connection</option>{data?.connections.map(item => <option key={item.id} value={item.id} disabled={!item.connected && item.id !== form.credentialId}>{assistantModelProviderLabels[item.provider] || item.provider} · {item.name}{!item.connected ? ' · Unavailable' : ''}</option>)}</select></div>
          <div className="space-y-2"><Label htmlFor="catalog-model">Exact model ID</Label><Input id="catalog-model" required maxLength={250} value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} className="min-h-11 font-mono" /><p className="text-xs leading-5 text-muted-foreground">Must match a model supported by this provider. Changing the provider or ID creates a new option and retires the old one.</p></div>
          <div className="flex items-center justify-between gap-3"><Label htmlFor="catalog-enabled">Available to assistants</Label><Switch id="catalog-enabled" checked={form.enabled} onCheckedChange={enabled => setForm({ ...form, enabled })} /></div>
          <div className="space-y-2"><Label htmlFor="catalog-order">Display order</Label><Input id="catalog-order" type="number" min={0} max={10000} step={1} required value={Number.isFinite(form.order) ? form.order : ''} onChange={event => setForm({ ...form, order: event.target.value === '' ? NaN : Number(event.target.value) })} className="min-h-11" /></div>
          <div className="space-y-2"><Label htmlFor="catalog-description">Short description (optional)</Label><Textarea id="catalog-description" maxLength={500} rows={3} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></div>
        </fieldset>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <div className="mt-auto flex justify-end gap-3 border-t pt-5"><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={!valid || !canManage}>{busy ? 'Saving…' : 'Save model'}</Button></div>
      </form>
    </SheetContent></Sheet>
  </div>;
}
