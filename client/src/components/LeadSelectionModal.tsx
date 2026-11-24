import { useEffect, useState } from 'react';
import { Users, X } from 'lucide-react';
import api from '@/lib/api';
import { useOutreachDraftScope } from '@/hooks/use-outreach-draft-scope';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Spinner } from '@/components/ui/spinner';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { RecipientImportFilter, type RecipientSource } from './outreach/create/RecipientImportFilter';
import { INBOX_CHANNELS, type InboxChannel } from '../../../shared/outreachInbox';
import type { OutreachRecipient } from '../../../shared/outreachCompose';
import type { OutreachImportSources } from '../../../shared/outreachImportSources';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectLeads: (leads: OutreachRecipient[], channel: InboxChannel) => void;
  threadId?: number;
  initialChannel?: InboxChannel;
}

export default function LeadSelectionModal(props: Props) {
  return props.isOpen ? <LeadSelectionDialog {...props} /> : null;
}

function LeadSelectionDialog(props: Props) {
  const scope = useOutreachDraftScope();
  return <Dialog open={props.isOpen} onOpenChange={open => { if (!open) props.onClose(); }}>
    <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
      {props.isOpen && <LeadSelection key={`${scope}:${props.threadId}`} {...props} />}
    </DialogContent>
  </Dialog>;
}

