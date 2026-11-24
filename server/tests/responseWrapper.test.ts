import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { responseWrapper } from '../middleware/responseWrapper.js';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();
const access = jest.fn<() => Promise<Record<string, unknown>>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../services/businessProfileStaff.js', () => ({
  requireBusinessAccess: jest.fn(), BusinessProfileAccessError: class extends Error { status = 403; },
}));
jest.unstable_mockModule('../services/subscriptions/service.js', () => ({ subscriptions: { access } }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getMaintenanceSettings: async () => ({ enabled: true, message: 'Scheduled maintenance.' }),
  getEffectiveModuleAccess: async () => [{ key: 'crm', enabled: false, status: 'maintenance', message: 'CRM maintenance.' }],
}));
const { PlanLimitError } = await import('../services/billing/entitlements.js');
const { setupDraft } = await import('../controllers/setupDraftController.js');
const { contentRequestReceipt } = await import('../middleware/contentRequestReceipt.js');
const { validateBody } = await import('../middleware/validation.js');
const { checkSubscriptionRequest } = await import('../middleware/subscriptionAccess.js');
const { maintenanceModeGate, requireModuleAccess } = await import('../middleware/platformAccess.js');

function appWith(handler: (req: Request, res: Response) => unknown, status = 200) {
  const app = express();
  app.use(express.json());
  app.use('/api', responseWrapper);
  app.use((req, res, next) => { req.user = { id: 1001, name: 'Synthetic fixture', email: 'fixture@example.test' }; res.status(status); next(); });
  app.all('/api/test', handler);
  return app;
}
const json = (body: unknown, status = 400) => request(appWith((_req, res) => res.json(body), status)).get('/api/test');

beforeEach(() => { execute.mockReset(); access.mockReset(); });

