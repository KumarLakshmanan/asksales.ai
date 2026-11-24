"use client";
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Target } from 'lucide-react';
import { PageShell } from '@/components/ui/page-shell';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import styles from '@/components/marketing/marketing.module.css';

export default function CreatePaidCampaignPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [platform, setPlatform] = useState(params.get('platform') === 'google' ? 'google' : 'meta');
  const [objective, setObjective] = useState('leads');
  const sourceAdId = /^\d{6,40}$/.test(params.get('sourceAdId') || '') ? params.get('sourceAdId')! : '';
  const sourcePage = params.get('sourcePage')?.slice(0, 100) || '';
  const sourceCopy = params.get('sourceCopy')?.slice(0, 500) || '';
  const sourceFormat = ['image', 'video', 'carousel'].includes(params.get('sourceFormat') || '') ? params.get('sourceFormat')! : 'unknown';
  const sourceUrl = /^https:\/\/(www\.|business\.)facebook\.com\/ads\/library\/\?id=\d+$/.test(params.get('sourceUrl') || '') ? params.get('sourceUrl')! : '';
  const [name, setName] = useState(sourcePage ? `${sourcePage} inspired campaign`.slice(0, 120) : '');
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState('');
  const edited = Boolean(name || brief || budget || objective !== 'leads' || platform !== (params.get('platform') === 'google' ? 'google' : 'meta'));
  useEffect(() => {
    if (!edited) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [edited]);
  return <PageShell maxWidth="2xl" padding="md" className={styles.surface}><PageHeader className={styles.header} icon={Target} title="Create a paid campaign" subtitle="Prepare a brief for the Performance Marketing agent. Review the draft and provider settings before publishing."/>
    <ol aria-label="Campaign preparation stages" className={styles.steps}>
      {[
        ['Prepare brief', 'Tell us about your campaign'],
        ['Agent draft', 'The agent prepares a review-only draft'],
        ['Review & publish', 'Confirm settings and approve publishing'],
      ].map(([title, description], index) => <li key={title} className={styles.step} aria-current={index === 0 ? 'step' : undefined}><span className={styles.stepNumber}>{index + 1}</span><div><p className="text-sm font-semibold">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div></li>)}
    </ol>
    <Card><CardHeader><CardTitle>Campaign brief</CardTitle><CardDescription>Choose the intended outcome. The agent will confirm account, currency, audience, tracking, creative, and budget before preparing a campaign.</CardDescription></CardHeader><CardContent>
      {sourceAdId && <div className="mb-5 rounded-md border bg-muted/40 p-3 text-sm"><p className="font-medium">Selected reference: {sourcePage || `Ad ${sourceAdId}`}</p><p>Observed format: {sourceFormat === 'unknown' ? 'Confirm format' : sourceFormat}</p>{sourceCopy && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-muted-foreground">{sourceCopy}</p>}{sourceUrl && <a className="mt-2 inline-block underline" href={sourceUrl} target="_blank" rel="noopener noreferrer">View source ad</a>}</div>}
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); const source = sourceAdId ? `\nReference ad: ${sourcePage || 'Meta advertiser'}, Library ID ${sourceAdId}${sourceUrl ? `, ${sourceUrl}` : ''}.\nObserved format: ${sourceFormat}. ${sourceFormat === 'unknown' ? 'Confirm the actual format before drafting.' : `Prepare an original ${sourceFormat} creative concept.`}\nObserved copy for context only: ${sourceCopy || 'Unavailable'}.\nUse the format as inspiration; write original copy and use only claims supported by my business details.` : ''; const query = new URLSearchParams({agent:'performance_marketing',paidAdBrief:`Prepare a review-only paid campaign draft.\nCampaign: ${name.trim()}\nPlatform: ${platform}\nObjective: ${objective}\nBudget guidance: ${budget.trim() || 'Confirm with me'}\nAudience, offer, and destination: ${brief.trim()}${source}\nConfirm the ad account, currency, tracking, schedule and creative. Ask for my explicit publishing approval before any live campaign is created.`}); router.push(`/dashboard/conversations?${query}`); }}>
        <label className="block space-y-2 text-sm font-medium">Campaign name<Input required maxLength={120} value={name} onChange={event=>setName(event.target.value)} placeholder="e.g. September lead generation"/></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2 text-sm font-medium">Platform<select className="block w-full rounded-md border bg-background p-2 font-normal" value={platform} onChange={event=>setPlatform(event.target.value)}><option value="meta">Meta Ads</option><option value="google">Google Ads</option></select></label><label className="block space-y-2 text-sm font-medium">Objective<select className="block w-full rounded-md border bg-background p-2 font-normal" value={objective} onChange={event=>setObjective(event.target.value)}>{['leads','traffic','awareness','engagement','sales','app_promotion','conversations','conversions'].map(value=><option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}</select></label></div>
        <label className="block space-y-2 text-sm font-medium">Budget guidance<Input maxLength={100} value={budget} onChange={event=>setBudget(event.target.value)} placeholder="e.g. INR 500 per day; leave blank to discuss"/></label>
        <label className="block space-y-2 text-sm font-medium">Audience, offer, and destination<textarea required maxLength={1200} className="block min-h-32 w-full rounded-md border bg-background p-3 font-normal" value={brief} onChange={event=>setBrief(event.target.value)} placeholder="Who should see this ad, what are you offering, and where should they go?"/></label>
        <div className="flex flex-wrap gap-3"><Button type="submit">Continue with Performance Marketing</Button><Button asChild variant="outline"><Link href="/dashboard/ads?tab=campaigns" onClick={event => { if (edited && !window.confirm("Discard this unsaved campaign brief?")) event.preventDefault(); }}>Back to campaigns</Link></Button></div>
      </form>
    </CardContent></Card>
  </PageShell>;
}
