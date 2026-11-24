/**
 * Test Helpers – Mock Express Request/Response and common utilities
 */
import type { Request, Response } from 'express';

/**
 * Create a mock Express Request object
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mockRequest(overrides: Partial<Request> & Record<string, any> = {}): Request {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: Partial<Request> & Record<string, any> = {
    body: {},
    params: {},
    query: {},
    headers: {},
    ip: '127.0.0.1',
    method: 'GET',
    path: '/',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: { remoteAddress: '127.0.0.1' } as any,
    ...overrides,
  };
  return req as Request;
}

/**
 * Create a mock Express Response object with spies
 */
export function mockResponse(): Response & {
  _status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _json: any;
  _sent: string;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    _status: 200,
    _json: null,
    _sent: '',
    status(code: number) {
      res._status = code;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(data: any) {
      res._json = data;
      res._status = res._status || 200;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(data: any) {
      res._sent = data;
      return res;
    },
    end() {
      return res;
    },
    setHeader() {
      return res;
    },
    header() {
      return res;
    },
    set() {
      return res;
    },
    type() {
      return res;
    },
    cookie() {
      return res;
    },
    clearCookie() {
      return res;
    },
    redirect() {
      return res;
    },
    render() {
      return res;
    },
    sendFile() {
      return res;
    },
    download() {
      return res;
    },
    sendStatus(code: number) {
      res._status = code;
      return res;
    },
  };
  return res;
}

/**
 * Create a mock authenticated request (user attached)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mockAuthRequest(userId: number = 1, extra: Record<string, any> = {}): Request {
  return mockRequest({
    user: { id: userId, email: `user${userId}@test.com`, name: `Test User ${userId}` },
    ...extra,
  });
}

/**
 * Create a mock admin authenticated request
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mockAdminRequest(adminId: number = 1, extra: Record<string, any> = {}): Request {
  return mockRequest({
    // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
    user: { id: adminId, email: `admin${adminId}@test.com`, role: 'admin', adminId },
    ...extra,
  });
}
