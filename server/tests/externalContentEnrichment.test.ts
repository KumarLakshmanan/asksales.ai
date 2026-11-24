import { describe, expect, it } from '@jest/globals';
import {
  actorItemMatchesRequestedUrl,
  buildUnavailableExternalReply,
  canonicalizeExternalUrl,
  classifyExternalPlatform,
  extractExternalUrls,
  stableExternalPostId,
} from '../services/ExternalContentEnrichmentService.js';

describe('external support content URL handling', () => {
  it('extracts at most three unique public links and removes tracking parameters', () => {
    const links = extractExternalUrls([
      'See https://www.instagram.com/p/ABC123/?igsh=secret',
      'again https://instagram.com/p/ABC123/',
      'and https://twitter.com/acme/status/12345?s=20',
      'plus https://example.com/page?utm_source=dm',
      'ignored https://fourth.example/path',
    ].join(' '));
    expect(links).toHaveLength(3);
    expect(canonicalizeExternalUrl(links[0])).toBe('https://instagram.com/p/ABC123');
    expect(canonicalizeExternalUrl(links[1])).toBe('https://x.com/acme/status/12345');
    expect(canonicalizeExternalUrl(links[2])).toBe('https://example.com/page');
  });

  it.each([
    ['https://instagram.com/reel/Reel9', 'instagram', 'Reel9'],
    ['https://x.com/acme/status/987654', 'twitter', '987654'],
    ['https://facebook.com/acme/posts/pfbid0123', 'facebook', 'pfbid0123'],
    ['https://linkedin.com/posts/acme_activity-123456-demo', 'linkedin', '123456'],
    ['https://example.com/article', 'website', null],
  ])('classifies %s as %s', (url, platform, stableId) => {
    expect(classifyExternalPlatform(url)).toBe(platform);
    expect(stableExternalPostId(url)).toBe(stableId);
  });

  it('requires an exact canonical URL or stable post ID from actor output', () => {
    const requested = 'https://instagram.com/p/ABC123';
    expect(actorItemMatchesRequestedUrl({ url: 'https://www.instagram.com/p/ABC123/?igsh=x' }, requested, 'instagram')).toBe(true);
    expect(actorItemMatchesRequestedUrl({ shortCode: 'ABC123' }, requested, 'instagram')).toBe(true);
    expect(actorItemMatchesRequestedUrl({ shortCode: 'prefix-ABC123-suffix' }, requested, 'instagram')).toBe(false);
    expect(actorItemMatchesRequestedUrl({ url: 'https://instagram.com/p/OTHER' }, requested, 'instagram')).toBe(false);
    expect(actorItemMatchesRequestedUrl(
      { shareUrn: 'urn:li:activity:987654' },
      'https://linkedin.com/posts/acme_activity-987654-demo',
      'linkedin',
    )).toBe(true);
  });

  it('uses a PII-safe public fallback and requests details only in private channels', () => {
    expect(buildUnavailableExternalReply('whatsapp')).toContain('full name');
    expect(buildUnavailableExternalReply('email')).toContain('contact phone number');
    expect(buildUnavailableExternalReply('instagram_comment')).toContain('don’t share personal contact details publicly');
    expect(buildUnavailableExternalReply('instagram_comment')).not.toContain('full name');
  });
});
