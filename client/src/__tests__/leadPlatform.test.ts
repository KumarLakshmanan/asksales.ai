import { describe, expect, it } from 'vitest';
import { filterLeadsByPlatform, leadPlatformLabel, matchesLeadPlatform } from '../lib/lead-platform';

describe('lead platform drill-down', () => {
  const leads = [
    { id: 1, platformType: 'linkedin', leadType: 'profile' },
    { id: 2, source: 'linkedin', leadType: 'company' },
    { id: 3, platformType: 'facebook', leadType: 'profile' },
  ];
  it('uses the same channel matching for workflow variants and drill-down', () => {
    expect(filterLeadsByPlatform(leads, 'linkedin_company_details').map(lead => lead.id)).toEqual([1, 2]);
    expect(filterLeadsByPlatform(leads, 'linkedin_company_details', 'company').map(lead => lead.id)).toEqual([2]);
    expect(leadPlatformLabel('linkedin_company_details')).toBe('LinkedIn');
  });
  it('preserves compound Google Maps names and prevents partial-prefix matches', () => {
    expect(matchesLeadPlatform('google_maps', 'google_maps_b2b')).toBe(true);
    expect(leadPlatformLabel('google_maps_b2b')).toBe('Google Maps');
    expect(matchesLeadPlatform('linked', 'linkedin')).toBe(false);
    expect(matchesLeadPlatform('facebook', 'linkedin_company_details')).toBe(false);
  });
});
