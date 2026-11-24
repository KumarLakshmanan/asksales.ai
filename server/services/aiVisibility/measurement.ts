/** Shared measurement semantics. A failed or running attempt never replaces a completed snapshot. */
export const COMPLETED_AUDIT_STATUSES = ['completed', 'completed_with_warnings'] as const;

export function latestCompletedAudit<
  T extends { status: string; createdAt: string | Date; id: number },
>(audits: T[]): T | undefined {
  return audits
    .filter((audit) =>
      COMPLETED_AUDIT_STATUSES.includes(audit.status as (typeof COMPLETED_AUDIT_STATUSES)[number]),
    )
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id,
    )[0];
}

export function normalizedHostname(value: string): string | null {
  try {
    return new URL(value).hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** Includes owned subdomains, never sibling/suffix-lookalike domains. */
export function isFirstPartyCitation(url: string, domain: string): boolean {
  const candidate = normalizedHostname(url);
  const owner = normalizedHostname(domain);
  return Boolean(candidate && owner && (candidate === owner || candidate.endsWith(`.${owner}`)));
}

export function providerCoverage(
  runs: Array<{
    provider: string;
    status: string;
    extractionStatus?: string;
    citations?: unknown[];
  }>,
) {
  const expected = runs.filter((run) => run.status !== 'excluded');
  const providers = [...new Set(expected.map((run) => run.provider))];
  const successful = runs.filter((run) => run.status === 'completed');
  return {
    attemptedProviders: providers.length,
    successfulProviders: new Set(successful.map((run) => run.provider)).size,
    expectedObservations: expected.length,
    excludedObservations: runs.length - expected.length,
    successfulObservations: successful.length,
    extractedObservations: successful.filter((run) =>
      ['completed', 'corrected', 'cached'].includes(run.extractionStatus || ''),
    ).length,
    citations: successful.reduce((sum, run) => sum + (run.citations?.length || 0), 0),
    partial:
      expected.length === 0 ||
      successful.length < expected.length ||
      successful.some(
        (run) => !['completed', 'corrected', 'cached'].includes(run.extractionStatus || ''),
      ),
  };
}

export function isProviderAvailabilityFailure(error: string): boolean {
  return /quota|billing|credential|api.?key|permission|unauthori|dunning|429|401|403|rate.limit|resource.exhausted|payment|model.*(not.?found|not.?available|unsupported)/i.test(
    error,
  );
}
