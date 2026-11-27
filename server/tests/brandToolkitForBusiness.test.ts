import { describe, expect, it } from '@jest/globals';
import { toolkitForBusiness } from '../services/content/ContentBrandContextService.js';

const toolkit = (name: string, extra: Partial<{ website: string | null; isDefault: boolean; isApproved: boolean; isActive: boolean }> = {}) => ({
  name, website: null, isDefault: false, isApproved: true, isActive: true, ...extra,
});

describe('brand toolkit used when the conversation has not chosen one', () => {
  const business = { name: 'aimplify ai', businessName: 'aimplify ai', companyName: 'aimplify ai', website: 'https://aimplifylabs.com' };

  it("uses the business's own toolkit instead of an account default made for another brand", () => {
    const todle = toolkit('Todle AI', { isDefault: true });
    const aimplify = toolkit('Aimplify Tech', { website: 'https://aimplifylabs.com/' });
    expect(toolkitForBusiness([todle, aimplify], business)).toEqual({ toolkit: aimplify, matched: true });
  });

  it('matches on the distinctive brand name when websites are missing', () => {
    const aimplify = toolkit('Aimplify Tech');
    expect(toolkitForBusiness([toolkit('Todle AI', { isDefault: true }), aimplify], { name: 'aimplify ai' }).toolkit).toBe(aimplify);
  });

  it('keeps the default when it matches, nothing matches, or the match is ambiguous or unapproved', () => {
    const fallback = toolkit('Aimplify Main', { isDefault: true });
    expect(toolkitForBusiness([fallback, toolkit('Aimplify Tech')], business)).toEqual({ toolkit: fallback, matched: false });
    const other = toolkit('Todle AI', { isDefault: true });
    expect(toolkitForBusiness([other, toolkit('Acme Labs')], business).toolkit).toBe(other);
    expect(toolkitForBusiness([other, toolkit('Aimplify Tech'), toolkit('Aimplify Studio')], business).toolkit).toBe(other);
    expect(toolkitForBusiness([other, toolkit('Aimplify Tech', { isApproved: false })], business).toolkit).toBe(other);
    expect(toolkitForBusiness([other, toolkit('Aimplify Tech', { isActive: false })], business).toolkit).toBe(other);
  });

  it('ignores generic words such as "AI" or "Tech" when comparing names', () => {
    const other = toolkit('Todle AI', { isDefault: true });
    expect(toolkitForBusiness([other, toolkit('Nimbus AI Tech')], { name: 'Orbit AI Tech' }).toolkit).toBe(other);
  });
});
