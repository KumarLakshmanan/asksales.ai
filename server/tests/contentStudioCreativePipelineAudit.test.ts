import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const local = process.env.STUDIO_DISPOSABLE_AUDIT === '1' ? describe : describe.skip;
let fixtureDb: ReturnType<typeof drizzle>;
const complete = jest.fn<any>();
jest.unstable_mockModule('../models/db', () => ({ db: new Proxy({}, {
  get(_target, property) {
    const value = Reflect.get(fixtureDb, property);
    return typeof value === 'function' ? value.bind(fixtureDb) : value;
  },
}) }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: complete } }));
jest.unstable_mockModule('../services/agents/MetaPromptEngine', () => ({ MetaPromptEngine: class {} }));
jest.unstable_mockModule('../services/media/MediaGenerationWorkerFactory', () => ({ createImageGenerationWorker: jest.fn(), createVideoGenerationWorker: jest.fn() }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: {} }));
jest.unstable_mockModule('../queues/JobDispatcher.js', () => ({ jobDispatcher: {} }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({ getChatThreadById: jest.fn() }));
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: {} }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {} }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class extends Error {}, resolveContentBrandContext: jest.fn(),
  formatContentBrandContext: jest.fn(), formatMediaBrandContext: jest.fn(), brandContextSnapshot: jest.fn(),
}));
jest.unstable_mockModule('../services/content/BrandMediaComposer.js', () => ({ primaryBrandLogoUrl: jest.fn() }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { generateCreatives } = await import('../controllers/contentStudioController');
const { contentStudioCreativesSchema } = await import('../middleware/contentStudioLegacySchemas');
const { validateBody } = await import('../middleware/validation');

local('creative HTTP → validator → real agent → PostgreSQL persistence', () => {
  let pool: Pool;
  let admin: Pool;
  const schema = `studio_pipeline_${randomBytes(6).toString('hex')}`;
  const app = express();
  app.use(express.json());
  // Synthetic authentication only. Full application auth/RLS is not claimed.
  app.use((req, res, next) => {
    const id = Number(req.header('x-synthetic-user'));
    if (![7, 8].includes(id)) { res.sendStatus(401); return; }
    (req as any).user = { id }; next();
  });
  app.post('/api/content/studio/creatives', validateBody(contentStudioCreativesSchema), generateCreatives);
  beforeAll(async () => {
    admin = new Pool({ host: '127.0.0.1', port: 5544, user: 'postgres', database: 'studio_audit' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ host: '127.0.0.1', port: 5544, user: 'postgres', database: 'studio_audit', options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    await pool.query(`CREATE TABLE icp_profiles(id integer PRIMARY KEY,user_id integer,target_audience text,industry text);
      INSERT INTO icp_profiles VALUES(11,7,'Synthetic teams','Software');
      CREATE TABLE creative_prompts(id serial PRIMARY KEY,icp_id integer,user_id integer,creative_type text,prompt text CHECK(prompt <> 'REJECT'),style_guide text,dimensions text,color_palette jsonb,key_elements jsonb,created_at timestamp)`);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); } });
  beforeEach(async () => {
    complete.mockReset();
    await pool.query('TRUNCATE creative_prompts RESTART IDENTITY');
  });
  const post = (user = 7) => request(app).post('/api/content/studio/creatives').set('x-synthetic-user', String(user)).send({ icp_id: 11, creative_type: 'image', count: 2 });
  const output = (prompts: string[]) => complete.mockResolvedValue({ success: true, content: JSON.stringify({ prompts: prompts.map(prompt => ({ prompt })) }) });

  it('returns two actual saved IDs and reloads their content from PostgreSQL', async () => {
    output(['First synthetic visual', 'Second synthetic visual']);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body.creative_ids).toHaveLength(2);
    const rows = (await pool.query('SELECT id,prompt,user_id FROM creative_prompts ORDER BY id')).rows;
    expect(rows.map(row => row.id)).toEqual(response.body.creative_ids);
    expect(rows.map(row => row.prompt)).toEqual(['First synthetic visual', 'Second synthetic visual']);
    expect(rows.every(row => row.user_id === 7)).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('rejects a short provider response before creating any records', async () => {
    output(['Short response']);
    expect((await post()).status).toBe(500);
    expect((await pool.query('SELECT * FROM creative_prompts')).rows).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('rolls back the whole batch when the second insert fails', async () => {
    output(['First synthetic visual', 'REJECT']);
    expect((await post()).status).toBe(500);
    expect((await pool.query('SELECT * FROM creative_prompts')).rows).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('blocks foreign ICP access before the mocked provider or persistence', async () => {
    output(['First synthetic visual', 'Second synthetic visual']);
    expect((await post(8)).status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
    expect((await pool.query('SELECT * FROM creative_prompts')).rows).toHaveLength(0);
  });
  it('blocks unauthenticated requests before the generation handler', async () => {
    expect((await request(app).post('/api/content/studio/creatives').send({ icp_id: 11, creative_type: 'image' })).status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });
});
