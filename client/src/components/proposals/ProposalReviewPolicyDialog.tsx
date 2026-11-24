"use client";

import { useCallback, useEffect, useState } from 'react';
import { FileText, Info, ShieldCheck, Lightbulb } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Spinner } from '@/components/ui/spinner';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SettingsPanel, SettingsSaveBar } from '@/components/settings/SettingsSurface';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';

type Policy = { requireReviewBeforeAiSend: boolean; enabled: boolean; discountThresholdPct: number; amountThreshold: number | null; currency: string; reviewManualPricing: boolean; reviewerMemberIds: number[] };
type Reviewer = { id: number; name: string; email: string; role: string; teamName: string };
const initial: Policy = { requireReviewBeforeAiSend: true, enabled: false, discountThresholdPct: 10, amountThreshold: null, currency: 'USD', reviewManualPricing: true, reviewerMemberIds: [] };

export function ProposalReviewPolicyDialog({ inline = false }: { inline?: boolean }) {
  const [open, setOpen] = useState(inline), [policy, setPolicy] = useState<Policy>(initial), [baseline, setBaseline] = useState<Policy | null>(null);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [autoSendAcknowledged, setAutoSendAcknowledged] = useState(false);
  const dirty = baseline !== null && JSON.stringify(policy) !== JSON.stringify(baseline);
  // Switching from human review to automatic sending is an explicit opt-in: the owner must acknowledge it before saving.
  const enablingAutoSend = baseline !== null && baseline.requireReviewBeforeAiSend && !policy.requireReviewBeforeAiSend;
  const autoSendBlocked = enablingAutoSend && !autoSendAcknowledged;
  useUnsavedChanges(open && dirty);
  const load = useCallback(async () => {
    setLoading(true); setBaseline(null); setError(''); setSaved(false); setAutoSendAcknowledged(false);
    try { const data = await api.get<{ policy: Policy; reviewers: Reviewer[] }>('/api/proposals/review-policy'); const next = { ...initial, ...data.policy }; setPolicy(next); setBaseline(next); setReviewers(data.reviewers); }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : 'The review policy could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);
  const edit = (patch: Partial<Policy>) => { setPolicy(current => ({ ...current, ...patch })); setSaved(false); };
  const save = async () => {
    if (saving || !baseline || !dirty || autoSendBlocked) return;
    setSaving(true); setError(''); setSaved(false);
    try { const next = { ...initial, ...await api.put<Policy>('/api/proposals/review-policy', policy) }; setPolicy(next); setBaseline(next); setSaved(true); if (!inline) setOpen(false); }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : 'The review policy could not be saved. Your changes are kept; try again.'); }
    finally { setSaving(false); }
  };
  const selectedReviewers = reviewers.filter(reviewer => policy.reviewerMemberIds.includes(reviewer.id));
  const valid = Number.isFinite(policy.discountThresholdPct) && policy.discountThresholdPct >= 0 && policy.discountThresholdPct <= 100 && (policy.amountThreshold === null || Number.isFinite(policy.amountThreshold) && policy.amountThreshold > 0) && /^[A-Z]{3}$/.test(policy.currency);
  const content = <>
    {loading ? <p role="status" className="flex items-center gap-2 py-10"><Spinner label={null} />Loading settings…</p> : !baseline ? <Callout tone="danger" actions={<Button variant="outline" onClick={() => void load()}>Try again</Button>}>{error}</Callout> : <>
      {error && <Callout tone="danger">{error}</Callout>}
      <div className={inline ? 'grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]' : 'space-y-5'}>
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          <SettingsPanel title="Sending policy">
            <fieldset className="space-y-4"><legend className="sr-only">AI proposal sending policy</legend>
              {[{ value: true, title: 'Save AI proposals for human review', description: 'A team member reviews each offer before it is sent.' }, { value: false, title: 'Allow eligible AI proposals to send automatically', description: 'Only complete offers with approved pricing, terms, and delivery access qualify.' }].map(option => <label key={String(option.value)} className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-muted/30"><input type="radio" name={`proposal-sending-policy-${inline ? 'page' : 'dialog'}`} className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={policy.requireReviewBeforeAiSend === option.value} onChange={() => edit({ requireReviewBeforeAiSend: option.value })} /><span><strong className="block text-sm font-semibold">{option.title}</strong><span className="mt-1 block text-sm leading-6 text-muted-foreground">{option.description}</span></span></label>)}
            </fieldset>
            {!policy.requireReviewBeforeAiSend && <p className="mt-4 rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">Automatic sending is enabled for eligible new requests. Explicit draft requests stay unsent; revised agreements remain drafts until their changes are verified.</p>}
            {enablingAutoSend && <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"><Checkbox checked={autoSendAcknowledged} onCheckedChange={value => setAutoSendAcknowledged(value === true)} /><span>I understand eligible offers will be sent to customers without a team review. Keep human review if you are unsure.</span></label>}
          </SettingsPanel>
          <SettingsPanel title="Additional approval rules" description="Choose which offers need approval from assigned reviewers.">
            <label className="flex cursor-pointer items-start gap-3 text-sm font-medium"><Checkbox checked={policy.enabled} onCheckedChange={value => edit({ enabled: value === true })} />Require assigned reviewers for high-risk offers</label>
            <fieldset disabled={!policy.enabled} className="mt-5 space-y-5 disabled:opacity-60">
              <div className="grid gap-4 sm:grid-cols-3"><label className="space-y-2 text-sm">Discount above (%)<Input type="number" min={0} max={100} value={policy.discountThresholdPct} onChange={event => edit({ discountThresholdPct: Number(event.target.value) })} /></label><label className="space-y-2 text-sm">Offer value at or above<Input type="number" min={0} value={policy.amountThreshold ?? ''} placeholder="No threshold" onChange={event => edit({ amountThreshold: event.target.value ? Number(event.target.value) : null })} /></label><label className="space-y-2 text-sm">Currency<Input value={policy.currency} maxLength={3} onChange={event => edit({ currency: event.target.value.toUpperCase() })} /></label></div>
              <label className="flex cursor-pointer items-start gap-3 text-sm"><Checkbox checked={policy.reviewManualPricing} onCheckedChange={value => edit({ reviewManualPricing: value === true })} /><span>Include manual or below-catalog pricing</span></label>
              <div><h3 className="text-sm font-semibold">Required reviewers</h3><p className="mt-1 text-sm text-muted-foreground">All selected reviewers must approve the same version of the offer.</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{reviewers.map(reviewer => <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm" key={reviewer.id}><Checkbox checked={policy.reviewerMemberIds.includes(reviewer.id)} onCheckedChange={value => edit({ reviewerMemberIds: value === true ? [...new Set([...policy.reviewerMemberIds, reviewer.id])] : policy.reviewerMemberIds.filter(id => id !== reviewer.id) })} /><span><strong className="block font-medium">{reviewer.name || reviewer.email}</strong><span className="text-xs text-muted-foreground">{reviewer.teamName} · {reviewer.role}</span></span></label>)}</div>{!reviewers.length && <p className="mt-2 text-sm text-muted-foreground">Add an active support team member before enabling this policy.</p>}{policy.enabled && !policy.reviewerMemberIds.length && <p role="alert" className="mt-2 text-sm text-destructive">Select at least one reviewer before saving these rules.</p>}</div>
            </fieldset>
          </SettingsPanel>
        </fieldset>
        <SettingsPanel title="Policy summary" className="lg:sticky lg:top-6">
          <div className="flex gap-3"><FileText aria-hidden className="mt-1 h-5 w-5 shrink-0 text-primary" /><div><h3 className="text-sm font-semibold">{policy.requireReviewBeforeAiSend ? 'All AI offers are saved for review.' : 'Eligible new AI offers can send automatically.'}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{policy.requireReviewBeforeAiSend ? 'A team member reviews each offer before it is sent.' : 'Missing pricing, terms, or delivery access will still prevent sending.'}</p></div></div>
          <div className="mt-6 border-t pt-6"><div className="flex gap-3"><ShieldCheck aria-hidden className="mt-1 h-5 w-5 shrink-0 text-primary" /><div><h3 className="text-sm font-semibold">{policy.enabled ? 'High-risk offers also require all selected reviewers to approve.' : 'Additional approval rules are off.'}</h3>{policy.enabled && <><ul className="mt-3 list-disc space-y-2 pl-4 text-sm text-muted-foreground"><li>Discount above {policy.discountThresholdPct}%</li>{policy.amountThreshold !== null && <li>Offer value at or above {policy.amountThreshold.toLocaleString()} {policy.currency}, or an offer in a different currency</li>}{policy.reviewManualPricing && <li>Manual or below-catalog pricing</li>}</ul><p className="mt-4 text-sm font-medium">Required reviewers</p><p className="mt-1 break-words text-sm leading-6 text-muted-foreground">{selectedReviewers.length ? selectedReviewers.map(reviewer => reviewer.name || reviewer.email).join(', ') : 'No reviewers selected.'}</p></>}</div></div></div>
          {policy.enabled && policy.discountThresholdPct < 100 && <div className="mt-6 flex gap-3 border-t pt-6"><Lightbulb aria-hidden className="mt-1 h-5 w-5 shrink-0 text-primary" /><p className="text-sm leading-6 text-muted-foreground">Example: an offer with a {Math.min(100, policy.discountThresholdPct + 5)}% discount needs approval from every selected reviewer.</p></div>}
          <p className="mt-6 flex gap-2 border-t pt-5 text-xs leading-5 text-muted-foreground"><Info aria-hidden className="h-4 w-4 shrink-0" />Saving this policy does not send existing drafts.</p>
        </SettingsPanel>
      </div>
    </>}
    {saved && <p role="status" className="mt-4 text-sm text-success">Proposal settings saved.</p>}
    <div className="mt-5"><SettingsSaveBar dirty={dirty} saving={saving} onDiscard={() => { if (baseline) { setPolicy(baseline); setSaved(false); setError(''); } }} onSave={() => void save()} label="Save policy" disabled={loading || !baseline || !valid || autoSendBlocked || (policy.enabled && !policy.reviewerMemberIds.length)} />{!inline && <Button variant="ghost" className="mt-2" onClick={() => setOpen(false)}>Cancel</Button>}</div>
  </>;
  if (inline) return <section aria-label="Proposal policy configuration">{content}</section>;
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline"><ShieldCheck className="mr-2 h-4 w-4" />Review policy</Button></DialogTrigger><DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>Proposal settings</DialogTitle></DialogHeader>{content}</DialogContent></Dialog>;
}
