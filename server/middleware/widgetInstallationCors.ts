import cors from 'cors';
import type { Request } from 'express';

/** Only the anonymous installation signal may originate on a customer's site.
 * Dashboard settings and all credentialed customer-session routes keep the
 * application's normal origin policy. The signal still validates its token. */
export function isWidgetInstallationRequest(req: Pick<Request, 'path' | 'method' | 'headers'>) {
  return req.path === '/api/support-widget/installed'
    && (req.method === 'POST' || req.method === 'OPTIONS'
      && req.headers['access-control-request-method'] === 'POST');
}

export const widgetInstallationCors = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, false);
    try {
      const url = new URL(origin);
      return callback(null, ['http:', 'https:'].includes(url.protocol) && url.origin === origin);
    } catch { return callback(null, false); }
  },
  credentials: false,
  methods: ['POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600,
});
