import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { renderEmailDesign, type EmailDesignPreferences } from '../../shared/emailDesigns.js';
let stored: EmailDesignPreferences | undefined;
let savedPatch: Record<string, unknown> | undefined;
const filters: unknown[] = [];
const select = jest.fn((fields?: unknown) => ({ from: () => ({ where: (where: unknown) => {
  filters.push(where);
  return fields ? Promise.resolve(stored ? [{ preferences: stored }] : []) : { for: () => Promise.resolve([{ emailDesignPreferences: stored }]) };
} }) }));
const database = {
  select,
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
  update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { savedPatch = patch; stored = patch.emailDesignPreferences as EmailDesignPreferences; } }) }),
  transaction: async (callback: (tx: unknown) => unknown): Promise<unknown> => callback(database),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: database }));
jest.unstable_mockModule('../utils/emailTemplates.js', () => ({
  getBrandInfo: async () => ({ companyName: 'ORO', logoUrl: '/uploads/oro.png', primaryColor: '#2563eb' }),
  renderBrandedEmail: renderEmailDesign,
}));
const { getEmailDesignPreferences, saveEmailDesignPreferences, prepareDesignedEmail } = await import('../services/EmailDesignService.js');
const scoped = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 7 }, work);
beforeEach(() => { stored = undefined; savedPatch = undefined; filters.length = 0; select.mockClear(); });
describe('business email design defaults', () => {
  it('uses classic defaults for an existing business without configured designs', async () => {
    expect(await scoped(() => getEmailDesignPreferences(9))).toEqual({ outreach: 'classic', assistant: 'classic', revision: 'initial' });
    const query = new PgDialect().sqlToQuery(filters[0] as any);
    expect(query.params).toEqual([9, 7]);
  });
  it('patches presentation only and preserves different assistant and outreach choices', async () => {
    const result = await scoped(() => saveEmailDesignPreferences(9, { outreach: 'editorial', assistant: 'hospitality', revision: 'initial' }));
    expect(result).toMatchObject({ outreach: 'editorial', assistant: 'hospitality' });
    expect(result?.revision).not.toBe('initial');
    expect(Object.keys(savedPatch!)).toEqual(['emailDesignPreferences', 'updatedAt']);
  });
  it('rejects a stale save without overwriting another session’s choices', async () => {
    stored = { outreach: 'letter', assistant: 'compact', revision: 'newer' };
    expect(await scoped(() => saveEmailDesignPreferences(9, { outreach: 'editorial', assistant: 'hospitality', revision: 'initial' }))).toBeNull();
    expect(savedPatch).toBeUndefined();
    expect(stored.assistant).toBe('compact');
  });
  it('never loads or saves another owner’s designs in the current business', async () => {
    await expect(scoped(() => getEmailDesignPreferences(10))).rejects.toThrow('scope');
    await expect(scoped(() => saveEmailDesignPreferences(10, { outreach: 'classic', assistant: 'classic', revision: 'initial' }))).rejects.toThrow('Invalid');
    expect(select).not.toHaveBeenCalled();
  });
  it('uses the correct default for each channel purpose, and allows a specific outreach override', async () => {
    stored = { outreach: 'editorial', assistant: 'hospitality', revision: 'current' };
    expect(await scoped(() => prepareDesignedEmail(9, '<p>Hello</p>', 'assistant'))).toContain('data-email-design="hospitality"');
    expect(await scoped(() => prepareDesignedEmail(9, '<p>Hello</p>', 'outreach'))).toContain('data-email-design="editorial"');
    expect(await scoped(() => prepareDesignedEmail(9, '<p>Hello</p>', 'outreach', 'compact'))).toContain('data-email-design="compact"');
  });
  it('preserves existing full-document templates unless a new design is explicitly selected', async () => {
    const original = '<!DOCTYPE html><html><body><p>Approved design</p></body></html>';
    expect(await scoped(() => prepareDesignedEmail(9, original, 'outreach'))).toBe(original);
    const html = await scoped(() => prepareDesignedEmail(9, original, 'outreach', 'compact'));
    expect(html).toContain('<p>Approved design</p>');
    expect(html.match(/<!DOCTYPE/g)).toHaveLength(1);
  });
});
