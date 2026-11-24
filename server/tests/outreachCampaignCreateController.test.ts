import { expect, it, jest, beforeEach } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const execute = jest.fn<(query: SQL) => Promise<{ rows: unknown[] }>>();
const create = jest.fn<any>().mockResolvedValue(51);
const get = jest.fn<any>().mockResolvedValue({ id: 51 });
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/leads/schema.js', () => ({ leadsTable: {} }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({
  businessOwnerUserId: () => 9,
  requireBusinessScope: () => ({ userId: 9, businessProfileId: 42 }),
}));
jest.unstable_mockModule('../services/agents/OutreachAgent.js', () => ({
  OutreachAgent: class { createCampaign = create; getCampaign = get; },
}));
jest.unstable_mockModule('../tools/outreachSender.js', () => ({ outreachSenderWorker: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/outreach/CampaignDeliveryService.js', () => ({
  CampaignDeliveryReviewError: class extends Error {}, prepareCampaignDelivery: jest.fn(),
}));
const { createCampaign } = await import('../controllers/outreachAgentController.js');

beforeEach(() => {
  execute.mockReset().mockImplementation(async query => {
    const sql = dialect.sqlToQuery(query).sql;
    if (sql.includes('FROM icp_profiles')) return { rows: [{ id: 21 }] };
    if (sql.includes('FROM leads')) return { rows: [{ id: 138 }] };
    if (sql.includes('FROM outreach_sequences')) return { rows: [{ id: 7, sequence_type: 'email' }] };
    throw new Error('Unexpected query');
  });
  create.mockClear();
});

it('validates campaign inputs in the selected workspace and saves the requested reply policy', async () => {
  const req = { body: { icp_id: 21, campaign_name: 'QA', campaign_type: 'email', leads: [{ id: 138 }], sequence_id: 7, auto_reply: true } } as any;
  const res = { json: jest.fn(), status: jest.fn() } as any;
  await createCampaign(req, res);
  expect(create).toHaveBeenCalledWith(9, 21, 'QA', 'email', [{ id: 138 }], [7], true, { brandToolkitId: undefined, threadId: undefined });
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: 51 }));
  for (const [query] of execute.mock.calls) {
    const compiled = dialect.sqlToQuery(query);
    expect(compiled.sql).toContain('business_profile_id');
    expect(compiled.params).toContain(42);
    expect(compiled.sql).not.toMatch(/ANY\s*\(\s*\(/);
  }
});
