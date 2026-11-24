export interface ProviderDatasetPartition<T> {
  validResults: T[];
  rejectedResults: T[];
  emptyResults: T[];
}

export type ProviderDatasetStatus = 'succeeded' | 'succeeded_empty' | 'partial_success' | 'failed';

const TERMINAL_PROVIDER_RECEIPT_STATUSES = new Set([
  'succeeded',
  'succeeded_empty',
  'partial_success',
  'failed',
  'cancelled',
]);

export function isTerminalProviderReceiptStatus(status: string): boolean {
  return TERMINAL_PROVIDER_RECEIPT_STATUSES.has(status);
}

export function classifyProviderDatasetOutcome(
  validCount: number,
  rejectedCount: number,
): ProviderDatasetStatus {
  if (rejectedCount > 0) return validCount > 0 ? 'partial_success' : 'failed';
  return validCount > 0 ? 'succeeded' : 'succeeded_empty';
}

/** An unreadable listing is not evidence that the reviewed search had no matches. */
export function diagnoseEmptyProviderRun(actorId: string, log: unknown): string | null {
  if (typeof log !== 'string') return null;
  if (/free user (?:call|run) limit (?:reached|exceeded)|upgrade to a paying user to use this actor/i.test(log)) {
    return 'The Apify actor plan limit prevented execution. No matches could be verified and no leads were saved.';
  }
  if (actorId === 'memo23/justdial-business-scraper' && /\[LISTING\][^\n]*no listData/i.test(log)) {
    return 'JustDial could not read listing data and skipped the listing page. No matches could be verified. Review the category URL and retry; no leads were saved.';
  }
  if (actorId === 'harvestapi/linkedin-profile-posts' && /Error scraping[^\n]*No valid target provided/i.test(log)) {
    return 'LinkedIn posts could not be retrieved because the provider rejected the profile URL. Use a public profile URL from Full profile mode; an opaque Short-mode profile identifier is not a valid posts target.';
  }
  return null;
}

/** Quality-filter exclusions are not provider failures or failed database writes. */
export function classifyReviewedProviderOutcome(metrics: {
  persisted: number;
  duplicates: number;
  rejected: number;
  providerErrors?: number;
  persistenceErrors?: number;
}): ProviderDatasetStatus {
  return classifyProviderDatasetOutcome(
    metrics.persisted + metrics.duplicates,
    (metrics.providerErrors || 0) + (metrics.persistenceErrors || 0),
  );
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/**
 * Apify actors sometimes finish successfully while returning dataset rows that
 * describe provider/request failures. Those rows are receipts, not leads.
 */
export function isProviderDatasetErrorResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const row = value as Record<string, unknown>;
  return hasMeaningfulValue(row.error)
    || hasMeaningfulValue(row.errorDescription)
    || hasMeaningfulValue(row.errorMessage)
    || hasMeaningfulValue(row.errorCode)
    || hasMeaningfulValue(row.requestErrorMessages);
}

/**
 * Some successful actors emit a diagnostic dataset row when the query has no
 * public results. These rows are neither leads nor provider failures and must
 * reconcile exactly like an empty dataset.
 */
export function isProviderDatasetEmptyResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const row = value as Record<string, unknown>;
  const errorCode = typeof row.error === 'string' ? row.error.trim().toLowerCase() : '';
  return errorCode === 'no_items';
}

export function partitionProviderDatasetResults<T>(results: T[]): ProviderDatasetPartition<T> {
  const validResults: T[] = [];
  const rejectedResults: T[] = [];
  const emptyResults: T[] = [];

  for (const result of results) {
    if (isProviderDatasetEmptyResult(result)) {
      emptyResults.push(result);
    } else if (isProviderDatasetErrorResult(result)) {
      rejectedResults.push(result);
    } else {
      validResults.push(result);
    }
  }

  return { validResults, rejectedResults, emptyResults };
}
