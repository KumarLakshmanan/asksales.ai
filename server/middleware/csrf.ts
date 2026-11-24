/**
 * CSRF protection middleware (Phase 4.8 / SEC-010)
 *
 * Implements a "double-submit cookie" pattern: on first response we set a
 * non-HttpOnly cookie `XSRF-TOKEN` that JS can read. For state-changing
 * requests (POST/PUT/PATCH/DELETE) we then require the client to echo the
 * same value back in the `X-XSRF-TOKEN` header.
 *
 * Why this works: a cross-origin attacker can read a non-HttpOnly cookie
 * (via XHR) but cannot SET the `X-XSRF-TOKEN` header on a cross-origin
 * request without triggering a preflight, and SameSite=Lax cookies
 * aren't sent on cross-site POSTs anyway. Combined with the existing
 * CORS allow-list this is sufficient.
 *
 * Bearer-authenticated requests (Authorization: Bearer ...) are exempt
 * because the token isn't auto-attached by the browser, so CSRF doesn't
 * apply.
 *
 * No external cookie-parser dependency — we parse the Cookie header
 * inline. This keeps the dependency surface small.
 */
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { logger } from "../utils/logger.js";

const CSRF_COOKIE_NAME = "XSRF-TOKEN";
const CSRF_HEADER_NAME = "x-xsrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXTERNAL_WEBHOOK_PATHS = new Set([
  "/api/gmail/oauth/webhook",
  "/api/resend/webhook",
  "/api/webhooks/facebook",
  "/api/webhooks/instagram",
  "/api/webhooks/meta",
  "/api/webhooks/razorpay",
  "/api/whatsapp/payment/webhook",
  "/api/whatsapp/webhook",
]);
const PUBLIC_TOKEN_AUTHENTICATED_PATHS = new Set([
  // The support widget authenticates each request with its explicit 64-byte
  // widget token. It must remain usable inside an authenticated AskSales
  // browser, where unrelated session cookies would otherwise trigger CSRF.
  "/api/support-widget/chat",
]);
const TOKEN_WEBHOOK_PATH = /^\/api\/webhooks\/(?:user|instagram|facebook|whatsapp|twitter|linkedin|email|leads|automation)\/[^/]+$/;
// Read-only PDF download authenticates BOTH explicit widget and session tokens
// in the request body, never an ambient owner cookie. Keep this route exact;
// document management and widget-token generation remain CSRF protected.
const WIDGET_DOCUMENT_DOWNLOAD_PATH = /^\/api\/support-widget\/session\/[1-9]\d*\/messages\/[1-9]\d*\/documents\/[1-9]\d*$/;
const WIDGET_CUSTOMER_FEEDBACK_PATH = /^\/api\/support-widget\/session\/[1-9]\d*\/feedback$/;

function isBearerAuth(req: Request): boolean {
  const auth = req.headers["authorization"] ?? "";
  return typeof auth === "string" && auth.startsWith("Bearer ");
}

function isExternalWebhookPath(path: string): boolean {
  return EXTERNAL_WEBHOOK_PATHS.has(path) || TOKEN_WEBHOOK_PATH.test(path)
    || /^\/api\/webhooks\/razorpay\/subscriptions\/[1-9]\d*$/.test(path);
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function setCsrfCookie(res: Response, value: string): void {
  const parts = [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    "Max-Age=86400",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getCookieToken(req: Request): string | undefined {
  // If cookie-parser or another middleware already populated req.cookies,
  // use that. Otherwise fall back to manual parsing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromParsed = (req as any).cookies?.[CSRF_COOKIE_NAME];
  if (typeof fromParsed === "string") return fromParsed;
  const header = typeof req.headers.cookie === "string" ? req.headers.cookie : undefined;
  return parseCookieHeader(header)[CSRF_COOKIE_NAME];
}

/**
 * Always-on middleware:
 *  - SAFE methods: ensure the cookie is set
 *  - UNSAFE methods: require header == cookie (unless Bearer-authenticated)
 *
 * Mount this AFTER the CORS middleware (so CORS preflights succeed) and
 * AFTER body parsers so the header check is the last thing that runs.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  try {
    if (SAFE_METHODS.has(req.method)) {
      const existing = getCookieToken(req);
      if (!existing) setCsrfCookie(res, crypto.randomBytes(32).toString("hex"));
      return next();
    }

    // Webhooks, external callbacks, and public token-authenticated endpoints:
    // skip because they do not rely on ambient cookie authentication.
    if (isExternalWebhookPath(req.path) || PUBLIC_TOKEN_AUTHENTICATED_PATHS.has(req.path)
      || (req.method === 'POST' && (WIDGET_DOCUMENT_DOWNLOAD_PATH.test(req.path)
        || WIDGET_CUSTOMER_FEEDBACK_PATH.test(req.path)
        || req.path === '/api/support-widget/installed'))) {
      return next();
    }

    // Bearer-authenticated requests don't need CSRF check
    if (isBearerAuth(req)) {
      return next();
    }

    // For cookie-based sessions, enforce double-submit
    const cookieToken = getCookieToken(req);
    const headerToken = req.headers[CSRF_HEADER_NAME];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      logger.warn(
        { method: req.method, path: req.path, hasCookie: !!cookieToken, hasHeader: !!headerToken },
        "[csrf] rejected request"
      );
      res.status(403).json({ message: "CSRF token missing or mismatched" });
      return;
    }

    // Token looks valid — rotate to prevent fixation
    setCsrfCookie(res, crypto.randomBytes(32).toString("hex"));
    next();
  } catch (err) {
    logger.error({ err }, "[csrf] middleware error");
    res.status(500).json({ message: "CSRF check failed" });
  }
}
