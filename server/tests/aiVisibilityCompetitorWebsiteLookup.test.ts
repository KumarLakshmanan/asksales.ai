import { describe, expect, it } from '@jest/globals';
import { isOfficialCandidate, namesBusiness } from '../services/aiVisibility/CompetitorWebsiteLookupService.js';

describe('competitor website lookup checks', () => {
  it('never offers a listing, booking, review, social site or the brand itself as a website', () => {
    const brand = 'https://orocircle.com';
    expect(isOfficialCandidate('https://www.anantabliss.com/', brand)).toBe(true);
    expect(isOfficialCandidate('https://www.tripadvisor.in/Hotel_Review-g1', brand)).toBe(false);
    expect(isOfficialCandidate('https://www.makemytrip.com/hotels/x', brand)).toBe(false);
    expect(isOfficialCandidate('https://www.facebook.com/mulberryshades', brand)).toBe(false);
    expect(isOfficialCandidate('https://www.justdial.com/Bangalore/x', brand)).toBe(false);
    expect(isOfficialCandidate('https://orocircle.com/about', brand)).toBe(false);
    expect(isOfficialCandidate('ftp://example.com', brand)).toBe(false);
    expect(isOfficialCandidate('not a url', brand)).toBe(false);
  });

  it('checks that the page title or address names the business, ignoring generic words', () => {
    expect(namesBusiness('Mulberry Shades Bengaluru Nandi Hills', 'Mulberry Shades | Resort', 'mulberryshades.in')).toBe(true);
    expect(namesBusiness('Ananta Bliss', 'Private pool villas near Bangalore', 'www.anantabliss.com')).toBe(true);
    // "Resort" and "Bangalore" alone do not identify the business.
    expect(namesBusiness('Signature Club Resort', 'Best resort in Bangalore', 'bestresorts.example')).toBe(false);
  });
});
