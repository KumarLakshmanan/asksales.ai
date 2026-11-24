import type { Request } from 'express';

/** APP_URL, then API_URL, then the protocol and Host header of the request. */
export const getRequestAppUrl = (req: Request): string => {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.API_URL) return process.env.API_URL;
  const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.get('host') || 'localhost:8080';
  return `${protocol}://${host}`;
};
