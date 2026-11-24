import type { Request, Response } from "express";

export const AUTH_COOKIES = {
  user: "asksales_session",
  admin: "asksales_admin_session",
  support: "asksales_support_session",
} as const;

export type AuthCookieName = typeof AUTH_COOKIES[keyof typeof AUTH_COOKIES];

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function setAuthCookie(res: Response, name: AuthCookieName, token: string): void {
  res.cookie(name, token, cookieOptions());
}

export function clearAuthCookie(res: Response, name: AuthCookieName): void {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(name, options);
}

export function readAuthCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(/;\s*/)) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1));
    } catch {
      return part.slice(separator + 1);
    }
  }
  return undefined;
}
