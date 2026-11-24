import { describe, expect, it } from '@jest/globals';
import type { BrandToolkitRecord } from '../models/brandToolkits/schema.js';
import { resolveReportBranding } from '../services/aiVisibility/ReportBrandingService.js';

function toolkit(overrides: Partial<BrandToolkitRecord>): BrandToolkitRecord {
  return { id: 7, name: 'Orbit Studio', tagline: 'Evidence before guesses', isActive: true, isApproved: true, primaryBrandColor: '#AABBCC', accentColor: '#112233', secondaryBrandColor: null, ...overrides } as BrandToolkitRecord;
}

describe('AI Visibility report branding', () => {
  it('snapshots approved linked toolkit identity and safe colors', () => {
    expect(resolveReportBranding(toolkit({}), 'Orbit')).toEqual({
      toolkitId: 7,
      displayName: 'Orbit Studio',
      tagline: 'Evidence before guesses',
      primaryColor: '#aabbcc',
      accentColor: '#112233',
    });
  });

  it('rejects inactive, unapproved, or malformed visual settings', () => {
    expect(resolveReportBranding(toolkit({ isApproved: false }), 'Orbit').toolkitId).toBeNull();
    expect(resolveReportBranding(toolkit({ primaryBrandColor: 'url(http://internal)', accentColor: '<style>' }), 'Orbit')).toEqual(expect.objectContaining({
      primaryColor: '#6d4aff',
      accentColor: '#172033',
    }));
  });

  it('applies validated organization and workspace defaults with workspace precedence', () => {
    expect(resolveReportBranding(
      toolkit({}),
      'Orbit',
      { displayName: 'Client Portal', primaryColor: '#ABCDEF' },
      { displayName: 'Agency Name', tagline: 'Agency report', primaryColor: '#010203', accentColor: '#334455' },
    )).toEqual({
      toolkitId: 7,
      displayName: 'Client Portal',
      tagline: 'Agency report',
      primaryColor: '#abcdef',
      accentColor: '#334455',
    });
    expect(resolveReportBranding(toolkit({}), 'Orbit', { primaryColor: 'url(http://invalid)' })).toEqual(expect.objectContaining({
      primaryColor: '#aabbcc',
    }));
  });
});
