import { describe, expect, it } from '@jest/globals';
import { parsePlatformControlsInput, parseUserModuleAccessInput } from '../utils/platformAccessValidation.js';
import { PLATFORM_MODULES, resolveModuleEnabled } from '../utils/platformModules.js';

describe('platform access controls', () => {
  it('normalizes maintenance and module messages', () => {
    expect(parsePlatformControlsInput({
      maintenance: { enabled: true, message: '  Planned database maintenance  ' },
      modules: [{ key: 'crm', status: 'maintenance', message: '  Back soon  ' }],
    })).toEqual({
      maintenance: { enabled: true, message: 'Planned database maintenance' },
      modules: [{ key: 'crm', status: 'maintenance', message: 'Back soon' }],
    });
  });

  it('requires a customer-facing message when maintenance is enabled', () => {
    expect(() => parsePlatformControlsInput({ maintenance: { enabled: true, message: ' ' } }))
      .toThrow('maintenance.message is required');
  });

  it('rejects unknown, duplicate, and malformed module controls', () => {
    expect(() => parsePlatformControlsInput({ modules: [{ key: 'unknown', status: 'available' }] }))
      .toThrow('Unknown module key');
    expect(() => parsePlatformControlsInput({ modules: [
      { key: 'crm', status: 'available' },
      { key: 'crm', status: 'disabled' },
    ] })).toThrow('Duplicate module key');
    expect(() => parsePlatformControlsInput({ modules: [{ key: 'crm', status: 'hidden' }] }))
      .toThrow('Invalid status');
  });

  it('requires a complete, unique account-access replacement', () => {
    const modules = PLATFORM_MODULES.map((module) => ({ key: module.key, mode: 'inherit' as const }));
    expect(parseUserModuleAccessInput({ modules })).toHaveLength(PLATFORM_MODULES.length);
    expect(() => parseUserModuleAccessInput({ modules: modules.slice(1) })).toThrow('all');
    expect(() => parseUserModuleAccessInput({ modules: modules.map((module, index) =>
      index === 1 ? { ...module, key: modules[0].key } : module) })).toThrow('Duplicate');
  });

  it('never lets an account override bypass global maintenance or disablement', () => {
    expect(resolveModuleEnabled('available', 'inherit')).toBe(true);
    expect(resolveModuleEnabled('available', 'enabled')).toBe(true);
    expect(resolveModuleEnabled('available', 'disabled')).toBe(false);
    expect(resolveModuleEnabled('maintenance', 'enabled')).toBe(false);
    expect(resolveModuleEnabled('disabled', 'enabled')).toBe(false);
  });
});
