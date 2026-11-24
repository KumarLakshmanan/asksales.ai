"use client";
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { adCampaignBrief } from '@/lib/adCampaignBrief';
import { Button } from '@/components/ui/button';

export function AdCampaignHandoff({ assetId, onInsert, disabled }: { assetId: string; onInsert: (text: string) => void; disabled?: boolean }) {
  const [brief, setBrief] = useState('');
  const [error, setError] = useState('');
  const [inserted, setInserted] = useState(false);
  useEffect(() => {
    let active = true;
    setBrief(''); setError(''); setInserted(false);
    if (!/^[1-9]\d*$/.test(assetId)) { setError('Invalid saved ad ID. Return to the content library.'); return; }
    api.get<Parameters<typeof adCampaignBrief>[0]>(`/api/content/assets/${assetId}`).then(asset => {
      if (active) setBrief(adCampaignBrief(asset));
    }).catch(() => { if (active) setError('This ad draft could not be loaded. Return to the content library and try again.'); });
    return () => { active = false; };
  }, [assetId]);
  return <section className="mx-auto mb-3 w-full max-w-4xl rounded-lg border bg-primary/5 p-3" aria-label="Ad campaign handoff">
    <p className="text-sm font-medium">Continue with your saved ad</p>
    <p className="text-xs text-muted-foreground">Insert the saved copy as a campaign brief, review it, then send when ready. No campaign is launched by this action.</p>
    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : <Button className="mt-2" size="sm" variant="outline" disabled={!brief || disabled || inserted} onClick={() => { onInsert(brief); setInserted(true); }}>{inserted ? 'Brief added to composer' : brief ? 'Insert campaign brief' : 'Loading saved ad…'}</Button>}
  </section>;
}
