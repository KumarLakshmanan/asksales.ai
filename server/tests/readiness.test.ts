import { describe, expect, it } from '@jest/globals';
import { dependenciesReady, readinessHandler } from '../infrastructure/readiness.js';
import type { Request, Response } from 'express';

describe('bounded dependency readiness', () => {
  it('requires DB, Redis and required consumers, including after an outage recovers', async () => {
    let db = false;
    const checks = [async () => true, async () => db, async () => true];
    expect(await dependenciesReady(checks)).toBe(false);
    db = true; expect(await dependenciesReady(checks)).toBe(true);
    expect(await dependenciesReady([async () => { throw new Error('synthetic'); }])).toBe(false);
  });
  it('bounds a hung dependency and returns 503 while draining', async () => {
    expect(await dependenciesReady([() => new Promise(() => {})], 10)).toBe(false);
    let status = 0; let body: unknown;
    const response = { status(n: number) { status = n; return response; }, json(value: unknown) { body = value; } };
    await readinessHandler([async () => true], () => true)({} as Request, response as Response);
    expect(status).toBe(503); expect(body).toEqual({ status: 'unhealthy' });
  });
  it('rechecks draining after an already-started dependency probe settles', async () => {
    let draining = false;
    let release!: (ready: boolean) => void;
    const pending = new Promise<boolean>(resolve => { release = resolve; });
    let status = 0;
    const response = { status(code: number) { status = code; return response; }, json() {} };
    const request = readinessHandler([() => pending], () => draining)({} as Request, response as unknown as Response);
    draining = true;
    release(true);
    await request;
    expect(status).toBe(503);
  });
});
