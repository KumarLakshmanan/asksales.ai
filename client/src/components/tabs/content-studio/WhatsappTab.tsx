"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, MessageCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useContentLibraryRefresh } from '@/hooks/useContentLibraryRefresh';
import type { ContentAsset } from '@/components/content-library/types';
import api from '@/lib/api';

function templateText(content: string): string {
  try {
    const data = JSON.parse(content);
    return [data.header, data.body, data.footer, data.cta_button?.label, ...(data.quick_reply_buttons || [])].filter(Boolean).join('\n\n');
  } catch { return content; }
}

export default function WhatsappTab({ threadId, refreshKey = 0, hideGenerateButton, onSendMessage }: {
  threadId?: number; refreshKey?: number; hideGenerateButton?: boolean; onSendMessage?: (message: string) => void;
}) {
  const { toast } = useToast();
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const request = useRef(0);
  const reload = useCallback(async () => {
    const version = ++request.current;
    setLoading(true); setError(false);
    try {
      const params = new URLSearchParams({ type: 'whatsapp_template' });
      if (threadId) params.set('threadId', String(threadId));
      const response = await api.get<ContentAsset[]>(`/api/content/assets?${params}`);
      if (version === request.current) setAssets(response);
    } catch { if (version === request.current) setError(true); }
    finally { if (version === request.current) setLoading(false); }
  }, [threadId]);
  const invalidateRequests = useCallback(() => { request.current++; }, []);
  useEffect(() => { setAssets([]); void reload(); return invalidateRequests; }, [reload, invalidateRequests]);
  useContentLibraryRefresh(refreshKey, reload);
  const remove = async (id: number) => {
    try { await api.delete(`/api/content/assets/${id}`); setAssets(items => items.filter(asset => asset.id !== id)); }
    catch { toast({ title: 'Template could not be deleted', variant: 'destructive' }); }
  };
  const download = (asset: ContentAsset) => {
    const url = URL.createObjectURL(new Blob([templateText(asset.content)], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = `${asset.title}.txt`; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="flex h-full flex-col">
    <div className="flex items-center justify-between border-b p-3">
      <div className="flex items-center gap-2"><MessageCircle className="h-5 w-5 text-primary" /><div><h3 className="text-sm font-semibold">WhatsApp Templates</h3><p className="text-xs text-muted-foreground">{assets.length} drafts</p></div></div>
      <div className="flex gap-2"><Button size="sm" variant="ghost" aria-label="Refresh WhatsApp templates" disabled={loading} onClick={reload}><RefreshCw className="h-4 w-4" /></Button>
        {!hideGenerateButton && onSendMessage && <Button size="sm" onClick={() => onSendMessage('Help me create a WhatsApp template for this campaign. Prepare an editable review before saving.')}><Plus className="mr-1 h-4 w-4" />Generate</Button>}
      </div>
    </div>
    <div className="border-b p-3"><Input aria-label="Search WhatsApp templates" placeholder="Search WhatsApp templates…" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <div className="flex-1 overflow-auto p-3">
      {loading ? <p className="text-sm text-muted-foreground">Loading templates…</p> : error ? <div role="alert">WhatsApp templates could not be loaded.<Button variant="ghost" onClick={reload}>Retry</Button></div> : assets.length === 0 ? <p className="p-8 text-center text-muted-foreground">No WhatsApp Templates Yet</p> : <div className="grid gap-3 sm:grid-cols-2">
        {assets.filter(asset => `${asset.title} ${templateText(asset.content)}`.toLowerCase().includes(search.toLowerCase())).map(asset => <article key={asset.id} className="rounded-xl border bg-card p-4">
          <h4 className="mb-3 font-semibold">{asset.title}</h4><p className="whitespace-pre-wrap text-sm">{templateText(asset.content)}</p>
          <div className="mt-4 flex justify-end gap-1">
            <Button size="icon" variant="ghost" aria-label={`Copy ${asset.title}`} onClick={async () => { await navigator.clipboard.writeText(templateText(asset.content)); toast({ title: 'Copied' }); }}><Copy className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" aria-label={`Download ${asset.title}`} onClick={() => download(asset)}><Download className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" aria-label={`Delete ${asset.title}`} onClick={() => remove(asset.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        </article>)}
      </div>}
    </div>
  </div>;
}
