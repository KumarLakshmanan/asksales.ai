import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { validateBody } from '../middleware/validation';
import {
  contentStudioPlanSchema, contentStudioCreativesSchema,
  contentStudioMetaPromptSchema, contentStudioPromptVariationsSchema,
} from '../middleware/contentStudioLegacySchemas';

// HTTP validation boundary only: the terminal handler echoes the validated
// body. This does not claim provider, billing, authentication or DB coverage.
// These prepared contracts are not bound into production routes in the
// publication subset; current v8 routing is deliberately retained.
const cases = [
  { path: 'plan', schema: contentStudioPlanSchema, body: { icp_id: 11, duration_days: 7 } },
  { path: 'creatives', schema: contentStudioCreativesSchema, body: { icp_id: 11, creative_type: 'image', count: 2 } },
  { path: 'meta-prompt', schema: contentStudioMetaPromptSchema, body: { icp_id: 11, content_type: 'email', brand_toolkit_id: 12 } },
  { path: 'prompt-variations', schema: contentStudioPromptVariationsSchema, body: { icp_id: 11, base_prompt: 'Synthetic useful brief', content_type: 'email', count: 2 } },
];
const app = express();
app.use(express.json());
for (const entry of cases) app.post(`/studio/${entry.path}`, validateBody(entry.schema), (req, res) => res.json(req.body));

describe('prepared legacy studio HTTP contracts (production activation held)', () => {
  it.each(cases)('accepts the $path handler fields and preserves them', async entry => {
    const response = await request(app).post(`/studio/${entry.path}`).send(entry.body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(entry.body);
  });
  it.each(cases)('rejects missing ICP for $path', async entry => {
    const { icp_id: _ignored, ...body } = entry.body;
    expect((await request(app).post(`/studio/${entry.path}`).send(body)).status).toBe(400);
  });
  it.each([0, -1, 1.5, 21, '2'])('rejects invalid creative count %s', async count => {
    expect((await request(app).post('/studio/creatives').send({ ...cases[1].body, count })).status).toBe(400);
  });
  it('rejects unknown keys before a handler runs', async () => {
    expect((await request(app).post('/studio/plan').send({ ...cases[0].body, userId: 99 })).status).toBe(400);
  });
});
