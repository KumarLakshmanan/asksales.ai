"use client";
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import type { WidgetProps } from './types';

type StopReview = { campaign: { campaignId: number; name: string; localStatus?: string; lastRecordedProviderStatus?: string }; platforms: Array<'meta' | 'google'> };

export function StopAdsWidget(props: WidgetProps) {
  if (!['active', 'draft'].includes(props.widget.status)) {
    const result = props.widget.executionResult as { output?: { message?: string; platforms?: Array<{ platform?: string; status?: string; actionId?: number; providerOutcome?: { status?: string; launchCancelled?: boolean; requiresReconciliation?: boolean }; error?: string }> } } | undefined;
    return <div className="min-w-0 space-y-3 text-sm">
      <p>{result?.output?.message || 'Stop processing is in progress. Provider pause is not yet confirmed.'}</p>
      {Array.isArray(result?.output?.platforms) ? result.output.platforms.map((receipt, index) => <div key={receipt.actionId ?? index} className="rounded-lg border p-3">
        <p className="font-medium">{receipt.platform === 'meta' ? 'Meta' : receipt.platform === 'google' ? 'Google' : 'Platform'} · Request #{receipt.actionId}</p>
        <p className="text-muted-foreground">{receipt.providerOutcome?.status === 'paused' && receipt.status === 'succeeded' ? 'Provider confirmed pause'
          : receipt.providerOutcome?.launchCancelled && !receipt.providerOutcome?.requiresReconciliation ? 'Launch cancelled before confirmed activation'
            : receipt.status === 'gated' ? 'Provider access is gated — pause is not confirmed'
              : `Request ${receipt.status || 'pending'} — check provider confirmation`}</p>
        {receipt.error ? <p className="text-destructive break-words">{receipt.error}</p> : null}
      </div>) : null}
    </div>;
  }
  return <StopReviewEditor key={`${props.widget.threadId}:${props.widget.id}`} {...props} />;
}

function StopReviewEditor({ widget, onFormChange }: WidgetProps) {
  const [review, setReview] = useState<StopReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setReview(null); setError(null);
    const target = { campaignId: widget.formValues.campaignId, platforms: widget.formValues.platforms };
    onFormChange({ ...target, _review_validation_error: 'Loading the saved stop target…' });
    void api.get<StopReview>(`/api/widgets/${widget.id}/stop-review`).then(value => {
      if (!current) return;
      if (!Number.isSafeInteger(value.campaign?.campaignId) || value.campaign.campaignId <= 0
        || value.campaign.campaignId !== Number(widget.formValues.campaignId)
        || typeof value.campaign.name !== 'string' || !Array.isArray(value.platforms)
        || value.platforms.length === 0 || value.platforms.some(platform => !['meta', 'google'].includes(platform))) {
        throw new Error('The saved stop target is invalid. Reload the conversation.');
      }
      setReview(value);
      onFormChange({ campaignId: value.campaign.campaignId, platforms: value.platforms });
    }).catch(reason => {
      if (!current) return;
      const message = reason instanceof Error ? reason.message : 'The stop review could not be loaded.';
      setError(message);
      onFormChange({ ...target, _review_validation_error: message });
    });
    return () => { current = false; };
    // The parent callback changes on each form update; it is not a reload trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id, attempt]);
  if (error) return <div role="alert" className="space-y-3 text-sm"><p>{error}</p><Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>Retry loading stop review</Button></div>;
  if (!review) return <p role="status" className="text-sm text-muted-foreground">Loading the saved campaign to stop…</p>;
  return <div className="min-w-0 space-y-3 text-sm">
    <div className="rounded-lg border p-3"><p className="font-semibold break-words">{review.campaign.name}</p><p className="text-xs text-muted-foreground">Campaign #{review.campaign.campaignId}</p><p className="mt-2">Stop on: {review.platforms.map(platform => platform === 'meta' ? 'Meta' : 'Google').join(' + ')}</p></div>
    <dl className="grid grid-cols-1 gap-3 rounded-lg border p-3 text-xs">
      <div><dt className="text-muted-foreground">Saved campaign status</dt><dd className="mt-1 break-words">{review.campaign.localStatus || 'Not recorded'}</dd></div>
      <div><dt className="text-muted-foreground">Last recorded provider status · not live verified</dt><dd className="mt-1 break-words">{review.campaign.lastRecordedProviderStatus || 'Not recorded'}</dd></div>
    </dl>
    <p>Confirmation cancels queued launches and requests a pause on only these platforms. It does not delete your campaign or creatives.</p>
    <Callout tone="warning" size="sm">Spend may continue until the provider confirms the pause. A queued or gated request is not confirmation that ads have stopped.</Callout>
  </div>;
}
