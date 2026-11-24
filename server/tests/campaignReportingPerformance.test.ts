import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { getCampaignReport, getCampaignReportOptions } = await import('../services/outreach/CampaignReportingService.js');

const dialect = new PgDialect();

beforeEach(() => { execute.mockReset(); });

describe('campaign report query workload', () => {
  it('loads filter choices without building the canonical message and identity graph', async () => {
    const options = { campaigns: [], workspaces: [], imports: [], accounts: [], preparedCampaigns: [] };
    execute.mockResolvedValue({ rows: [options] });

    await expect(withBusinessScope({ userId: 7, businessProfileId: 11 }, () => getCampaignReportOptions(7))).resolves.toEqual(options);

    const query = dialect.sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql.trimStart()).toMatch(/^SELECT/i);
    expect(query.sql).not.toContain('WITH RECURSIVE paths');
    expect(query.sql).toContain('FROM outreach_messages m');
    expect(query.sql).toContain('FROM outreach_jobs j');
    expect(query.sql).toContain('FROM sent_messages s');
    expect(query.params).toEqual(expect.arrayContaining([7, 11]));
  });

  it('pushes safe WhatsApp cohort filters into each report source projection', async () => {
    let captured: SQL | undefined;
    const executor = { execute: async (query: SQL) => { captured = query; return { rows: [] }; } };

    await expect(withBusinessScope({ userId: 7, businessProfileId: 11 }, () => getCampaignReport(7, { channel: 'whatsapp' }, executor as never)))
      .rejects.toThrow('The report snapshot could not be read.');

    const query = dialect.sqlToQuery(captured!);
    expect(query.sql).toContain("c.channel IN (");
    expect(query.sql).toContain('j.channel IN (');
    expect(query.sql).toContain('s.channel IN (');
    expect(query.sql).toContain('m.message_kind');
    expect(query.params.filter(value => value === 'whatsapp')).toHaveLength(7);
    expect(query.params).toContain('outreach');
    expect(query.params.filter(value => value === 7).length).toBeGreaterThan(1);
    expect(query.params.filter(value => value === 11).length).toBeGreaterThan(1);
  });

  it('builds CRM import membership independently of each report message', async () => {
    execute.mockResolvedValue({ rows: [{ id: 9 }] });
    let captured: SQL | undefined;
    const executor = { execute: async (query: SQL) => { captured = query; return { rows: [] }; } };

    await expect(withBusinessScope({ userId: 7, businessProfileId: 11 }, () =>
      getCampaignReport(7, { channel: 'whatsapp', importSource: 'crm', importId: 9 }, executor as never)))
      .rejects.toThrow('The report snapshot could not be read.');

    const query = dialect.sqlToQuery(captured!);
    expect(query.sql).toContain('i.lead_id IN (');
    expect(query.sql).toContain('i.customer_key IN (');
    expect(query.sql).not.toContain('contact.lead_id=i.lead_id');
    expect(query.sql).not.toContain("i.customer_key='contact:'||contact.id");
    expect(query.params.filter(value => value === 9)).toHaveLength(2);
    expect(query.params.filter(value => value === 7).length).toBeGreaterThan(2);
  });
});
