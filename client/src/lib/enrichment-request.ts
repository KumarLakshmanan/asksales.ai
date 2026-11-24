import { selectedBusinessProfileId } from './business-profile';

export interface EnrichmentRequest { platform: string; identifier: string; }
const memory = new Map<string, string>();
function storageKey(input: EnrichmentRequest): string {
  let actor = 'unknown';
  try { actor = String(JSON.parse(localStorage.getItem('user') || 'null')?.id || 'unknown'); } catch { /* Tab storage may be unavailable. */ }
  return `enrichment-request:${actor}:${selectedBusinessProfileId()}:${JSON.stringify(input)}`;
}

/** Keep the same request identity after a network failure and tab reload. */
export function enrichmentRequestKey(input: EnrichmentRequest): string {
  const key = storageKey(input);
  let existing = memory.get(key);
  try { existing = sessionStorage.getItem(key) || existing; } catch { /* Keep an in-memory attempt for this tab. */ }
  if (existing) return existing;
  const requestKey = crypto.randomUUID();
  memory.set(key, requestKey);
  try { sessionStorage.setItem(key, requestKey); } catch { /* Keep an in-memory attempt for this tab. */ }
  return requestKey;
}

export function completeEnrichmentRequest(input: EnrichmentRequest) {
  const key = storageKey(input);
  memory.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* No persisted attempt to remove. */ }
}
