import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { validateParams, validateQuery } from '../middleware/validation.js';
import { createLeadSchema } from '../middleware/schemas.js';
import { crmContactsQuerySchema } from '../utils/crmWorkspaceValidation.js';

afterEach(() => { jest.restoreAllMocks(); });

describe('security dependency upgrade compatibility', () => {
  it.each([
    ['query', validateQuery(z.object({ page: z.coerce.number().int().positive() })), { page: '-1' }],
    ['params', validateParams(z.object({ id: z.coerce.number().int().positive() })), { id: 'invalid' }],
  ] as const)('returns a field error for invalid %s instead of forwarding a parser exception', (field, middleware, value) => {
    const req = { [field]: value } as unknown as Request;
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json } as unknown as Response;
    const next = jest.fn<(error?: unknown) => void>();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      details: [expect.objectContaining({ field: field === 'query' ? 'page' : 'id', message: expect.any(String) })],
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('preserves free-form contact metadata and location objects', () => {
    const input = { name: 'Synthetic contact', location: { city: 'Chennai' }, customFields: { score: 12, verified: false } };
    expect(createLeadSchema.parse(input)).toMatchObject(input);
  });

  it('keeps date ordering validation when composing contact report filters', () => {
    expect(crmContactsQuerySchema.safeParse({ from: '2026-10-25', to: '2026-10-01' }).success).toBe(false);
    expect(crmContactsQuerySchema.parse({ from: '2026-10-01', to: '2026-10-25', page: '2' })).toMatchObject({ page: 2 });
  });

  it('parses the default port through the numeric transform', async () => {
    jest.replaceProperty(process, 'env', {
      NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_USER: 'synthetic',
      DB_NAME: 'synthetic', DB_SSL: 'false', JWT_SECRET: 'x'.repeat(32), JWT_EXPIRES_IN: '1h',
    });
    const { loadConfig } = await import('../utils/config.js');
    expect(loadConfig().PORT).toBe(3001);
  });
});
