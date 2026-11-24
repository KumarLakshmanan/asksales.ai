import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { getRedisConnection } from "../infrastructure/redis.js";
import { requireBusinessScope, withBusinessScope } from "./businessContext.js";
import { resolveBusinessScope } from "./businessScopeResolver.js";

const key = (state: string) =>
  `oauth:business:${createHash("sha256").update(state).digest("hex")}`;

/** Bind the exact provider state to its initiating business independently of
 * provider-specific HMAC/nonce verification. Those checks still run normally. */
export async function rememberOAuthBusinessState(
  state: string,
): Promise<string> {
  const scope = requireBusinessScope();
  if (
    scope.actorUserId &&
    scope.actorUserId !== scope.userId &&
    scope.role !== "billing_admin"
  )
    throw new Error(
      "Only the business owner or billing admin can connect accounts.",
    );
  await getRedisConnection().set(
    key(state),
    JSON.stringify(scope),
    "EX",
    15 * 60,
  );
  return state;
}

type OAuthScopeFailure = 'invalid_or_expired_state' | 'permission_changed' | 'oauth_unavailable';

/** Gmail consumes the binding atomically before exchanging a code. Other
 * providers retain their existing nonce-consumption contracts. */
export function consumeOAuthBusinessScope(
  onFailure: (res: Response, code: OAuthScopeFailure) => unknown,
) {
  return (req: Request, res: Response, next: NextFunction) =>
    restoreOAuthBusinessScope(req, res, next, onFailure);
}

export async function oauthBusinessScope(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  return restoreOAuthBusinessScope(req, res, next);
}

async function restoreOAuthBusinessScope(
  req: Request,
  res: Response,
  next: NextFunction,
  onFailure?: (res: Response, code: OAuthScopeFailure) => unknown,
) {
  const state = req.query.state;
  if (typeof state !== "string" || !state) return next(); // Existing handler reports provider cancellation/errors.
  try {
    const redis = getRedisConnection();
    // Lua supports Redis versions before GETDEL and serializes concurrent callbacks.
    const binding = onFailure
      ? await redis.eval("local v = redis.call('GET', KEYS[1]); redis.call('DEL', KEYS[1]); return v", 1, key(state)) as string | null
      : await redis.get(key(state));
    if (!binding) {
      if (onFailure) return onFailure(res, 'invalid_or_expired_state');
      return res
        .status(400)
        .send(
          "This connection session has expired. Return to the business and connect again.",
        );
    }
    const saved = JSON.parse(binding) as {
      userId: number;
      businessProfileId: number;
      actorUserId?: number;
    };
    const scope = await resolveBusinessScope(
      saved.actorUserId ?? saved.userId,
      saved.businessProfileId,
    );
    if (
      !scope ||
      scope.userId !== saved.userId ||
      !["owner", "billing_admin"].includes(scope.role ?? "owner")
    ) {
      if (onFailure) return onFailure(res, 'permission_changed');
      return res
        .status(403)
        .send("The business or connection permission is no longer available.");
    }
    req.businessProfileId = scope.businessProfileId;
    return withBusinessScope(scope, next);
  } catch (error) {
    if (onFailure) return onFailure(res, 'oauth_unavailable');
    return next(error);
  }
}
