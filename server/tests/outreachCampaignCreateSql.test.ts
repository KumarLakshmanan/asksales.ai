import { expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const execute = jest.fn<(query: SQL) => Promise<{ rows: Array<{ id: number }> }>>()
  .mockResolvedValue({ rows: [{ id: 51 }] });
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../tools/outreachSender.js', () => ({ outreachSenderWorker: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/content/TextContentGenerationService.js', () => ({ REVIEWED_CONTENT_RULES: '' }));
const { OutreachAgent } = await import('../services/agents/OutreachAgent.js');
const dialect = new PgDialect();
const insertQuery = () => dialect.sqlToQuery(execute.mock.calls.map(([query]) => query)
  .find(query => dialect.sqlToQuery(query).sql.includes('INSERT INTO outreach_campaigns'))!);

it('creates a campaign with the selected lead and sequence without invalid SQL comments', async () => {
  execute.mockClear();
  const id = await new OutreachAgent().createCampaign(9, 21, 'QA campaign', 'email', [{ id: 138 }], [7]);
  expect(id).toBe(51);
  const query = insertQuery();
  expect(query.sql).not.toContain('//');
  expect(query.params).toContain('[138]');
  expect(query.params).toContain(JSON.stringify({ icpId: 21, sequenceId: 7, sequenceIds: [7], replyPolicy: { autoSend: false } }));
});

it('records explicitly enabled auto replies on the campaign', async () => {
  execute.mockClear();
  await new OutreachAgent().createCampaign(9, 21, 'QA campaign', 'email', [{ id: 138 }], [7], true);
  const query = insertQuery();
  expect(query.params).toContain(JSON.stringify({ icpId: 21, sequenceId: 7, sequenceIds: [7], replyPolicy: { autoSend: true } }));
});

it('saves the brand the campaign was created with (snapshot of the default when none is chosen)', async () => {
  execute.mockClear();
  await new OutreachAgent().createCampaign(9, 21, 'QA campaign', 'email', [{ id: 138 }], [7]);
  const query = insertQuery();
  expect(query.sql).toContain('brand_toolkit_id');
  // The mocked default-brand lookup returns toolkit 51; it is stored on the campaign.
  expect(query.params).toContain(51);
});
