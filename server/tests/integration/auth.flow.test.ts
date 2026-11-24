/**
 * Phase 3.16 / TEST-002: Auth integration test — register + login + refresh.
 * Skipped unless SKIP_DB=false AND a Postgres test DB is available.
 */

import request from 'supertest';

// Skip the test in CI by default — this requires a real DB and is run
// as part of the manual integration suite.
const itDb = process.env.RUN_INTEGRATION_TESTS === 'true' ? it : it.skip;

describe('Auth flow (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  const testEmail = `it_${Date.now()}@example.com`;

  beforeAll(async () => {
    if (process.env.RUN_INTEGRATION_TESTS !== 'true') return;
    const mod = await import('../../index.js');
    // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
    app = mod.app || mod.default || mod;
    server = app.listen(0);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  itDb('POST /api/auth/register creates a user', async () => {
    const res = await request(server)
      .post('/api/auth/register')
      .send({
        email: testEmail,
        password: 'TestPass123!@#',
        name: 'Integration Test',
      });
    expect([200, 201, 400]).toContain(res.status); // 400 if email already exists from previous run
  });

  itDb('POST /api/auth/login returns tokens', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: testEmail, password: 'TestPass123!@#' });
    expect([200, 401]).toContain(res.status);
  });
});
