import { describe, expect, it } from '@jest/globals';
import {
  selectSharedBusinessDirectoryCredential,
  usesSharedBusinessDirectoryApifyPool,
} from '../models/adminApiCredentials/functions.js';

const credential = (id: number, assignedActors?: string[]) => ({
  id,
  platform: 'apify',
  apiKey: `key-${id}`,
  apiSecret: null,
  name: `Credential ${id}`,
  isActive: true,
  isEncrypted: false,
  priority: 'normal',
  config: assignedActors === undefined ? null : { assignedActors },
  deactivationReason: null,
  deactivatedAt: null,
  lastUsedAt: null,
  usageCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
} as any);

describe('shared business-directory Apify credentials', () => {
  it('uses the same unscoped pool for Google Maps and JustDial', () => {
    const credentials = [
      credential(10, ['compass/crawler-google-places']),
      credential(11),
    ];

    expect(usesSharedBusinessDirectoryApifyPool('compass/crawler-google-places')).toBe(true);
    expect(usesSharedBusinessDirectoryApifyPool('codingfrontend/justdial-business-lead-extractor')).toBe(true);
    expect(usesSharedBusinessDirectoryApifyPool('memo23/justdial-business-scraper')).toBe(true);
    expect(selectSharedBusinessDirectoryCredential('compass/crawler-google-places', credentials)?.id).toBe(11);
    expect(selectSharedBusinessDirectoryCredential('codingfrontend/justdial-business-lead-extractor', credentials)?.id).toBe(11);
    expect(selectSharedBusinessDirectoryCredential('memo23/justdial-business-scraper', credentials)?.id).toBe(11);
  });

  it('keeps fallback rotation inside the shared unscoped pool', () => {
    const credentials = [credential(11), credential(12), credential(13, ['some/other-actor'])];
    expect(selectSharedBusinessDirectoryCredential(
      'memo23/justdial-business-scraper',
      credentials,
      11,
    )?.id).toBe(12);
  });

  it('honors configured priority consistently across both providers', () => {
    const normal = credential(11);
    const high = { ...credential(12), priority: 'high' };
    const credentials = [normal, high];
    expect(selectSharedBusinessDirectoryCredential('compass/crawler-google-places', credentials)?.id).toBe(12);
    expect(selectSharedBusinessDirectoryCredential('codingfrontend/justdial-business-lead-extractor', credentials)?.id).toBe(12);
    expect(selectSharedBusinessDirectoryCredential('memo23/justdial-business-scraper', credentials)?.id).toBe(12);
  });
});
