import { describe, expect, it } from '@jest/globals';
import { projectSettingsChanged } from '../services/aiVisibility/projectSettings.js';

const stored = {
  country: 'IN',
  locale: 'en-IN',
  targetGeography: null,
  category: 'resort stays',
  brandAliases: ['Example'],
  geoPrompts: [{ id: 'a', prompt: 'Best resorts?', intent: 'discovery', isGeneric: true, active: true }],
};

describe('projectSettingsChanged', () => {
  it('treats an unchanged save as no change, whatever key order jsonb returns', () => {
    expect(
      projectSettingsChanged(stored, {
        country: 'IN',
        locale: 'en-IN',
        targetGeography: null,
        category: 'resort stays',
        brandAliases: ['Example'],
        geoPrompts: [{ active: true, isGeneric: true, intent: 'discovery', prompt: 'Best resorts?', id: 'a' }],
      }),
    ).toBe(false);
  });

  it('treats a missing stored value and null as the same', () => {
    expect(projectSettingsChanged({ ...stored, targetGeography: undefined }, { targetGeography: null })).toBe(false);
  });

  it('detects a real change', () => {
    expect(projectSettingsChanged(stored, { locale: 'ta-IN' })).toBe(true);
    expect(
      projectSettingsChanged(stored, {
        geoPrompts: [{ ...stored.geoPrompts[0], active: false }],
      }),
    ).toBe(true);
  });
});
