import { plainLeadSearchError } from './leadSearchFailureMessage.js';
import { LEAD_PROVIDER_UNAVAILABLE_MESSAGE } from './apifyCredentialResolver.js';
import { sanitizeErrorFields } from '../../shared/userFacingError.js';

const FAILED = new Set(['failed', 'error']);

interface ScrapingRow {
  platform: string;
  status?: string | null;
  error?: string | null;
}

export type PresentedScrapingRow<T extends ScrapingRow> = T & {
  /** False when Retry would fail the same way, e.g. no lead data provider. */
  retryAvailable?: boolean;
};

/**
 * The Leads tab shows these rows as they are. Older rows still hold the raw
 * provider error (workflow step, data provider and key names), so the reason
 * is rewritten in plain words when it is read, not only when it is saved.
 */
export async function presentScrapingDetails<T extends ScrapingRow>(
  rows: T[],
  providerUnavailable: (platforms: string[]) => Promise<boolean>,
): Promise<Array<PresentedScrapingRow<T>>> {
  const failed = rows.filter(row => FAILED.has(String(row.status || '').toLowerCase()));
  const noProvider = failed.length > 0 && await providerUnavailable(failed.map(row => row.platform));
  return rows.map((row) => {
    // Only the error text changes; rebuilding the row would turn its Date fields into {}.
    if (!FAILED.has(String(row.status || '').toLowerCase())) return row.error ? { ...row, error: sanitizeErrorFields({ error: row.error }).error } : row;
    const error = noProvider
      ? LEAD_PROVIDER_UNAVAILABLE_MESSAGE
      : plainLeadSearchError(row.error);
    return { ...row, error, retryAvailable: !noProvider };
  });
}
