"use client";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { CopyButton } from '@/components/ui/copy-button';
import { useToast } from '@/hooks/use-toast';

export function AdReviewPanel({ ad, onCampaign }: { ad: { headline: string; body: string; description?: string; headlines?: string[]; descriptions?: string[]; displayUrl?: string; platform: string }; onCampaign: () => void }) {
  const [placement, setPlacement] = useState(ad.platform === 'google' ? 'search' : ad.platform === 'linkedin' ? 'linkedin' : 'feed');
  const { toast } = useToast();
  const headlines = [...new Set([ad.headline, ...(ad.headlines || [])])].filter(Boolean);
  const descriptions = [...new Set([ad.description || '', ...(ad.descriptions || [])])].filter(Boolean);
  const limits = placement === 'search' ? { headline: 30, body: 90 } : placement === 'linkedin' ? { headline: 70, body: 150 } : { headline: 40, body: 125 };
  const warnings = [
    headlines.some(text => text.length > limits.headline) && `Some headlines exceed the ${limits.headline}-character ${placement === 'search' ? 'search' : 'selected placement'} guidance.`,
    !ad.displayUrl && 'Add a landing page before campaign creation.',
    /\b(?:guarantee[ds]?|risk.free|cure|100%)\b/i.test(`${ad.headline} ${ad.body}`) && 'Review absolute, medical or guaranteed claims and supporting evidence.',
    /\b(?:your debt|your disability|your illness|are you suffering)\b/i.test(ad.body) && 'Review language that implies sensitive personal attributes.',
  ].filter(Boolean);
  const copyFailed = () => toast({ title: 'Copy failed', description: 'Select and copy the text manually.', variant: 'destructive' });
  return <section className="mx-auto mt-4 max-w-3xl space-y-3 rounded-xl border bg-card p-5" aria-label="Ad placement and policy review">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Placement review</h3><Button size="sm" onClick={onCampaign}>Continue to ad campaign</Button></div>
    <label className="flex items-center gap-3 text-sm">Proof layout<select className="rounded border bg-background px-2 py-1" value={placement} onChange={event => setPlacement(event.target.value)}><option value="feed">Meta feed</option><option value="search">Google search</option><option value="linkedin">LinkedIn feed</option></select></label>
    <p className="text-xs text-muted-foreground">Layout checks are guidance, not platform approval. Confirm the exact ad format and policies in the campaign setup.</p>
    <div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">{placement === 'search' ? 'Sponsored search result' : 'Sponsored post'}</p><p className="mt-1 break-all text-xs">{ad.displayUrl || 'Landing page not set'}</p><p className="mt-2 font-semibold">{placement === 'search' ? headlines.slice(0, 3).join(' | ') : ad.headline}</p><p className="mt-2 whitespace-pre-wrap text-sm">{placement === 'search' ? descriptions.slice(0, 2).join(' ') : ad.body}</p></div>
    <details><summary className="cursor-pointer text-sm font-medium">Headline alternatives ({headlines.length})</summary><ul className="mt-2 space-y-2">{headlines.map(text => <li key={text} className="flex items-center justify-between gap-2 text-sm"><span>{text}<span className="ml-2 text-xs text-muted-foreground">{text.length}/{limits.headline}</span></span><CopyButton size="sm" variant="ghost" value={text} aria-label={`Copy headline: ${text}`} onError={copyFailed} /></li>)}</ul></details>
    {warnings.length > 0 && <Callout tone="warning" size="sm"><ul className="space-y-1" aria-label="Ad review warnings">{warnings.map(warning => <li key={String(warning)}>{warning}</li>)}</ul></Callout>}
    <p className="text-xs text-muted-foreground">Before launch: verify claims, destination, account connection, targeting, budget and schedule. Continuing only prepares an editable brief; it does not publish or spend.</p>
  </section>;
}
