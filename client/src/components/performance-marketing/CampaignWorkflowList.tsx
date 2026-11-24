"use client";
import styles from "@/components/marketing/marketing.module.css";
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CampaignEvidenceBadge } from './CampaignEvidenceBadge';
import { campaignResult, campaignAttentionReason, type PresentedCampaign } from '@/lib/performancePresentation';

export type WorkflowCampaign = PresentedCampaign & {
  name: string; adPlatform: string; platformCampaignId?: string | null;
  accountRegistryId?: number | null; campaignAiConsent: boolean;
};
const PAGE_SIZE = 15;
export function CampaignWorkflowList({ campaigns, automation = false, mode, onInspect, onChanged, disabled = false }: {
  disabled?: boolean; campaigns: WorkflowCampaign[]; automation?: boolean; mode?: string;
  onInspect: (campaign: WorkflowCampaign, tab?: 'automation' | 'recommendations' | 'technical' | 'meta' | 'google' | 'delivery') => void;
  onChanged: () => Promise<unknown>;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('attention');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<'import' | 'enable' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [receipts, setReceipts] = useState<Array<{ name: string; error?: string }>>([]);
  const filtered = useMemo(() => campaigns.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) &&
    (filter === 'all' || filter === 'report_only' && c.source === 'provider_cache' || filter === 'monitored' && c.source !== 'provider_cache' || filter === 'consented' && c.campaignAiConsent || filter === 'attention' && Boolean(campaignAttentionReason(c)) || filter === 'recommendations' && Number(c.openRecommendations) > 0))
    .sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'spend' ? Number(b.metrics.spend || 0) - Number(a.metrics.spend || 0) : Number(Boolean(campaignAttentionReason(b))) - Number(Boolean(campaignAttentionReason(a))) || Number(b.openRecommendations || 0) - Number(a.openRecommendations || 0) || a.name.localeCompare(b.name)), [campaigns, filter, search, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const chosen = filtered.filter(c => selected.has(String(c.id)));
  const targets = (action: 'import' | 'enable' | 'revoke') => chosen.filter(c => action === 'import' ? c.source === 'provider_cache' : c.source !== 'provider_cache' && c.campaignAiConsent !== (action === 'enable'));
  const run = async () => {
    if (!confirm || busy || disabled) return;
    const action = confirm, rows = targets(action);
    setBusy(true); setReceipts([]);
    const results: Array<{ name: string; error?: string }> = [];
    const failed = new Set<string>();
    for (const [index, campaign] of rows.entries()) {
      setProgress(`${index + 1} of ${rows.length}: ${campaign.name}`);
      try {
        if (action === 'import') {
          await api.post('/api/campaigns/autonomous/import-provider', { platform: campaign.adPlatform, platformCampaignId: campaign.platformCampaignId, ...(campaign.accountRegistryId ? { accountId: campaign.accountRegistryId } : {}) });
        } else {
          // Preserve saved business targets; bulk consent only changes permission.
          const detail = await api.get<{ policy: { thresholds?: Record<string, number> } }>(`/api/campaigns/autonomous/${campaign.id}/performance`);
          await api.put(`/api/campaigns/autonomous/${campaign.id}/policy`, { enabled: action === 'enable', thresholds: detail.policy.thresholds || {} });
        }
        results.push({ name: campaign.name });
      } catch (error) {
        failed.add(String(campaign.id));
        results.push({ name: campaign.name, error: error instanceof Error ? error.message : 'Request failed. Retry this campaign.' });
      }
      setReceipts([...results]);
    }
    setSelected(failed); setConfirm(null); setBusy(false); setProgress('');
    await onChanged();
  };
  const toggle = (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  const monitored = campaigns.filter(c=>c.source!=='provider_cache');
  return <div className="space-y-4">
    {automation && <Card className={styles.coverageSetup}><CardHeader><CardTitle className="text-base">Set up AI monitoring</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-3">
      <div><p className="font-medium">1. Import reporting campaigns</p><p className="mt-1 text-sm text-muted-foreground">{campaigns.length-monitored.length} require import. Select campaigns below to begin saved advisory monitoring.</p></div>
      <div><p className="font-medium">2. Establish evidence and targets</p><p className="mt-1 text-sm text-muted-foreground">Open a monitored campaign to set its business target and review baseline and tracking readiness.</p></div>
      <div><p className="font-medium">3. Choose the account mode</p><p className="mt-1 text-sm text-muted-foreground">Current mode: {mode?.replaceAll('_',' ') || 'off'}. Advisory provides recommendations. Live pause additionally requires campaign consent.</p><Button asChild size="sm" variant="outline" className="mt-2"><Link href="/dashboard/settings/ads">Manage automation settings</Link></Button></div>
    </CardContent></Card>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex-1 text-xs text-muted-foreground">Search campaigns<Input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} className="mt-1" placeholder="Search by campaign name"/></label>
      <label className="text-xs text-muted-foreground">Monitoring status<select className="mt-1 block rounded-md border bg-background p-2 text-sm text-foreground" value={filter} onChange={e=>{setFilter(e.target.value);setPage(1);}}><option value="all">All campaigns</option><option value="report_only">Import required</option><option value="monitored">Monitored</option><option value="consented">Pause consent enabled</option><option value="attention">Needs review</option><option value="recommendations">Open recommendations</option></select></label>
      <label className="text-xs text-muted-foreground">Sort by<select className="mt-1 block rounded-md border bg-background p-2 text-sm text-foreground" value={sort} onChange={e=>{setSort(e.target.value);setPage(1);}}><option value="attention">Needs review first</option><option value="name">Campaign name</option><option value="spend">Highest spend</option></select></label>
    </div>
    {automation && <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled || busy||!visible.length} checked={visible.length>0&&visible.every(c=>selected.has(String(c.id)))} onChange={e=>visible.forEach(c=>toggle(String(c.id),e.target.checked))}/>Select this page</label><span className="text-xs text-muted-foreground">{chosen.length} selected</span>
      <Button size="sm" variant="outline" disabled={disabled || busy||!targets('import').length} onClick={()=>setConfirm('import')}>Import selected ({targets('import').length})</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy||!targets('enable').length} onClick={()=>setConfirm('enable')}>Enable pause consent ({targets('enable').length})</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy||!targets('revoke').length} onClick={()=>setConfirm('revoke')}>Revoke pause consent ({targets('revoke').length})</Button>
    </div>}
    {confirm && <div role="region" aria-label="Confirm monitoring change" className="space-y-3 rounded-lg border border-primary/40 bg-muted/30 p-4"><p className="font-medium">{confirm==='import'?'Import for monitoring':confirm==='enable'?'Allow AI to pause selected campaigns':'Revoke campaign pause consent'} · {targets(confirm).length} campaigns</p><p className="text-sm text-muted-foreground">{confirm==='import'?'Creates monitoring records and advisory evaluations. Provider delivery stays unchanged.':confirm==='enable'?'This permits pause-only actions when Live pause mode and all evidence and safety checks are satisfied. Existing business targets are preserved.':'Pending AI pause actions will be cancelled for these campaigns.'}</p><ul className="max-h-36 overflow-auto text-sm">{targets(confirm).map(c=><li key={c.id}>{c.name}</li>)}</ul><div className="flex gap-2"><Button disabled={disabled || busy} onClick={()=>void run()}>{busy?'Applying…':'Confirm'}</Button><Button disabled={disabled || busy} variant="outline" onClick={()=>setConfirm(null)}>Cancel</Button></div></div>}
    {progress && <p role="status" className="text-sm">{progress}</p>}
    {receipts.length>0&&<div role="status" className="rounded-lg border p-3 text-sm"><p>{receipts.filter(r=>!r.error).length} completed · {receipts.filter(r=>r.error).length} failed</p>{receipts.filter(r=>r.error).map((r,i)=><p className="mt-1 text-destructive" key={i}>{r.name}: {r.error}</p>)}</div>}
    <div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full min-w-[760px] text-left text-sm" aria-label={automation ? 'Campaign automation coverage' : 'Campaign reviews'}>
      <thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{['Campaign', 'Delivery', 'Monitoring', automation ? 'Pause consent' : 'Results', 'Cost / result', 'Actions'].map(label => <th className="px-4 py-3 font-medium" scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{visible.map(c => {const result=campaignResult(c);return <tr key={c.id} className="border-t align-top">
        <td className="min-w-52 px-4 py-4"><div className="flex items-start gap-3">{automation && <input aria-label={`Select ${c.name}`} type="checkbox" className="mt-1 h-4 w-4 accent-primary" disabled={disabled || busy} checked={selected.has(String(c.id))} onChange={e=>toggle(String(c.id),e.target.checked)}/>}<div><p className="font-medium">{c.name}</p><p className="mt-1 text-xs capitalize text-muted-foreground">{c.adPlatform} · {c.objective.replaceAll('_',' ')}</p></div></div></td>
        <td className="px-4 py-4 text-xs capitalize">{(c.providerStatus || c.status || 'Unknown').replaceAll('_',' ')}</td>
        <td className="px-4 py-4"><CampaignEvidenceBadge campaign={c}/><span className="mt-1 block text-xs text-muted-foreground">{c.source==='provider_cache'?'Import required':'Monitored'}</span></td>
        <td className="px-4 py-4 text-xs">{automation ? c.campaignAiConsent ? 'Enabled' : 'Off' : `${Number.isFinite(result.result)?result.result.toLocaleString():'Unavailable'} ${result.resultLabel.toLowerCase()}`}</td>
        <td className="whitespace-nowrap px-4 py-4 text-xs tabular-nums">{Number.isFinite(result.cost)?new Intl.NumberFormat(undefined,{style:'currency',currency:c.currency}).format(result.cost):'—'} {result.costLabel}</td>
        <td className="px-4 py-3"><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={()=>onInspect(c,automation?'automation':'recommendations')}>{automation?c.source==='provider_cache'?'Import for monitoring':'Targets & consent':'Review campaign'}</Button><Button size="sm" variant="ghost" onClick={()=>onInspect(c,c.adPlatform==='google'?'google':'meta')}>Check tracking</Button></div></td>
      </tr>;})}</tbody>
    </table></div>
    {!visible.length&&<p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No campaigns match this search and monitoring status.</p>}
    <Pagination aria-label="Campaign pages" page={currentPage} pageSize={PAGE_SIZE} totalItems={filtered.length} onPageChange={setPage} itemLabel="campaigns"/>
  </div>;
}
