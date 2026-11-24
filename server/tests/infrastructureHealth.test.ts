import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

let redisReady = true;
const query = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ isRedisAvailable: async () => redisReady }));
jest.unstable_mockModule('../models/db.js', () => ({ pgPool: { query } }));
jest.unstable_mockModule('../queues/index.js', () => ({ queueRegistry: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error() {} } }));
const { getInfrastructureStatus, getDetailedHealth } = await import('../controllers/infrastructureController.js');
const app = express();
app.get('/status', getInfrastructureStatus);
app.get('/health', getDetailedHealth);
beforeEach(() => { redisReady = true; query.mockReset(); query.mockResolvedValue({ rows: [{}] }); });

describe('measured infrastructure summaries', () => {
  it('reports Redis outage without inventing healthy worker or event-bus state', async () => {
    redisReady = false;
    const { body } = await request(app).get('/status').expect(200);
    expect(body.data).toMatchObject({ status: 'unhealthy', redis: 'disconnected', workers: 'unknown', eventBus: 'unknown' });
  });
  it('does not call a DB outage healthy when Redis is available', async () => {
    query.mockRejectedValue(new Error('synthetic unavailable'));
    const { body } = await request(app).get('/health').expect(200);
    expect(body.data).toMatchObject({ status: 'unhealthy', redis: true, database: false });
  });
  it('reports measured dependency recovery and preserves diagnostic details', async () => {
    const { body } = await request(app).get('/health').expect(200);
    expect(body.data).toMatchObject({ status: 'healthy', redis: true, database: true });
    expect(body.data.memory.rss).toEqual(expect.any(String));
    expect(body.data.logPersistence).toEqual({ enabled: false, pendingWrites: 0, droppedWrites: 0 });
  });
});
