/**
 * Admin Service Tests
 * Tests: AdminServiceError, runService, parseIntParam
 */
import { describe, it, expect } from '@jest/globals';
import { AdminServiceError, runService, parseIntParam, parseIntQuery } from '../services/adminUserService';

describe('AdminServiceError', () => {
  it('captures status + code + message', () => {
    const err = new AdminServiceError(404, 'User not found', 'user_not_found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('user_not_found');
    expect(err.message).toBe('User not found');
    expect(err.name).toBe('AdminServiceError');
  });
});

describe('runService', () => {
  it('returns { status: 200, body } on success', async () => {
    const result = await runService(async () => ({ foo: 'bar' }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ foo: 'bar' });
  });

  it('uses custom success status when provided', async () => {
    const result = await runService(async () => ({ created: true }), { successStatus: 201 });
    expect(result.status).toBe(201);
  });

  it('maps AdminServiceError to its status code with a message body', async () => {
    const result = await runService(async () => {
      throw new AdminServiceError(404, 'User not found');
    });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ message: 'User not found', error: 'User not found' });
  });

  it('preserves explicit public closure recovery codes without changing the status or message', async () => {
    const result = await runService(async () => {
      throw new AdminServiceError(409, 'Retained billing records require review.', 'ACCOUNT_CLOSURE_REVIEW_REQUIRED');
    });
    expect(result).toEqual({ status: 409, body: {
      message: 'Retained billing records require review.', error: 'Retained billing records require review.',
      code: 'ACCOUNT_CLOSURE_REVIEW_REQUIRED',
    } });
  });

  it.each(['admin_error', '23503', 'provider.private.error', 'A'.repeat(102)])('does not expose an internal or invalid error code: %s', async code => {
    const result = await runService(async () => { throw new AdminServiceError(409, 'Review required.', code); });
    expect(result).toEqual({ status: 409, body: { message: 'Review required.', error: 'Review required.' } });
  });

  it('maps ad-hoc { status } errors to their status code', async () => {
    const result = await runService(async () => {
      const err = new Error('Invalid user ID') as Error & { status: number };
      err.status = 400;
      throw err;
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ message: 'Invalid user ID', error: 'Invalid user ID' });
  });

  it('returns 500 for unknown errors', async () => {
    const result = await runService(async () => {
      throw new Error('something broke');
    });
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ error: 'internal_error' });
  });
});

describe('parseIntParam', () => {
  it('parses a valid number', () => {
    expect(parseIntParam('42', 'id')).toBe(42);
  });

  it('throws 400 AdminServiceError for undefined', () => {
    try {
      parseIntParam(undefined, 'id');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminServiceError);
      expect((err as AdminServiceError).status).toBe(400);
    }
  });

  it('throws 400 AdminServiceError for non-numeric', () => {
    try {
      parseIntParam('not-a-number', 'id');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminServiceError);
      expect((err as AdminServiceError).status).toBe(400);
    }
  });
});

describe('parseIntQuery', () => {
  it('returns parsed value when string is valid', () => {
    expect(parseIntQuery('20', 10)).toBe(20);
  });

  it('returns fallback for non-numeric strings', () => {
    expect(parseIntQuery('foo', 10)).toBe(10);
  });

  it('returns fallback for non-string values', () => {
    expect(parseIntQuery(undefined, 10)).toBe(10);
    expect(parseIntQuery({}, 10)).toBe(10);
    expect(parseIntQuery(['5'], 10)).toBe(10);
  });
});
