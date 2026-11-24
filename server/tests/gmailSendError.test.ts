import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { gmailSendError } from '../utils/gmailSendError.js';

const now = Date.parse('2026-10-14T06:00:00.000Z');
afterEach(() => { jest.restoreAllMocks(); });
const rejection = (status = 429, reason = 'rateLimitExceeded', message = 'User-rate limit exceeded. Retry after 2026-10-14T06:35:58.539Z') => ({
  message, response: { status, data: { error: { message, errors: [{ reason }] } } },
});

describe('Gmail send rejection evidence', () => {
  it('extracts the retry time from the screenshot error without guessing delivery', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(gmailSendError(rejection(), true, false)).toMatchObject({
      retryable: true, retryAt: '2026-10-14T06:35:58.539Z', outcomeUncertain: false,
    });
  });
  it.each(['userRateLimitExceeded', 'rateLimitExceeded'])('retries a documented 403 %s rejection', reason => {
    expect(gmailSendError(rejection(403, reason), true, false)).toMatchObject({ retryable: true, outcomeUncertain: false });
  });
  it.each(['forbidden', 'authError', 'domainPolicy', 'dailyLimitExceeded'])('does not retry a 403 %s as a temporary rate limit', reason => {
    expect(gmailSendError(rejection(403, reason), true, false).retryable).toBe(false);
  });
  it('honors the later of Retry-After and the provider message timestamp', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const error = { ...rejection(), response: { ...rejection().response, headers: { 'retry-after': '7200' } } };
    expect(gmailSendError(error, true, false).retryAt).toBe('2026-10-14T08:00:00.000Z');
  });
  it('reads HTTP-date Retry-After from Headers objects', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const error = { ...rejection(), response: { ...rejection().response, headers: new Headers({ 'Retry-After': 'Wed, 14 Oct 2026 08:00:00 GMT' }) } };
    expect(gmailSendError(error, true, false).retryAt).toBe('2026-10-14T08:00:00.000Z');
  });
  it('ignores invalid and past retry dates', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(gmailSendError(rejection(429, '', 'Retry after 2020-01-01T00:00:00Z'), true, false).retryAt).toBeUndefined();
    expect(gmailSendError(rejection(429, '', 'Retry after invalid'), true, false).retryAt).toBeUndefined();
  });
  it.each([new Error('Connection lost'), { status: 429, message: 'User-rate limit exceeded' }, rejection(503)])('protects ambiguous outcomes from resending: %j', error => {
    expect(gmailSendError(error, true, false)).toMatchObject({ outcomeUncertain: true, retryable: false });
  });
  it('never retries an error after provider acceptance', () => {
    expect(gmailSendError(rejection(), true, true)).toMatchObject({ outcomeUncertain: true, retryable: false });
  });
  it('does not classify a preflight failure as a rejected send', () => {
    expect(gmailSendError(rejection(), false, false)).toMatchObject({ outcomeUncertain: false, retryable: false });
  });
});
