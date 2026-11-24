import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { crmConfigurationSchema } from '../utils/crmConfigurationValidation.js';

const execute = jest.fn<(query: SQL) => Promise<{ rows: Record<string, unknown>[] }>>();
const database = { execute, transaction: (work: (tx: { execute: typeof execute }) => Promise<CrmConfiguration>) => work({ execute }) };
jest.unstable_mockModule('../models/db.js', () => ({ db: database }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { getCrmConfiguration, saveCrmConfiguration } = await import('../services/CRMConfigurationService.js');
const { getConfiguration, updateConfiguration } = await import('../controllers/crmConfigurationController.js');
const dialect = new PgDialect();
const scope = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 42 }, work);
const fixture = () => structuredClone(DEFAULT_CRM_CONFIGURATION);

function response() {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => { jest.resetAllMocks(); execute.mockResolvedValue({ rows: [{ crm_configuration: fixture() }] }); });

describe('CRM configuration request boundary and persistence', () => {
  it('returns defaults for a profile without a saved configuration, scoped to its owner and profile', async () => {
    execute.mockResolvedValueOnce({ rows: [{ crm_configuration: null }] });
    const result = await scope(() => getCrmConfiguration(9));
    expect(result).toMatchObject({ ...DEFAULT_CRM_CONFIGURATION });
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(result).not.toBe(DEFAULT_CRM_CONFIGURATION);
    expect(dialect.sqlToQuery(execute.mock.calls[0][0]).params).toEqual([42, 9]);
  });

  it('locks and updates only the selected profile and leaves all other profile settings alone', async () => {
    const configuration = fixture();
    configuration.stages.push({ key: 'qualified', label: 'Qualified', color: '#ec4899', type: 'active', inFlow: true });
    configuration.preferences.topFlows = 8;
    const result = await scope(() => saveCrmConfiguration(9, configuration));
    expect(result).toMatchObject({ ...configuration });
    const lock = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(lock.sql).toContain('FOR UPDATE');
    const write = dialect.sqlToQuery(execute.mock.calls[1][0]);
    expect(write.sql).toMatch(/UPDATE company_settings SET crm_configuration/);
    expect(write.params).toEqual([JSON.stringify(configuration), 42, 9]);
    expect(write.sql).not.toContain('company_name =');
  });

  it('rejects an account mismatch before accessing the database', async () => {
    await expect(scope(() => getCrmConfiguration(19))).rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads a legacy single-platform preference as a checkbox selection without changing saved data', async () => {
    const legacy = fixture();
    legacy.preferences.platform = 'whatsapp';
    execute.mockResolvedValueOnce({ rows: [{ crm_configuration: legacy }] });
    const result = await scope(() => getCrmConfiguration(9));
    expect(result.preferences.platform).toEqual(['whatsapp']);
    expect(legacy.preferences.platform).toBe('whatsapp');
  });

  it('accepts and persists multiple platforms and normalizes original API payloads', async () => {
    const configuration = fixture();
    configuration.preferences.platform = ['email', 'whatsapp'];
    const parsed = crmConfigurationSchema.parse(configuration);
    await expect(scope(() => saveCrmConfiguration(9, parsed))).resolves.toMatchObject({ ...configuration });
    expect(dialect.sqlToQuery(execute.mock.calls[1][0]).params[0]).toBe(JSON.stringify(configuration));
    configuration.preferences.platform = 'email';
    expect(crmConfigurationSchema.parse(configuration).preferences.platform).toEqual(['email']);
  });

  it('persists an inclusive custom date range and validates calendar dates', async () => {
    const configuration = fixture();
    configuration.preferences = { ...configuration.preferences, dateRange: 'custom', dateStart: '2026-09-01', dateEnd: '2026-09-30' };
    const parsed = crmConfigurationSchema.parse(configuration);
    const result = await scope(() => saveCrmConfiguration(9, parsed));
    expect(result.preferences).toEqual(configuration.preferences);
    expect(crmConfigurationSchema.safeParse({ ...configuration, preferences: { ...configuration.preferences, dateStart: '2026-02-30' } }).success).toBe(false);
    expect(crmConfigurationSchema.safeParse({ ...configuration, preferences: { ...configuration.preferences, dateStart: '0000-01-01' } }).success).toBe(false);
    expect(crmConfigurationSchema.safeParse({ ...configuration, preferences: { ...configuration.preferences, dateEnd: '2026-08-30' } }).success).toBe(false);
    expect(crmConfigurationSchema.safeParse({ ...configuration, preferences: { ...configuration.preferences, dateStart: undefined } }).success).toBe(false);
  });

  it('rejects a stale editor revision while holding the profile lock', async () => {
    const loaded = await scope(() => getCrmConfiguration(9));
    const concurrent = fixture();
    concurrent.preferences.topFlows = 12;
    execute.mockResolvedValueOnce({ rows: [{ crm_configuration: concurrent }] });
    loaded.preferences.topFlows = 8;
    await expect(scope(() => saveCrmConfiguration(9, loaded))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed while you were editing') });
    expect(execute.mock.calls.some(([query]) => dialect.sqlToQuery(query).sql.includes('UPDATE company_settings'))).toBe(false);
  });

  it('keeps the revision stable when PostgreSQL reorders JSON object keys', async () => {
    const loaded = await scope(() => getCrmConfiguration(9));
    const source = fixture();
    const reordered = { preferences: Object.fromEntries(Object.entries(source.preferences).reverse()), stages: source.stages.map(stage => Object.fromEntries(Object.entries(stage).reverse())) };
    execute.mockResolvedValueOnce({ rows: [{ crm_configuration: reordered }] });
    const reread = await scope(() => getCrmConfiguration(9));
    expect(reread.revision).toBe(loaded.revision);
  });

  it('rejects deleting a stage referenced by a contact and does not persist the deletion', async () => {
    const configuration = fixture();
    configuration.stages = configuration.stages.filter(stage => stage.key !== 'contacted');
    execute.mockResolvedValueOnce({ rows: [{ crm_configuration: fixture() }] })
      .mockResolvedValueOnce({ rows: [{ key: 'contacted' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(scope(() => saveCrmConfiguration(9, configuration))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Ongoing') });
    expect(execute.mock.calls.some(([query]) => dialect.sqlToQuery(query).sql.includes('UPDATE company_settings'))).toBe(false);
  });

  it('protects stages used by nested automation or alert conditions, including paused rules', async () => {
    const configuration = fixture();
    configuration.stages = configuration.stages.filter(stage => stage.key !== 'won');
    execute.mockResolvedValueOnce({ rows: [{ crm_configuration: fixture() }] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ config: { match: [{ destination: 'won' }] } }] });
    await expect(scope(() => saveCrmConfiguration(9, configuration))).rejects.toMatchObject({ status: 409 });
    expect(execute.mock.calls.some(([query]) => dialect.sqlToQuery(query).sql.includes('UPDATE company_settings'))).toBe(false);
  });

  it('allows removal of unused stages', async () => {
    const configuration = fixture();
    configuration.stages = configuration.stages.filter(stage => stage.key !== 'demo');
    execute.mockResolvedValueOnce({ rows: [{ crm_configuration: fixture() }] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(scope(() => saveCrmConfiguration(9, configuration))).resolves.toMatchObject({ ...configuration });
    expect(execute.mock.calls.some(([query]) => dialect.sqlToQuery(query).sql.includes('UPDATE company_settings'))).toBe(true);
  });

  it('requires authentication and rejects invalid payloads before persistence', async () => {
    const unauthorized = response();
    await getConfiguration({ user: undefined } as Request, unauthorized as unknown as Response);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    const invalid = response();
    await scope(() => updateConfiguration({ user: { id: 9 }, body: { ...fixture(), userId: 19 } } as Request, invalid as unknown as Response));
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let a shared-business member change the owner used for persistence', async () => {
    const res = response();
    await withBusinessScope({ userId: 9, actorUserId: 15, businessProfileId: 42 }, () =>
      updateConfiguration({ user: { id: 15 }, body: fixture() } as Request, res as unknown as Response));
    const write = dialect.sqlToQuery(execute.mock.calls[1][0]);
    expect(write.params.slice(-2)).toEqual([42, 9]);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ ...fixture() }) });
  });

  it.each([
    (configuration: CrmConfiguration) => { configuration.stages.shift(); },
    (configuration: CrmConfiguration) => { configuration.stages[1].type = 'entry'; },
    (configuration: CrmConfiguration) => { configuration.stages[1].label = ' won '; },
    (configuration: CrmConfiguration) => { configuration.stages[1].color = 'url(javascript:alert(1))'; },
    (configuration: CrmConfiguration) => { configuration.stages.forEach(stage => { stage.inFlow = false; }); },
    (configuration: CrmConfiguration) => { configuration.preferences.stuckThreshold = 0; },
    (configuration: CrmConfiguration) => { configuration.preferences.topFlows = 2.5; },
    (configuration: CrmConfiguration) => { configuration.preferences.minFlowCount = 1001; },
    (configuration: CrmConfiguration) => { configuration.preferences.platform = []; },
    (configuration: CrmConfiguration) => { configuration.preferences.platform = ['email', 'email']; },
    (configuration: CrmConfiguration) => { configuration.preferences.platform = ['all', 'email']; },
  ])('rejects an invalid stage or preference configuration', mutate => {
    const configuration = fixture();
    mutate(configuration);
    expect(crmConfigurationSchema.safeParse(configuration).success).toBe(false);
  });
});
