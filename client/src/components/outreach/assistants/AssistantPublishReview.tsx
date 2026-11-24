"use client";

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { accountLabel, assistantBindingKey, assistantChannelLabels, type AssistantBindingInput, type AssistantCatalog, type AssistantDraft, type AssistantReadiness, draftResourceSummary, draftAssignmentDetails } from '@/lib/outreach-assistants';
import { ChannelBadge, ErrorNotice, ReadinessChecks, RuntimeNotice } from './AssistantShared';

export function AssistantPublishReview({ open, onClose, draft, draftVersion, catalog, readiness, issues, conflicts, reassign, onReassign, busy, publishing, error, onPublish }: {
  open: boolean; onClose: () => void; draft: AssistantDraft; draftVersion: number; catalog: AssistantCatalog;
  readiness: AssistantReadiness; issues: string[]; conflicts: AssistantBindingInput[]; reassign: boolean;
  onReassign: (value: boolean) => void; busy: boolean; publishing: boolean; error: string; onPublish: () => void;
}) {
  const assignments = draftAssignmentDetails(draft, catalog);
  const modelLabel = (model: NonNullable<AssistantDraft['replyModel']>) => catalog.models.find(item => item.provider === model.provider && item.model === model.model)?.label || 'Unavailable model';
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent className="ak-dialog ak-publish-dialog [&_button]:min-h-11">
      <DialogHeader className="ak-publish-header text-left">
        <DialogTitle className="text-xl">Review assistant assignments</DialogTitle>
        <DialogDescription>Publishing creates an immutable configuration revision and account assignments. Review every account and resource category. Customer delivery also requires enabled runtime.</DialogDescription>
      </DialogHeader>
      <div className="ak-review-body"><div className="ak-review-columns">
        <div className="ak-review-column">
          <section className="ak-review-card"><h3>{draft.name}</h3><p className="mb-4 text-xs text-muted-foreground">Saved draft v{draftVersion}</p><dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Primary reply model</dt><dd className="mt-1 font-medium">{draft.replyModel ? modelLabel(draft.replyModel) : 'Not selected'}</dd></div><div><dt className="text-xs text-muted-foreground">Approved fallbacks</dt><dd className="mt-1">{draft.fallbackModels.length ? draft.fallbackModels.map(modelLabel).join(' → ') : 'None'}</dd></div></dl></section>
          <section className="ak-review-card"><h3>Receiving accounts</h3><ul className="space-y-3">{draft.bindings.map(binding => {
            const account = catalog.accounts.find(item => assistantBindingKey(item) === assistantBindingKey(binding));
            return <li key={assistantBindingKey(binding)} className="rounded-lg border p-3 text-sm"><p className="mb-2 font-medium">{account ? accountLabel(account) : `${binding.channel} · Account unavailable`}</p><ChannelBadge channel={binding.channel} publicComment={binding.surface === 'public_comment'} /><span className="ml-2 text-xs text-muted-foreground">{binding.surface === 'public_comment' ? 'Public comments' : 'Private messages'}</span></li>;
          })}</ul></section>
          <section className="ak-review-card"><h3>Resource summary</h3><dl className="text-sm">{draftResourceSummary(draft).map(resource => <div className="ak-review-resource" key={resource.label}><dt className="font-medium">{resource.label}</dt><dd className="mt-1 text-muted-foreground">{resource.mode === 'none' ? 'None — intentionally disabled' : resource.mode === 'unconfigured' ? 'Not decided' : `${resource.count} explicitly selected`}{resource.mode === 'selected' && <ul className="mt-1 space-y-1 text-xs leading-5">{assignments[resource.label].map((item, index) => <li key={index}>{item}</li>)}</ul>}</dd></div>)}<div className="ak-review-resource"><dt className="font-medium">Collection fields</dt><dd className="mt-1 text-muted-foreground">{draft.privacy.permittedCollectionFields.join(', ') || 'None'}</dd></div><div className="ak-review-resource"><dt className="font-medium">Availability</dt><dd className="mt-1 text-muted-foreground">{draft.availability.enabled ? `Weekly hours · ${draft.availability.timezone}` : '24/7'}</dd></div></dl></section>
        </div>
        <div className="ak-review-column">
          <section className="ak-review-card"><h3>Readiness</h3><ReadinessChecks readiness={readiness} /></section>
          {issues.length > 0 && <Callout tone="warning" role="alert"><h3 className="font-semibold text-foreground">Finish these assignments first</h3><ul className="mt-2 list-disc space-y-1 pl-5">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></Callout>}
          {conflicts.length > 0 && <label className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={reassign} disabled={busy} onChange={event => onReassign(event.target.checked)} /><span><span className="font-medium">Replace existing assistant assignments</span><span className="mt-2 block leading-6 text-muted-foreground">{conflicts.map(binding => { const account = catalog.accounts.find(item => assistantBindingKey(item) === assistantBindingKey(binding)); return `${assistantChannelLabels[binding.channel]} / ${account ? accountLabel(account) : `${binding.accountId} · ${binding.surface === 'public_comment' ? 'Public comments' : 'Private messages'}`}`; }).join(', ')} currently use another assistant. Publishing will cancel pending replies and follow-ups, expire incompatible approvals, and start a fresh playbook on the next turn. CRM history is preserved.</span></span></label>}
          <RuntimeNotice enabled={catalog.runtimeEnabled} /><ErrorNotice message={error} />
        </div>
      </div></div>
      <DialogFooter className="ak-publish-footer sm:justify-between"><Button variant="outline" disabled={busy} onClick={onClose}>Back to draft</Button><Button disabled={!readiness.ready || issues.length > 0 || busy || (conflicts.length > 0 && !reassign)} onClick={onPublish}>{publishing ? 'Publishing…' : 'Publish assistant'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
