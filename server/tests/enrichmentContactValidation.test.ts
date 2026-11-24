import { describe, it, expect } from '@jest/globals';
import { cleanEnrichmentContacts, cleanEnrichmentPhone, cleanEnrichmentRun } from '../../shared/enrichmentContactValidation.js';
import { extractEmailsFromText, extractPhonesFromText, normalizePhoneToE164 } from '../services/enrichment/textExtractors.js';

describe('enrichment contact candidates', () => {
  it('projects historical counts consistently without changing the saved audit record', () => {
    const run = { phonesFound: 77, emailsFound: 3, websitesFound: 7, summary: {
      phones: ['26.8345538', '+11038733556', '+911414700658'],
      emails: ['Hiring@celebaltech.com', 'hiring@celebaltech.com'],
      websites: ['http://www.celebaltech.com', 'https://celebaltech.com', 'https://lnkd.in/abc'],
      company: { name: 'Celebal Technologies', domain: 'linkedin.com' },
      person: { fullName: 'Manan Tholia' },
      socialProfiles: { linkedin: 'https://linkedin.com/company/celebaltech' },
      socialStats: { followersCount: 3327 },
    } };
    const cleaned = cleanEnrichmentRun(run);
    expect(cleaned).toMatchObject({ phonesFound: 1, emailsFound: 1, websitesFound: 1 });
    expect(cleaned.summary.company).toEqual({ name: 'Celebal Technologies' });
    expect(cleaned.summary).toMatchObject({ socialStats: {}, socialProfiles: {} });
    expect(cleanEnrichmentRun(cleaned)).toEqual(cleaned);
    expect(run.phonesFound).toBe(77);
    expect(run.summary.phones).toContain('26.8345538');
  });
  it.each(['26.8345538', '75.7789612', '17.436638', '121.012902', '-33.8556125', '+11038733556', '2026-09-07', '1788772709423'])('rejects coordinate/date artifacts: %s', value => {
    expect(cleanEnrichmentPhone(value)).toBeNull();
  });
  it('does not scrape coordinates from website maps as phone numbers', () => {
    expect(extractPhonesFromText('Coordinates: 26.8345538 75.7789612. Latitude: 17.436638; longitude: 78.373229')).toEqual([]);
  });
  it('retains real telephone candidates without inventing a country', () => {
    expect(normalizePhoneToE164('9216035407')).toBe('9216035407');
    expect(cleanEnrichmentPhone('+91 141 470 0658')).toBe('+911414700658');
    expect(cleanEnrichmentPhone('+1 (650) 253-0001')).toBe('+16502530001');
    expect(cleanEnrichmentPhone('650.253.0001')).toBe('650.253.0001');
  });
  it('extracts real contacts but not embedded map coordinates or tracking numbers', () => {
    expect(extractPhonesFromText('Map https://maps.google.com/?q=26.8345538,75.7789612 Phone: +91 141 470 0658')).toContain('+91 141 470 0658');
  });
  it('keeps genuine company/personal mailboxes and removes case duplicates/assets', () => {
    expect(extractEmailsFromText('Hiring@celebaltech.com hiring@celebaltech.com contact@gmail.com icon@2x.png'))
      .toEqual(['hiring@celebaltech.com', 'contact@gmail.com']);
  });
  it('cleans legacy arrays without mutating them or merging case-sensitive website paths', () => {
    const raw = { phones: ['26.8345538', '+11038733556', '+91 141 470 0658', '+911414700658', null], emails: ['Hiring@celebaltech.com', 'hiring@celebaltech.com', 'bad'], websites: ['http://www.celebaltech.com/', 'https://celebaltech.com/', 'javascript:alert(1)', 'https://site.test/A', 'https://site.test/a'] };
    expect(cleanEnrichmentContacts(raw)).toEqual({ phones: ['+911414700658'], emails: ['hiring@celebaltech.com'], websites: ['http://celebaltech.com/', 'https://site.test/A', 'https://site.test/a'] });
    expect(raw.phones).toContain('26.8345538');
  });
});
