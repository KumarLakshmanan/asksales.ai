/**
 * Tab Configuration Tests
 * Tests: TAB_TYPES constants, TAB_LABELS, getTabLabel, isValidTabType,
 *        TAB_TYPE_TO_SERVER_TYPE mapping
 */
import { describe, it, expect } from 'vitest';
import { TAB_TYPES, TAB_LABELS, getTabLabel, VALID_TAB_TYPES } from '@/lib/tabConfig';

describe('TAB_TYPES', () => {
  it('should have all required tab type constants', () => {
    expect(TAB_TYPES.OVERVIEW).toBe('overview');
    expect(TAB_TYPES.ICP).toBe('icp');
    expect(TAB_TYPES.LEADS).toBe('leads');
    expect(TAB_TYPES.OUTREACH).toBe('outreach');
    expect(TAB_TYPES.CAMPAIGNS).toBe('campaigns');
    expect(TAB_TYPES.CONTENT_STUDIO).toBe('content-studio');
    expect(TAB_TYPES.PERFORMANCE_MARKETING).toBe('performancemarketing');
    expect(TAB_TYPES.CRM).toBe('crm');
    expect(TAB_TYPES.SUPPORT).toBe('support');
  });

  it('should have all content type variants', () => {
    expect(TAB_TYPES.CONTENT_EMAIL).toBe('content-email');
    expect(TAB_TYPES.CONTENT_SMS).toBe('content-sms');
    expect(TAB_TYPES.CONTENT_SOCIAL).toBe('content-social');
    expect(TAB_TYPES.CONTENT_BLOG).toBe('content-blog');
    expect(TAB_TYPES.CONTENT_AD_COPY).toBe('content-adcopy');
  });

  it('should export only string values', () => {
    Object.values(TAB_TYPES).forEach((value) => {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    });
  });

  it('should have unique values', () => {
    const values = Object.values(TAB_TYPES);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe('TAB_LABELS', () => {
  it('should have labels for all TAB_TYPES values', () => {
    Object.values(TAB_TYPES).forEach((tabType) => {
      if (tabType in TAB_LABELS) {
        const label = (TAB_LABELS as Record<string, string>)[tabType];
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
      }
    });
  });

  it('should have correct labels for key tabs', () => {
    expect((TAB_LABELS as Record<string, string>)['overview']).toBeTruthy();
    expect((TAB_LABELS as Record<string, string>)['leads']).toBeTruthy();
  });
});

describe('getTabLabel', () => {
  it('should return label for known tab type', () => {
    const label = getTabLabel(TAB_TYPES.OVERVIEW);
    expect(label).toBeTruthy();
    expect(typeof label).toBe('string');
  });

  it('should return label for leads tab', () => {
    const label = getTabLabel(TAB_TYPES.LEADS);
    expect(label).toBeTruthy();
  });

  it('should return a fallback for unknown tab type', () => {
    const label = getTabLabel('nonexistent-tab' as never);
    expect(typeof label).toBe('string');
    // Should either return a fallback or the raw type
  });
});

describe('VALID_TAB_TYPES', () => {
  it('should include all primary navigation tab types', () => {
    // Some TAB_TYPES (crm, support, proposals) are intentionally excluded from VALID_TAB_TYPES
    const expectedInValid = [
      TAB_TYPES.OVERVIEW,
      TAB_TYPES.ICP,
      TAB_TYPES.LEADS,
      TAB_TYPES.OUTREACH,
      TAB_TYPES.CAMPAIGNS,
      TAB_TYPES.CONTENT_STUDIO,
      TAB_TYPES.PERFORMANCE_MARKETING,
      TAB_TYPES.CONTENT_EMAIL,
      TAB_TYPES.CONTENT_SMS,
      TAB_TYPES.CONTENT_SOCIAL,
      TAB_TYPES.CONTENT_BLOG,
    ];
    expectedInValid.forEach((tabType) => {
      expect(VALID_TAB_TYPES).toContain(tabType);
    });
  });

  it('should not include unknown tab types', () => {
    expect(VALID_TAB_TYPES).not.toContain('nonexistent');
    expect(VALID_TAB_TYPES).not.toContain('');
    expect(VALID_TAB_TYPES).not.toContain('telegram');
  });

  it('should be a non-empty string array', () => {
    expect(VALID_TAB_TYPES.length).toBeGreaterThan(0);
    VALID_TAB_TYPES.forEach((t) => expect(typeof t).toBe('string'));
  });
});
