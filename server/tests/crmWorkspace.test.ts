import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration.js';
import { crmBulkContactSchema, crmContactsQuerySchema, crmCsvCell, crmDateBounds, crmHistoryQuerySchema,
  crmReportQuerySchema, crmReportPlatforms, crmWorkQuerySchema } from '../utils/crmWorkspaceValidation.js';
import { crmContactSchema, crmReminderSchema } from '../middleware/schemas.js';

describe('CRM workspace request boundaries', () => {
  it('validates real calendar dates, inclusive end dates and exclusive upper query bounds', () => {
    expect(crmReportQuerySchema.safeParse({ dateRange: 'custom',dateStart: '2026-02-30',dateEnd: '2026-03-01' }).success).toBe(false);
    expect(crmReportQuerySchema.safeParse({ from: '2026-10-04',to: '2026-10-03' }).success).toBe(false);
    expect(crmReportQuerySchema.safeParse({ from: '0000-01-01',to: '2026-10-03' }).success).toBe(false);
    const bounds = crmDateBounds(DEFAULT_CRM_CONFIGURATION.preferences,{ dateRange: 'custom',from: '2026-10-01',to: '2026-10-03' });
    expect(bounds.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(bounds.to?.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(() => crmDateBounds(DEFAULT_CRM_CONFIGURATION.preferences,{ dateRange: 'custom' })).toThrow('Choose both dates');
  });
  it('bounds pagination and avoids false truthiness for unread filters', () => {
    expect(crmHistoryQuerySchema.parse({ unread: 'false',page: '2',limit: '10' })).toMatchObject({ unread: false,page: 2,limit: 10 });
    for (const query of [{ page: '1.5' },{ page: '-2' },{ limit: '100000' },{ unread: 'yes' }]) expect(crmHistoryQuerySchema.safeParse(query).success).toBe(false);
    expect(crmContactsQuerySchema.parse({ assignedTo: 'unassigned',sortBy: 'priority',sortOrder: 'asc',platforms: 'email,whatsapp' }))
      .toMatchObject({ assignedTo: 'unassigned',platforms: ['email','whatsapp'] });
    expect(crmContactsQuerySchema.safeParse({ sortBy: 'email; DROP TABLE crm_contacts' }).success).toBe(false);
    expect(crmWorkQuerySchema.safeParse({ ownerUserId: '0' }).success).toBe(false);
  });
  it('accepts exact Gmail report/contact scopes without converting them to Email or all platforms', () => {
    for (const schema of [crmReportQuerySchema, crmContactsQuerySchema]) {
      expect(schema.parse({ platforms: 'gmail', dateRange: '30d' }).platforms).toEqual(['gmail']);
      expect(schema.parse({ platforms: 'email', dateRange: '30d' }).platforms).toEqual(['email']);
      expect(schema.safeParse({ platforms: 'gmail,all' }).success).toBe(false);
      expect(schema.safeParse({ platforms: 'unrecognized' }).success).toBe(false);
    }
    expect(crmReportPlatforms(DEFAULT_CRM_CONFIGURATION, { platforms: ['gmail'] })).toEqual(['gmail']);
    expect(crmReportPlatforms(DEFAULT_CRM_CONFIGURATION, { platforms: ['gmail', 'email'] })).toEqual(['gmail', 'email']);
  });
  it('rejects unbounded, duplicated and empty bulk requests while supporting virtual references', () => {
    expect(crmBulkContactSchema.parse({ contactIds: [-11,22],assignedTo: null })).toMatchObject({ contactIds: [-11,22],assignedTo: null });
    for (const body of [{ contactIds: [] },{ contactIds: [1,1],addTags: ['VIP'] },{ contactIds: [0],assignedTo: null },
      { contactIds: Array.from({ length: 101 },(_,index)=>index+1),assignedTo: null },{ contactIds: [1] }])
      expect(crmBulkContactSchema.safeParse(body).success).toBe(false);
  });
  it('accepts atomic edit versions, configured stage keys and reminder ownership', () => {
    expect(crmContactSchema.partial().safeParse({ pipelineStatus: 'qualified',assignedTo: 29,tags: ['VIP'],currency: 'INR',expectedUpdatedAt: '2026-10-03T10:00:00Z' }).success).toBe(true);
    expect(crmContactSchema.partial().safeParse({ currency: 'Rupees' }).success).toBe(false);
    expect(crmReminderSchema.partial().safeParse({ assignedTo: null,snoozedUntil: '2030-10-03T10:00:00Z' }).success).toBe(true);
  });
  it('protects every exported cell against spreadsheet formulas and quotes delimiters/newlines', () => {
    for (const value of ['=HYPERLINK("https://example.test")',' +1+1','\t@SUM(1)','-2+3']) expect(crmCsvCell(value)).toMatch(/^"'/);
    expect(crmCsvCell('Normal, "quoted"\nname')).toBe('"Normal, ""quoted""\nname"');
    expect(crmCsvCell(null)).toBe('""');
  });
});
