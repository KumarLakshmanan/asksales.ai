import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { csrfProtection } from '../middleware/csrf.js';

function runCsrf(options: {
  method: string;
  path: string;
  cookie?: string;
  csrfHeader?: string;
  authorization?: string;
}) {
  const req = {
    method: options.method,
    path: options.path,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrfHeader ? { 'x-xsrf-token': options.csrfHeader } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
  } as unknown as Request;
  const setHeader = jest.fn();
  const json = jest.fn();
  const status = jest.fn((_: number) => ({ json }));
  const res = { setHeader, status } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;

  csrfProtection(req, res, next);
  return { json, next, setHeader, status };
}

describe('csrfProtection', () => {
  it('exempts only the dedicated signed subscription webhook from cookie CSRF', () => {
    expect(runCsrf({ method: 'POST', path: '/api/webhooks/razorpay/subscriptions/2', cookie: 'user_token=ambient' }).next).toHaveBeenCalled();
    for (const path of ['/api/subscriptions/start','/api/subscriptions/change','/api/subscriptions/cancel','/api/admin/subscriptions/enforcement']) {
      expect(runCsrf({ method: 'POST', path, cookie: 'user_token=ambient; XSRF-TOKEN=known' }).status).toHaveBeenCalledWith(403);
    }
  });
  it('issues a double-submit cookie on safe requests', () => {
    const { next, setHeader } = runCsrf({ method: 'GET', path: '/api/auth/csrf-token' });

    expect(next).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringMatching(/^XSRF-TOKEN=[a-f0-9]{64}; Path=\/; SameSite=Lax; Max-Age=86400/),
    );
  });

  it('accepts and rotates a matching cookie/header token', () => {
    const { next, setHeader, status } = runCsrf({
      method: 'PATCH',
      path: '/api/settings/profile',
      cookie: 'XSRF-TOKEN=known-token',
      csrfHeader: 'known-token',
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('XSRF-TOKEN='));
  });

  it('rejects cookie-authenticated unsafe requests without a matching header', () => {
    const { json, next, status } = runCsrf({
      method: 'POST',
      path: '/api/settings/profile/change-password',
      cookie: 'XSRF-TOKEN=known-token',
    });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ message: 'CSRF token missing or mismatched' });
  });

  it('allows bearer-authenticated requests because credentials are not ambient', () => {
    const { next, status } = runCsrf({
      method: 'DELETE',
      path: '/api/leads/42',
      authorization: 'Bearer explicit-token',
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    '/api/resend/webhook',
    '/api/whatsapp/webhook',
    '/api/webhooks/meta',
    '/api/webhooks/razorpay',
    '/api/webhooks/instagram/user-token',
    '/api/support-widget/chat',
    '/api/support-widget/session/85/messages/316/documents/1',
    '/api/support-widget/session/85/feedback',
    '/api/support-widget/installed',
  ])('allows the exact external webhook contract %s', (path) => {
    const { next, status } = runCsrf({ method: 'POST', path });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    '/api/webhooks/regenerate',
    '/api/webhooks/config',
    '/api/webhooks/meta/extra',
    '/api/support-widget/generate-token',
    '/api/support-widget/chat/extra',
    '/api/support-widget/session/85/messages/316/documents/1/approve',
    '/api/support-widget/session/0/messages/316/documents/1',
    '/api/support-widget/session/0/feedback',
    '/api/support-widget/session/85/feedback/extra',
    '/api/support-widget/installed/extra',
    '/api/settings/support-documents/1/publish',
  ])('does not exempt protected or near-match webhook paths %s', (path) => {
    const { next, status } = runCsrf({ method: 'POST', path });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
  it('keeps document mutations protected even at the download URL', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const { next, status } = runCsrf({ method, path: '/api/support-widget/session/85/messages/316/documents/1' });
      expect(next).not.toHaveBeenCalled(); expect(status).toHaveBeenCalledWith(403);
    }
  });
});
