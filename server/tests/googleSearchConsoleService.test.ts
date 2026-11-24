import { describe, expect, it } from '@jest/globals';
import {
  calculateGscOpportunities,
  matchGscProperty,
  normalizeGscRows,
  signGscOAuthState,
  verifyGscOAuthState,
} from '../services/aiVisibility/GoogleSearchConsoleService.js';

describe('Google Search Console integration contracts', () => {
  it('signs state that binds a user and project and rejects tampering or expiry', () => {
    const secret = 'unit-test-state-secret';
    const state = signGscOAuthState({ userId: 42, projectId: 7, nonce: 'nonce', ts: 1_000 }, secret);
    expect(verifyGscOAuthState(state, secret, 2_000)).toMatchObject({ userId: 42, projectId: 7, nonce: 'nonce' });
    expect(verifyGscOAuthState(`${state}tampered`, secret, 2_000)).toBeNull();
    expect(verifyGscOAuthState(state, secret, 1_000 + 10 * 60 * 1_000 + 1)).toBeNull();
  });

  it('prefers a matching domain property and never selects another hostname', () => {
    const properties = [
      { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' },
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
      { siteUrl: 'sc-domain:other.test', permissionLevel: 'siteOwner' },
    ];
    expect(matchGscProperty('https://example.com/pricing', properties)?.siteUrl).toBe('sc-domain:example.com');
    expect(matchGscProperty('https://missing.test', properties)).toBeNull();
  });

  it('normalizes only valid query/page measurements', () => {
    expect(normalizeGscRows([
      { keys: ['crm software', 'https://example.com/crm'], clicks: 12, impressions: 500, ctr: 0.024, position: 7.2 },
      { keys: ['invalid'], clicks: 1, impressions: 2, ctr: 2, position: 1 },
    ])).toEqual([{ query: 'crm software', page: 'https://example.com/crm', clicks: 12, impressions: 500, ctr: 0.024, position: 7.2 }]);
  });

  it('derives opportunities only from deterministic real-measurement thresholds', () => {
    const opportunities = calculateGscOpportunities([
      { query: 'crm software', page: 'https://example.com/crm', clicks: 12, impressions: 500, ctr: 0.024, position: 7.2 },
      { query: 'low volume', page: 'https://example.com/low', clicks: 0, impressions: 20, ctr: 0, position: 8 },
      { query: 'already strong', page: 'https://example.com/good', clicks: 80, impressions: 500, ctr: 0.16, position: 3 },
    ]);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({ query: 'crm software', priority: 'high', potentialClicks: 13 });
  });
});
