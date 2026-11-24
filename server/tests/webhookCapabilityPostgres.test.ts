import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { currentVerifiedWebhookCapability, issueWebhookCapability } from '../utils/userWebhookTokens.js';

const url = process.env.OUTREACH_QA_DATABASE_URL;
const local = url ? describe : describe.skip;
let client: Client, database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: (query: SQL) => database.execute(query) } }));
const { businessWebhookScope } = await import('../middleware/businessWebhookScope.js');
const app = express();
app.post('/api/webhooks/sms/:userToken', businessWebhookScope, (req, res) => {
  res.json({ owner: currentVerifiedWebhookCapability(req.params.userToken, 'sms')?.userId, business: currentBusinessScope()?.businessProfileId });
});
const capability = (user = 42, profile = 7, nonce = 'owner-nonce') => issueWebhookCapability(user, nonce, 'sms', profile);

local('webhook ownership and revocation against real PostgreSQL', () => {
  beforeAll(async () => {
    if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Explicit local QA database required');
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`SET search_path TO pg_temp,pg_catalog;
      CREATE TEMP TABLE users(id integer PRIMARY KEY,webhook_token_nonce text,deleted_at timestamptz);
      CREATE TEMP TABLE company_settings(id integer PRIMARY KEY,user_id integer,archived_at timestamptz);
      INSERT INTO users VALUES(42,'owner-nonce',NULL),(99,'other-owner-nonce',NULL);
      INSERT INTO company_settings VALUES(7,42,NULL),(8,99,NULL);`);
    database = drizzle(client);
  });
  beforeEach(async () => {
    await client.query("UPDATE company_settings SET archived_at=NULL; UPDATE users SET deleted_at=NULL; UPDATE users SET webhook_token_nonce='owner-nonce' WHERE id=42;");
  });
  afterAll(async () => { await client?.end(); });
  it('accepts the exact persisted owner and business', async () => {
    const result = await request(app).post(`/api/webhooks/sms/${capability()}`).expect(200);
    expect(result.body).toEqual({ owner: 42, business: 7 });
  });
  it('rejects claims that cross either ownership boundary', async () => {
    await request(app).post(`/api/webhooks/sms/${capability(99, 7)}`).expect(403);
    await request(app).post(`/api/webhooks/sms/${capability(42, 8)}`).expect(403);
  });
  it('revokes an existing capability when its persisted nonce changes', async () => {
    const issued = capability();
    await client.query("UPDATE users SET webhook_token_nonce='rotated-nonce' WHERE id=42");
    await request(app).post(`/api/webhooks/sms/${issued}`).expect(403);
    await request(app).post(`/api/webhooks/sms/${capability(42, 7, 'rotated-nonce')}`).expect(200);
  });
  it('rejects callbacks for archived businesses or deleted owners', async () => {
    await client.query('UPDATE company_settings SET archived_at=NOW() WHERE id=7');
    await request(app).post(`/api/webhooks/sms/${capability()}`).expect(403);
    await client.query('UPDATE company_settings SET archived_at=NULL; UPDATE users SET deleted_at=NOW() WHERE id=42');
    await request(app).post(`/api/webhooks/sms/${capability()}`).expect(403);
  });
});
