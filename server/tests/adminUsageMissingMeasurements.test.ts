import { beforeEach, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

type Measurement = number | null;
let measurements: Array<{ tokens: Measurement; cost: Measurement; duration: Measurement }>;
const rows = () => measurements.map((m, index) => ({
  id: index + 1, userId: 11, threadId: null, model: 'synthetic-model', provider: 'openai',
  purpose: 'synthetic-purpose', service: 'synthetic-service', promptTokens: m.tokens,
  completionTokens: m.tokens, totalTokens: m.tokens, estimatedCostCents: m.cost, inputTokens: m.tokens, outputTokens: m.tokens, costCents: m.cost, operationType: "content_generation", imagesGenerated: 0, videosGenerated: 0, status: "success",
  durationMs: m.duration, responseSuccess: 1, createdAt: '2026-11-06T10:00:00.000Z',
  userName: 'Synthetic', userEmail: 'synthetic@example.test',
}));
const builder = {
  from: () => builder, leftJoin: () => builder, where: () => builder,
  orderBy: async () => rows(),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => builder } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { getLLMUsage, getGeminiUsageDetailed } = await import('../controllers/adminUsageController.js');
const { responseWrapper } = await import('../middleware/responseWrapper.js');
const app = express();
app.use('/api', responseWrapper);
app.get('/api/admin/usage/llm', getLLMUsage);
app.get('/api/admin/usage/gemini', getGeminiUsageDetailed);
beforeEach(() => { measurements = []; });
const read = async () => (await request(app).get('/api/admin/usage/llm?days=30').expect(200)).body;

it('control: recorded zero duration/tokens/cost remain measured zero', async () => {
  measurements = [{ tokens: 0, cost: 0, duration: 0 }];
  expect((await read()).summary).toMatchObject({ totalCalls: 1, totalTokens: 0, totalCostCents: 0, avgLatency: 0 });
});

it('ADM-07 regression: all-null measurements must not produce the measured-zero summary', async () => {
  measurements = [{ tokens: 0, cost: 0, duration: 0 }];
  const zero = await read();
  measurements = [{ tokens: null, cost: null, duration: null }];
  const missing = await read();
  expect(missing.summary).not.toEqual(zero.summary);
  expect(missing.summary).toMatchObject({ totalCalls: 1, totalTokens: null, totalCostCents: null, totalCost: null, avgLatency: null, measuredDurationCount: 0, measuredTokenCalls: 0, measuredCostCalls: 0 });
  for (const data of [missing.breakdown[0], missing.summary.byDay[0], missing.summary.byPurpose['synthetic-purpose']]) expect(data).toMatchObject({ tokens: null, costCents: null, measuredTokenCalls: 0, measuredCostCalls: 0 });
  expect(missing.recentActivity[0].cost).toBeNull();
});

it('ADM-06/15 regression: missing duration is excluded from the measured-duration denominator', async () => {
  measurements = [{ tokens: 0, cost: 0, duration: 0 }, { tokens: null, cost: null, duration: null }, { tokens: 100, cost: 0.25, duration: 200 }];
  const result = await read();
  expect(result.summary.totalCalls).toBe(3);
  expect(result.summary.avgLatency).toBe(100);
  expect(result.summary).toMatchObject({ measuredDurationCount: 2, totalDurationMs: 200, totalTokens: null, totalCostCents: null });
});

it('Gemini preserves missing measurements and reports no stored duration coverage', async () => {
  measurements = [{ tokens: null, cost: null, duration: 300 }];
  const missing = (await request(app).get('/api/admin/usage/gemini').expect(200)).body;
  expect(missing.summary).toMatchObject({ totalCalls: 1, totalTokens: null, totalCostCents: null, totalCost: null, avgLatency: null, measuredDurationCount: 0, totalDurationMs: 0 });
  expect(missing.breakdown[0]).toMatchObject({ tokens: null, cost: null });
  measurements = [{ tokens: 0, cost: 0, duration: 0 }];
  const zero = (await request(app).get('/api/admin/usage/gemini').expect(200)).body;
  expect(zero.summary).toMatchObject({ totalTokens: 0, totalCost: 0, measuredTokenCalls: 1, measuredCostCalls: 1, avgLatency: null });
});
