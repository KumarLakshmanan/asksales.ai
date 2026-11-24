import { normalizeLeadContacts, socialProfileUrl } from '../services/lead-generation/LeadContactNormalization.js';

describe('provider contact normalization', () => {
  it('does not manufacture a Twitter account from an Instagram username', () => {
    const lead: Record<string, unknown> = { source: 'instagram_post_authors', twitterHandle: 'rioboutiquegoa', twitterUsername: 'rioboutiquegoa' };
    normalizeLeadContacts(lead, { username: 'rioboutiquegoa' });
    expect(lead.instagramHandle).toBe('rioboutiquegoa');
    expect(lead.twitterHandle).toBeNull();
    expect(lead.twitterUsername).toBeNull();
  });

  it('retains explicit cross-platform handles without guessing them', () => {
    const lead: Record<string, unknown> = { source: 'instagram' };
    normalizeLeadContacts(lead, { username: 'hotel', twitterHandle: 'hotel_updates' });
    expect(lead.twitterHandle).toBe('hotel_updates');
  });
  it('does not label Google Maps URLs as Facebook, including custom-mapped aliases', () => {
    const lead = { facebookUrl: 'https://maps.google.com/place/123', facebook: 'https://maps.google.com/place/123' };
    normalizeLeadContacts(lead, { url: 'https://maps.google.com/place/123' });
    expect(lead.facebookUrl).toBeNull();
    expect(lead.facebook).toBeNull();
  });

  it('preserves real social URLs and recovers a valid explicit URL after a bad mapping', () => {
    const lead = { facebookUrl: 'https://example.com', linkedinUrl: 'https://linkedin.com/in/person' };
    normalizeLeadContacts(lead, { facebookUrl: 'https://m.facebook.com/hotel' });
    expect(lead.facebookUrl).toBe('https://m.facebook.com/hotel');
    expect(lead.linkedinUrl).toBe('https://linkedin.com/in/person');
  });

  it.each(['https://facebook.com.evil.test/page', 'https://facebook.com@evil.test/page', 'javascript:alert(1)', 'not a url'])('rejects spoofed or unsafe social URL %s', value => {
    expect(socialProfileUrl(value, ['facebook.com'])).toBeNull();
  });

  it.each(['email_address', 'emailAddress', 'emails'])('recovers an available %s without claiming verification', field => {
    const lead: Record<string, unknown> = { email: null, emailStatus: 'unavailable' };
    normalizeLeadContacts(lead, { [field]: ['', 'invalid', 'contact@hotel.example'] });
    expect(lead.email).toBe('contact@hotel.example');
    expect(lead.emailStatus).toBe('unverified');
  });

  it('keeps absent and placeholder emails unavailable', () => {
    const lead: Record<string, unknown> = { email: 'fake@placeholder.lead', emailStatus: 'unverified' };
    normalizeLeadContacts(lead, {});
    expect(lead.email).toBeNull();
    expect(lead.emailStatus).toBe('unavailable');
  });
});
