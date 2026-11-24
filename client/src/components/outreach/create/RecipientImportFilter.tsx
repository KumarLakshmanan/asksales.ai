import type { OutreachImportSources } from '../../../../../shared/outreachImportSources';

export type RecipientSource = 'all' | 'current' | 'campaign' | 'crm';

interface Props {
  source: RecipientSource;
  campaign: string;
  upload: string;
  threadId: string | null;
  sources: OutreachImportSources | null;
  error: string;
  onSource: (value: RecipientSource) => void;
  onCampaign: (value: string) => void;
  onUpload: (value: string) => void;
  onRetry: () => void;
}

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
function batchLabel(batch: { fileName: string; createdAt: string; count: number; status?: string }) {
  const date = new Date(batch.createdAt);
  const dateLabel = Number.isNaN(date.getTime()) ? '' : ` · ${date.toLocaleDateString()}`;
  const status = batch.status && batch.status !== 'completed' ? ` · ${batch.status}` : '';
  return `${batch.fileName}${dateLabel} · ${batch.count} contacts${status}`;
}

export function RecipientImportFilter({ source, campaign, upload, threadId, sources, error, onSource, onCampaign, onUpload, onRetry }: Props) {
  const selectedCampaign = sources?.campaigns?.find(item => (item.id === null ? 'unassigned' : String(item.id)) === campaign);
  return <div className="space-y-2">
    <label className="block space-y-1 text-xs font-medium">
      <span>Contact source</span>
      <select className={selectClass} aria-label="Contact source" value={source} onChange={event => onSource(event.target.value as RecipientSource)}>
        <option value="all">All contacts</option>
        {threadId && <option value="current">Current campaign leads</option>}
        <option value="campaign">Campaign uploads</option>
        <option value="crm">CRM imports</option>
      </select>
    </label>
    {error && (source === 'campaign' || source === 'crm') && <p role="alert" className="text-xs text-destructive">{error} <button type="button" className="underline" onClick={onRetry}>Retry</button></p>}
    {(source === 'campaign' || source === 'crm') && !sources && !error && <p role="status" className="text-xs text-muted-foreground">Loading imports…</p>}
    {source === 'campaign' && sources && <>
      <label className="block space-y-1 text-xs font-medium">
        <span>Campaign</span>
        <select className={selectClass} aria-label="Campaign" value={campaign} onChange={event => onCampaign(event.target.value)}>
          <option value="all">All campaign uploads</option>
          {sources.campaigns.map(item => <option key={item.id ?? 'unassigned'} value={item.id ?? 'unassigned'}>{item.name}</option>)}
        </select>
      </label>
      {selectedCampaign && <label className="block space-y-1 text-xs font-medium">
        <span>Upload</span>
        <select className={selectClass} aria-label="Campaign upload" value={upload} onChange={event => onUpload(event.target.value)}>
          <option value="all">All uploads in this campaign</option>
          {selectedCampaign.historicalCount > 0 && <option value="legacy">Earlier uploads · {selectedCampaign.historicalCount} contacts</option>}
          {selectedCampaign.uploads.map(item => <option key={item.id} value={item.id}>{batchLabel(item)}</option>)}
        </select>
      </label>}
    </>}
    {source === 'crm' && sources && <label className="block space-y-1 text-xs font-medium">
      <span>CRM import</span>
      <select className={selectClass} aria-label="CRM import" value={upload} onChange={event => onUpload(event.target.value)}>
        <option value="all">All CRM imports</option>
        {sources.crmImports.map(item => <option key={item.id} value={item.id}>{batchLabel(item)}</option>)}
      </select>
    </label>}
  </div>;
}