describe('mounted public response envelopes', () => {
  it.each([
    ['INSIGHTS_ROLLOUT_PENDING', 503], ['SOCIAL_PROVIDER_TIMEOUT', 503],
    ['SOCIAL_ANALYTICS_RECONNECT_REQUIRED', 422], ['BUSINESS_PROFILE_REQUIRED', 400],
    ['BILLING_CONTEXT_MISMATCH', 409], ['CONTENT_REQUEST_PENDING', 409],
    ['CONTENT_REQUEST_EXPIRED', 410], ['EMAIL_SAVE_UNCONFIRMED', 503],
  ])('retains the public %s code and HTTP status %i', async (code, status) => {
    const response = await json({ error: 'Public recovery instructions.', code }, status);
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ success: false, error: 'Public recovery instructions.', code });
  });

  it('retains the actual capacity DTO including zero and receipt identity, excluding diagnostics', async () => {
    const failure = new PlanLimitError({ code: 'PLAN_LIMIT_EXCEEDED', resource: 'contacts', current: 0, requestedIncrease: 1, limit: 0, organizationId: 701 });
    const response = await json({ ...failure.toJSON(), importId: 702, debug: { password: 'synthetic-only' } }, 403);
    expect(response.body).toEqual({ success: false, ...failure.toJSON(), importId: 702 });
  });

  it('retains import uncertainty, workbook row and safe validation metadata', async () => {
    const uncertain = await json({ error: 'Import outcome is unconfirmed.', importId: 703, retryable: true }, 503);
    expect(uncertain.body).toEqual({ success: false, error: 'Import outcome is unconfirmed.', importId: 703, retryable: true });
    const invalid = await json({ error: 'Invalid room count.', row: 3, field: 'total', mappingErrors: ['Choose a stage.'], details: [{ field: 'total', message: 'Must be a whole number.', stack: 'internal' }] });
    expect(invalid.body).toEqual({ success: false, error: 'Invalid room count.', row: 3, field: 'total', mappingErrors: ['Choose a stage.'], details: [{ field: 'total', message: 'Must be a whole number.' }] });
  });

  it('normalizes already standardized and contradictory errors without exposing arbitrary objects', async () => {
    const response = await json({ success: true, error: 'Reconnect the channel.', code: 'SOCIAL_ANALYTICS_RECONNECT_REQUIRED', providerStatus: 401, providerCode: 190, providerSubcode: null, stack: 'internal', cause: { token: 'synthetic-only' }, data: { privateKey: 'synthetic-only' } }, 422);
    expect(response.body).toEqual({ success: false, error: 'Reconnect the channel.', code: 'SOCIAL_ANALYTICS_RECONNECT_REQUIRED', providerStatus: 401, providerCode: 190, providerSubcode: null });
    const objectError = await json({ success: false, error: { message: 'Internal failure', password: 'synthetic-only' }, code: 'PUBLIC_FAILURE', details: 'SELECT internal_table', token: 'synthetic-only' }, 500);
    expect(objectError.body).toEqual({ success: false, error: 'An error occurred', code: 'PUBLIC_FAILURE' });
    expect((await json(new Error('Internal connection string.'), 500)).body).toEqual({ success: false, error: 'An error occurred' });
  });

  it('does not trust inherited fields or evaluate diagnostic getters', async () => {
    const body = Object.create({ code: 'INHERITED_CODE', message: 'Inherited message.' }) as Record<string, unknown>;
    Object.defineProperty(body, 'error', { get() { throw new Error('Getter must not run.'); }, enumerable: true });
    const response = await json(body, 500);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error: 'An error occurred' });
  });

  it('redacts credential-shaped values in public error text and ignores invalid metadata', async () => {
    const response = await json({ success: false, error: 'Provider rejected Bearer synthetic_token_value and api_key=synthetic_key_value', code: { nested: 'INVALID' }, retryable: 'true', row: '3', stack: 'internal' });
    expect(response.body).toEqual({ success: false, error: 'Provider rejected Bearer [REDACTED] and [REDACTED]' });
  });

  it('keeps flattened validation fields without diagnostic extensions', async () => {
    const response = await json({ message: 'Invalid request', errors: { formErrors: ['Choose a channel.'], fieldErrors: { channels: ['Invalid channel.'] }, stack: 'internal' } });
    expect(response.body).toEqual({ success: false, error: 'Invalid request', message: 'Invalid request', errors: { formErrors: ['Choose a channel.'], fieldErrors: { channels: ['Invalid channel.'] } } });
    const knowledge = await json({ success: false, error: 'Invalid knowledge edit', issues: { formErrors: [], fieldErrors: { title: ['Required'] } } });
    expect(knowledge.body).toEqual({ success: false, error: 'Invalid knowledge edit', issues: { formErrors: [], fieldErrors: { title: ['Required'] } } });
  });

  it('keeps real validation middleware errors at the mounted HTTP boundary', async () => {
    const app = express(); app.use(express.json()); app.use('/api', responseWrapper);
    app.post('/api/test', validateBody(z.object({ count: z.number().int() })), (_req, res) => res.json({ saved: true }));
    const response = await request(app).post('/api/test').send({ count: 'wrong' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, error: 'Validation failed', details: [{ field: 'count' }] });
    expect(typeof response.body.details[0].message).toBe('string');
  });

  it('projects real subscription denial without exposing future internal additions', async () => {
    access.mockResolvedValue({ allowed: false, reason: 'subscription_required', accessUntil: null, canTopUp: false, credential: 'synthetic-only' });
    const response = await request(appWith(checkSubscriptionRequest)).get('/api/test');
    expect(response.status).toBe(402);
    expect(response.body).toEqual({ success: false, error: 'Choose a subscription to continue. Your wallet credits are retained.', code: 'SUBSCRIPTION_REQUIRED', subscription: { allowed: false, reason: 'subscription_required', accessUntil: null, canTopUp: false } });
  });

  it('retains actual module and platform maintenance codes, metadata and retry headers', async () => {
    for (const [gate, expected] of [
      [maintenanceModeGate, { code: 'PLATFORM_MAINTENANCE', error: 'Scheduled maintenance.', maintenance: true }],
      [requireModuleAccess('crm'), { code: 'MODULE_MAINTENANCE', error: 'CRM maintenance.', module: 'crm', status: 'maintenance' }],
    ] as const) {
      const app = express(); app.use('/api', responseWrapper);
      app.use((req, _res, next) => { req.user = { id: 1001, name: 'Synthetic', email: 'fixture@example.test' }; next(); });
      app.get('/api/test', gate, (_req, res) => res.json({ reached: true }));
      const response = await request(app).get('/api/test');
      expect(response.status).toBe(503); expect(response.headers['retry-after']).toBe('300');
      expect(response.body).toEqual({ success: false, ...expected });
    }
  });

  it.each([
    null,
    { data: { companyName: 'Synthetic company' }, step: 2, revision: 9, updated_at: '2026-10-23T00:00:00.000Z' },
    { data: { companyName: 'Synthetic company' }, step: 2, revision: 9, updated_at: new Date('2026-10-23T00:00:00.000Z') },
  ])('preserves actual setup conflict recovery, including null tombstones: %j', async row => {
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: row ? [row] : [{ data: null }] });
    const app = appWith(setupDraft);
    app.put('/api/setup/drafts/:draftKey', setupDraft);
    const response = await request(app).put('/api/setup/drafts/workspace:first').send({ expectedRevision: 0, step: 1, data: { companyName: 'Uncommitted draft' } });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SETUP_DRAFT_CONFLICT');
    expect(response.body.draft).toEqual(row ? { data: row.data, step: row.step, revision: row.revision, updatedAt: '2026-10-23T00:00:00.000Z' } : null);
  });

  it('projects conflict recovery fields without copying internal draft diagnostics', async () => {
    const response = await json({ code: 'SETUP_DRAFT_CONFLICT', error: 'Reload the draft.', draft: { data: { companyName: 'Synthetic company' }, step: 0, revision: 1, updatedAt: '2026-10-23T00:00:00.000Z', secret: 'synthetic-only' } }, 409);
    expect(response.body.draft).toEqual({ data: { companyName: 'Synthetic company' }, step: 0, revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' });
  });

  it('projects profile conflict recovery without creation hashes or future internal columns', async () => {
    const response = await json({ code: 'PROFILE_VERSION_CONFLICT', error: 'Reload the profile.', profile: { id: 201, version: 4, companyName: 'Synthetic company', email: 'fixture@example.test', updatedAt: new Date('2026-10-23T00:00:00.000Z'), crmConfiguration: { stages: [] }, creationRequestHash: 'internal-digest', secret: 'synthetic-only' } }, 409);
    expect(response.body.profile).toEqual({ id: 201, version: 4, companyName: 'Synthetic company', email: 'fixture@example.test', updatedAt: '2026-10-23T00:00:00.000Z', crmConfiguration: { stages: [] } });
  });

  it('retains standardized recovery flags and partial ingestion summaries', async () => {
    expect((await json({ success: false, done: true, providerDone: true, persisted: false, assetId: 101, error: 'Result persistence unconfirmed.' }, 503)).body).toEqual({ success: false, done: true, providerDone: true, persisted: false, assetId: 101, error: 'Result persistence unconfirmed.' });
    expect((await json({ success: false, metricsUpdated: 0, errors: ['Synthetic campaign unavailable.'], message: 'Check the connected account.' }, 502)).body).toEqual({ success: false, metricsUpdated: 0, errors: ['Synthetic campaign unavailable.'], error: 'Check the connected account.', message: 'Check the connected account.' });
  });

  it.each(['pending', 'expired', 'complete'])('preserves real content receipt %s semantics without dispatching again', async state => {
    const body = { prompt: 'Synthetic content' };
    const hash = createHash('sha256').update(JSON.stringify({ path: '/api/test', body })).digest('hex');
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash: hash, state, status_code: 201, response_body: { success: true, data: { id: 901 } } }] });
    const provider = jest.fn((_req: Request, res: Response) => res.json({ dispatched: true }));
    // Use a distinct app so the fixture route cannot consume the request first.
    const receipts = express(); receipts.use(express.json()); receipts.use('/api', responseWrapper);
    receipts.use((req, _res, next) => { req.user = { id: 1001, name: 'Synthetic', email: 'fixture@example.test' }; next(); });
    receipts.post('/api/test', contentRequestReceipt, provider);
    const response = await request(receipts).post('/api/test').set('Idempotency-Key', 'synthetic-receipt-key').send(body);
    expect(provider).not.toHaveBeenCalled();
    if (state === 'complete') {
      expect(response.status).toBe(201);
      expect(response.headers['idempotency-replayed']).toBe('true');
      expect(response.headers['content-request-confirmed']).toBe('true');
      expect(response.body).toEqual({ success: true, data: { id: 901 } });
    } else {
      expect(response.status).toBe(state === 'expired' ? 410 : 409);
      expect(response.body.code).toBe(state === 'expired' ? 'CONTENT_REQUEST_EXPIRED' : 'CONTENT_REQUEST_PENDING');
    }
  });

  it.each([
    [{ id: 1 }, { success: true, data: { id: 1 } }],
    [[{ id: 1 }], { success: true, data: [{ id: 1 }] }],
    [{ data: [1], total: 1, page: 0, limit: 10 }, { success: true, data: [1], total: 1, page: 0, limit: 10 }],
    [{ success: true, fenced: false, advanced: true, revision: 'r1' }, { success: true, fenced: false, advanced: true, revision: 'r1' }],
    [{ message: 'Saved.' }, { success: true, message: 'Saved.' }],
    [null, null], ['plain', 'plain'],
  ])('preserves successful controller payload %j', async (body, expected) => { expect((await json(body, 200)).body).toEqual(expected); });

  it('does not touch downloads or stream writes', async () => {
    const response = await request(appWith((_req, res) => { res.type('text/plain'); res.write('synthetic'); res.end('-stream'); })).get('/api/test');
    expect(response.text).toBe('synthetic-stream');
    expect(response.headers['content-type']).toContain('text/plain');
  });
});
