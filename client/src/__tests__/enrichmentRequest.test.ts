import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enrichmentRequestKey, completeEnrichmentRequest } from '@/lib/enrichment-request';
import { selectBusinessProfile } from '@/lib/business-profile';

describe('enrichment request retry identity', () => {
  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.clear();
    selectBusinessProfile(4102);
  });
  it('reuses an uncertain request through a module reload, then permits a new accepted attempt', async () => {
    const input = { platform: 'twitter', identifier: `synthetic-${crypto.randomUUID()}` };
    const first = enrichmentRequestKey(input);
    expect(enrichmentRequestKey(input)).toBe(first);
    vi.resetModules();
    const fresh = await import('@/lib/enrichment-request');
    expect(fresh.enrichmentRequestKey(input)).toBe(first);
    fresh.completeEnrichmentRequest(input);
    expect(fresh.enrichmentRequestKey(input)).not.toBe(first);
  });
  it('does not reuse an attempt across actors, businesses, or changed inputs', () => {
    const input = { platform: 'website', identifier: `https://fixture.invalid/${crypto.randomUUID()}` };
    const first = enrichmentRequestKey(input);
    selectBusinessProfile(4103);
    expect(enrichmentRequestKey(input)).not.toBe(first);
    selectBusinessProfile(4102);
    localStorage.setItem('user', JSON.stringify({ id: 4104 }));
    expect(enrichmentRequestKey(input)).not.toBe(first);
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    expect(enrichmentRequestKey({ ...input, identifier: `${input.identifier}/changed` })).not.toBe(first);
    completeEnrichmentRequest(input);
  });
});