function LeadSelection({ onClose, onSelectLeads, threadId, initialChannel = 'whatsapp' }: Props) {
  const [channel, setChannel] = useState<InboxChannel>(initialChannel);
  const [source, setSource] = useState<RecipientSource>('all');
  const [campaign, setCampaign] = useState('all');
  const [upload, setUpload] = useState('all');
  const [sources, setSources] = useState<OutreachImportSources | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<OutreachRecipient[]>([]);
  const [selected, setSelected] = useState<Record<number, OutreachRecipient>>({});
  const [cursor, setCursor] = useState<number | null>(null);
  const [after, setAfter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [loadedFilter, setLoadedFilter] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setSourceError('');
    void api.get<OutreachImportSources>('/api/outreach-conversations/compose/import-sources', { signal: controller.signal })
      .then(result => {
        if (!Array.isArray(result?.campaigns) || !Array.isArray(result?.crmImports)) throw new Error('Import filters could not be loaded.');
        if (!controller.signal.aborted) setSources(result);
      }).catch(() => { if (!controller.signal.aborted) setSourceError('Import filters could not be loaded.'); });
    return () => controller.abort();
  }, [sourceRetry]);

  const query = new URLSearchParams({ channel });
  if (search.trim()) query.set('search', search.trim());
  if (source === 'current' && threadId) query.set('threadId', String(threadId));
  if (source === 'campaign' || source === 'crm') {
    query.set('importSource', upload === 'legacy' ? 'campaign_legacy' : source);
    if (source === 'campaign' && campaign !== 'all') query.set('campaignId', campaign);
    if (upload !== 'all' && upload !== 'legacy') query.set('importId', upload);
  }
  const filterKey = query.toString();
  if (after) query.set('after', String(after));
  const queryKey = query.toString();
  const current = loadedFilter === filterKey;
  const shown = current ? rows : [];
  const selectedRows = Object.values(selected);
  const allShownSelected = shown.length > 0 && shown.every(row => selected[row.id]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void api.get<{ recipients: OutreachRecipient[]; nextCursor: number | null }>(`/api/outreach-conversations/compose/recipients?${queryKey}`, { signal: controller.signal })
        .then(result => {
          if (!Array.isArray(result?.recipients)) throw new Error('Contacts could not be loaded.');
          if (controller.signal.aborted) return;
          setRows(previous => after ? [...new Map([...previous, ...result.recipients].map(row => [row.id, row])).values()] : result.recipients);
          setCursor(result.nextCursor);
          setLoadedFilter(filterKey);
        }).catch(() => { if (!controller.signal.aborted) setError('Contacts could not be loaded. Try again.'); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search.trim() ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [queryKey, filterKey, after, retry, search]);

  const toggle = (row: OutreachRecipient) => setSelected(previous => {
    const next = { ...previous };
    if (next[row.id]) delete next[row.id];
    else next[row.id] = row;
    return next;
  });
  const resetPage = () => setAfter(null);

  return <>
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2"><Users className="h-5 w-5" />Select outreach recipients</DialogTitle>
      <DialogDescription>Choose contacts, then review the sending account, message and follow-up times before sending.</DialogDescription>
    </DialogHeader>
    <div className="space-y-4 py-2">
      <label className="block space-y-1 text-xs font-medium">Channel
        <select aria-label="Outreach channel" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={channel} onChange={event => { setChannel(event.target.value as InboxChannel); resetPage(); }}>
          {INBOX_CHANNELS.map(value => <option key={value} value={value}>{({ email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', sms: 'SMS' })[value]}</option>)}
        </select>
      </label>
      <RecipientImportFilter source={source} campaign={campaign} upload={upload} threadId={threadId ? String(threadId) : null}
        sources={sources} error={sourceError} onRetry={() => setSourceRetry(value => value + 1)}
        onSource={value => { setSource(value); setCampaign('all'); setUpload('all'); resetPage(); }}
        onCampaign={value => { setCampaign(value); setUpload('all'); resetPage(); }}
        onUpload={value => { setUpload(value); resetPage(); }} />
      <SearchInput aria-label="Search outreach recipients" placeholder="Search name, email, phone or company" value={search} onValueChange={value => { setSearch(value); resetPage(); }} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span aria-live="polite">{selectedRows.length} selected · selections stay when filters change</span>
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!selectedRows.length} onClick={() => setSelected({})}>Clear selection</Button><Button size="sm" variant="outline" disabled={loading || !shown.length} onClick={() => setSelected(previous => {
          const next = { ...previous };
          for (const row of shown) { if (allShownSelected) delete next[row.id]; else next[row.id] = row; }
          return next;
        })}>{allShownSelected ? 'Deselect shown' : 'Select shown'}</Button></div>
      </div>
      {selectedRows.length > 0 && <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">{selectedRows.map(row => <Button key={row.id} variant="secondary" size="sm" aria-label={`Remove ${row.name} ${row.phone || row.email}`} onClick={() => toggle(row)}>{row.name}<X className="ml-2 h-3 w-3" /></Button>)}</div>}
      <div className="max-h-[36dvh] min-h-32 overflow-y-auto rounded-md border" aria-busy={loading}>
        {error ? <p role="alert" className="p-4 text-sm text-destructive">{error} <Button variant="link" onClick={() => setRetry(value => value + 1)}>Retry</Button></p> : <>
          {shown.map(row => <label key={row.id} className="flex cursor-pointer items-start gap-3 border-b p-3 last:border-b-0 hover:bg-muted/40">
            <Checkbox className="mt-1" checked={Boolean(selected[row.id])} aria-label={`Select ${row.name} ${row.phone || row.email}`} onCheckedChange={() => toggle(row)} />
            <span className="min-w-0 text-sm"><span className="block font-medium">{row.name}</span><span className="block break-all text-xs text-muted-foreground">{[row.phone, row.email, row.company].filter(Boolean).join(' · ')}</span></span>
          </label>)}
          {loading ? <p role="status" className="flex items-center gap-2 p-4 text-sm"><Spinner size="sm" label={null} />Loading contacts…</p> : !shown.length && <p className="p-4 text-sm text-muted-foreground">No contacts match these filters. Try All contacts or another import.</p>}
          {cursor && current && !loading && <Button variant="ghost" className="w-full" onClick={() => setAfter(cursor)}>Load more contacts</Button>}
        </>}
      </div>
    </div>
    <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!selectedRows.length} onClick={() => { onSelectLeads(selectedRows, channel); onClose(); }}>Continue with {selectedRows.length} recipient{selectedRows.length === 1 ? '' : 's'}</Button></DialogFooter>
  </>;
}
