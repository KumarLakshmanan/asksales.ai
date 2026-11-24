import { describe, expect, it, jest } from '@jest/globals';
import express, { type Request } from 'express';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { responseWrapper } from '../middleware/responseWrapper.js';

const effects = jest.fn(async () => { throw new Error('Provider work must not start for a conflicting request.'); });
let savedHash = '';
const fixtureExecute = async (query: SQL) => {
  const { sql } = new PgDialect().sqlToQuery(query);
  if (sql.includes('SELECT * FROM conversation_request_scopes')) return { rows: [{ lease_expires_at: null }] };
  if (sql.includes('SELECT * FROM conversation_requests')) return { rows: [{ id: 1, input_hash: savedHash, status: 'completed' }] };
  return { rows: [] };
};
const fixtureDatabase = {
  execute: fixtureExecute,
  transaction: async <T>(work: (tx: { execute: typeof fixtureExecute }) => Promise<T>) => work({ execute: fixtureExecute }),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: fixtureDatabase }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
const { ConversationRequestCoordinator, ConversationRequestError, conversationRequestHash } = await import('../services/ConversationRequestCoordinator.js');
const coordinator = new ConversationRequestCoordinator(fixtureDatabase);
// The service's authorization/persistence/provider work is outside this envelope test.
// Bridge into the real coordinator to produce the established conflict at its source.
jest.unstable_mockModule('../services/SupportChatService.js', () => ({
  sendMessage: (sessionId: number, _memberId: number, message: string, _context: unknown, requestId: string) =>
    coordinator.run({ userId: 101, kind: 'support_advisory', conversationId: sessionId, requestId, input: { message } }, effects),
}));
const { sendMessage } = await import('../controllers/supportChatController.js');
const publicMessage = 'This message identity was already used for different content.';

function envelope(body: unknown) {
  const app = express(); app.use('/api', responseWrapper);
  app.get('/api/fixture', (_req, res) => res.status(409).json(body));
  return request(app).get('/api/fixture');
}

describe('legacy Conversation request_conflict public envelope', () => {
  it('retains the real coordinator conflict through an actual mounted Support chat controller', async () => {
    savedHash = conversationRequestHash({ message: 'Original synthetic content' });
    const app = express(); app.use(express.json()); app.use('/api', responseWrapper);
    app.use((req, _res, next) => { (req as Request & { supportMember: { id: number } }).supportMember = { id: 901 }; next(); });
    app.post('/api/support-portal/chat/sessions/:id/messages', sendMessage);
    const response = await request(app).post('/api/support-portal/chat/sessions/201/messages').send({ requestId: 'synthetic-conflict-request', message: 'Changed synthetic content' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ success: false, error: publicMessage, code: 'request_conflict' });
    expect(effects).not.toHaveBeenCalled();
  });

  it('preserves only the allowlisted public fields from a pre-standardized conflict', async () => {
    const response = await envelope({ success: false, code: 'request_conflict', error: publicMessage,
      stack: 'synthetic internal stack', cause: { code: '23505' }, providerPayload: { access_token: 'synthetic-only' },
      data: { secret: 'synthetic-only' }, sql: 'SELECT internal_table', debug: { connection: 'synthetic-only' } });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ success: false, error: publicMessage, code: 'request_conflict' });
  });

  it.each(['invalid_grant', 'synthetic_provider_error', '23505', 'request_conflict_extra', 'Request_conflict', ' request_conflict'])('does not admit an unrelated lowercase/provider/SQL code: %s', async code => {
    const response = await envelope({ success: false, error: publicMessage, code });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ success: false, error: publicMessage });
  });

  it('does not trust an inherited compatibility code or evaluate its getter', async () => {
    const inherited = Object.create({ code: 'request_conflict' }) as Record<string, unknown>;
    inherited.error = publicMessage;
    expect((await envelope(inherited)).body).toEqual({ success: false, error: publicMessage });
    const getter = jest.fn(() => 'request_conflict');
    const body = { error: publicMessage };
    Object.defineProperty(body, 'code', { enumerable: true, get: getter });
    expect((await envelope(body)).body).toEqual({ success: false, error: publicMessage });
    expect(getter).not.toHaveBeenCalled();
  });

  it('requires an explicit public DTO instead of serializing a native coordinator Error', async () => {
    const failure = new ConversationRequestError('request_conflict', publicMessage);
    Object.assign(failure, { stack: 'synthetic internal stack', credentials: 'synthetic-only' });
    expect((await envelope(failure)).body).toEqual({ success: false, error: 'An error occurred' });
  });
});
