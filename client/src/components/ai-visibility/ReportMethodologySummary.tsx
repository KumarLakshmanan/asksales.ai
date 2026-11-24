'use client';
import { Callout } from '@/components/ui/callout';
import { statusBadge } from './workspace-ui';
export function ReportMethodologySummary({
  methodology,
}: {
  methodology: NonNullable<import('@/lib/ai-visibility').AiVisibilityReport['methodology']> | null;
}) {
  if (!methodology || methodology.methodologyVersion !== 2 || !Array.isArray(methodology.pillars))
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        Detailed measurement coverage will appear after the next analysis. The existing PDF remains
        available above.
      </div>
    );
  return (
    <div className="space-y-4 border-t pt-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {methodology.pillars.map((pillar) => (
          <div key={pillar.key} className="rounded-lg bg-muted/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{pillar.label}</span>
              {statusBadge(pillar.status)}
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {pillar.status === 'scored' && pillar.score !== null
                ? Math.round(pillar.score)
                : pillar.status === 'not_applicable'
                  ? 'Not applicable'
                  : 'Unavailable'}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{pillar.reason}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border p-3">
          <div className="text-sm font-medium">Provider coverage</div>
          <p className="mt-1 text-sm text-muted-foreground">
            {methodology.coverage.successfulProviderAnswers} of{' '}
            {methodology.coverage.providerObservations} observations returned answers ·{' '}
            {methodology.coverage.extractedProviderAnswers} extracted ·{' '}
            {methodology.coverage.citations} citations
          </p>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-sm font-medium">Competitor measurement</div>
          <p className="mt-1 text-sm text-muted-foreground">{methodology.competitors.reason}</p>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-sm font-medium">Commerce measurement</div>
          <p className="mt-1 text-sm text-muted-foreground">{methodology.commerce.reason}</p>
        </div>
      </div>
      {methodology.providers.some((provider) => provider.failureReasons.length > 0) && (
        <Callout tone="warning" title="Provider warnings">
          <div className="space-y-1 text-xs text-muted-foreground">
            {methodology.providers.flatMap((provider) =>
              provider.failureReasons.map((reason) => (
                <div key={`${provider.provider}-${reason}`}>
                  <strong className="capitalize text-foreground">{provider.provider}:</strong>{' '}
                  {reason}
                </div>
              )),
            )}
          </div>
        </Callout>
      )}
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Scoring methodology and disclosures
        </summary>
        <div className="mt-3 space-y-3 text-xs text-muted-foreground">
          <p>
            Profile {methodology.scoring.profile} v{methodology.scoring.version}. Input fingerprint:{' '}
            <span className="break-all font-mono">{methodology.scoring.inputFingerprint}</span>
          </p>
          <div className="space-y-2">
            {methodology.pillars.map((pillar) => (
              <p key={pillar.key}>
                <strong className="text-foreground">{pillar.label}:</strong> {pillar.formula}
              </p>
            ))}
          </div>
          {methodology.disclosures.map((disclosure) => (
            <p key={disclosure}>{disclosure}</p>
          ))}
        </div>
      </details>
    </div>
  );
}
