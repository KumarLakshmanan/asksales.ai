import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, property) => (fixtureDb as any)[property].bind(fixtureDb),
}) }));
const { prepareSupportChatAttachments, retainSupportChatAttachments } = await import('../services/SupportChatAttachments.js');
const { outreachMessageAttachmentsTable } = await import('../models/outreachConversations/schema.js');
const local = process.env.SUPPORT_KNOWLEDGE_LOCAL_QA === '1' ? describe : describe.skip;
local('tenant-owned chat upload references (isolated PostgreSQL)', () => {
  let pool: Pool; let admin: Pool; let schema: string;
  const fileId = '12345678-1234-1234-1234-123456789abc';
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_upload_qa_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` }); fixtureDb = drizzle(pool);
    const definition = getTableConfig(outreachMessageAttachmentsTable);
    await pool.query(`CREATE TABLE "${definition.name}" (${definition.columns.map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
    await pool.query(`INSERT INTO outreach_message_attachments(public_id,user_id,status,extraction_status,extracted_text,file_name,mime_type,file_size_bytes,expires_at)
      VALUES($1,9,'ready','success','File states: two rooms. Email: synthetic@example.test','reference.txt','text/plain',100,NOW()+INTERVAL '1 day')`, [fileId]);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_upload_qa_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  it('ignores forged client content, passes extracted reference evidence, and redacts PII', async () => {
    const prepared = await prepareSupportChatAttachments(9, [{ id: fileId, extractedText: 'INJECTED', url: 'https://attacker.test' }]);
    expect(prepared.referenceEvidence[0].source).toBe(`user_upload:${fileId}`);
    expect(prepared.referenceContext).toContain('two rooms');
    expect(prepared.referenceContext).not.toContain('synthetic@example.test');
    expect(prepared.referenceContext).not.toContain('INJECTED');
    expect(JSON.stringify(prepared)).not.toContain('attacker.test');
    await expect(prepareSupportChatAttachments(10, [{ id: fileId }])).rejects.toThrow('unavailable');
  });
  it('claims a thirty-day support retention without an outreach message foreign key', async () => {
    await retainSupportChatAttachments(9, 22, [fileId]);
    const row = (await pool.query('SELECT metadata,message_id,expires_at FROM outreach_message_attachments')).rows[0];
    expect(row.metadata.supportChatSessionId).toBe(22); expect(row.message_id).toBeNull();
    expect(row.expires_at.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    await retainSupportChatAttachments(9, 23, [fileId]);
    expect((await pool.query('SELECT expires_at FROM outreach_message_attachments')).rows[0].expires_at).toEqual(row.expires_at);
    await pool.query('UPDATE outreach_message_attachments SET expires_at=NOW()-INTERVAL \'1 second\'');
    await expect(prepareSupportChatAttachments(9, [{ id: fileId }])).rejects.toThrow('unavailable');
  });
});
