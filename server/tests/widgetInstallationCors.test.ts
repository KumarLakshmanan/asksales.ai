import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { isWidgetInstallationRequest, widgetInstallationCors } from '../middleware/widgetInstallationCors.js';

function app() {
  const app = express();
  app.use((req, res, next) => isWidgetInstallationRequest(req) ? widgetInstallationCors(req, res, next) : next());
  app.post('/api/support-widget/installed', (_req, res) => res.status(204).end());
  app.get('/api/support-widget/token', (_req, res) => res.status(401).end());
  return app;
}

describe('widget installation CORS boundary', () => {
  it('permits anonymous installation telemetry from a website without credentialed CORS', async () => {
    const result = await request(app()).post('/api/support-widget/installed').set('Origin', 'https://customer.example').send({ token: 'public-widget-key' });
    expect(result.status).toBe(204);
    expect(result.headers['access-control-allow-origin']).toBe('https://customer.example');
    expect(result.headers['access-control-allow-credentials']).toBeUndefined();
  });
  it('accepts only POST preflights and exposes no owner settings', async () => {
    const result = await request(app()).options('/api/support-widget/installed').set('Origin', 'https://customer.example').set('Access-Control-Request-Method', 'POST');
    expect(result.status).toBe(204);
    expect(result.headers['access-control-allow-methods']).toBe('POST');
    const protectedRead = await request(app()).get('/api/support-widget/token').set('Origin', 'https://customer.example');
    expect(protectedRead.headers['access-control-allow-origin']).toBeUndefined();
    expect(protectedRead.status).toBe(401);
    expect(isWidgetInstallationRequest({ path: '/api/support-widget/installed', method: 'OPTIONS', headers: { 'access-control-request-method': 'PUT' } })).toBe(false);
  });
  it.each(['null', 'https://customer.example/path', 'ftp://customer.example'])('does not grant CORS to malformed origin %s', async (origin) => {
    const result = await request(app()).post('/api/support-widget/installed').set('Origin', origin);
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });
});
