import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";

export type BusinessRole = "owner" | "billing_admin" | "member";

export interface BusinessScope {
  kind: "business";
  userId: number;
  businessProfileId: number;
  /** The signed-in person. userId remains the durable owner of business rows. */
  actorUserId?: number;
  role?: BusinessRole;
}
export type DatabaseScope = BusinessScope | { kind: "system"; reason: string };
const context = new AsyncLocalStorage<DatabaseScope | undefined>();
// Start lazy Drizzle thenables before the active scope is left.
function startScopedWork<T>(work: () => T): T {
  const result = work();
  return result && typeof (result as { then?: unknown }).then === "function"
    ? (Promise.resolve(result) as T)
    : result;
}

export function currentDatabaseScope(): DatabaseScope | undefined {
  return context.getStore();
}
export function currentBusinessScope(): BusinessScope | undefined {
  const scope = context.getStore();
  return scope?.kind === "business" ? scope : undefined;
}
export function requireBusinessScope(): BusinessScope {
  const scope = currentBusinessScope();
  if (!scope)
    throw new Error("A business profile is required for this operation");
  return scope;
}
export function withBusinessScope<T>(
  scope: Omit<BusinessScope, "kind">,
  work: () => T,
): T {
  if (
    ![
      scope.userId,
      scope.businessProfileId,
      scope.actorUserId ?? scope.userId,
    ].every((id) => Number.isSafeInteger(id) && id > 0)
  ) {
    throw new Error("Invalid business profile scope");
  }
  return context.run(Object.freeze({ ...scope, kind: "business" }), () =>
    startScopedWork(work),
  );
}

/** Use only for business record ownership, never for authentication, personal
 * account settings, membership permissions or the actor recorded in an audit. */
export function businessOwnerUserId(req: Pick<Request, "user">): number {
  const actor = req.user?.id;
  const scope = currentBusinessScope();
  if (!scope) return actor ?? 0;
  if (actor !== (scope.actorUserId ?? scope.userId))
    throw new Error("Business actor does not match the authenticated account");
  return scope.userId;
}

export function isBusinessOwner(req: Pick<Request, "user">): boolean {
  const scope = currentBusinessScope();
  return Boolean(req.user?.id && (!scope || req.user.id === scope.userId));
}

/** Defense in depth for configuration services also called without HTTP. */
export function assertBusinessConfigurationOwner(ownerUserId: number): void {
  const scope = currentBusinessScope();
  if (scope && (scope.userId !== ownerUserId || (scope.actorUserId ?? scope.userId) !== scope.userId)) {
    throw new Error('Only the business owner can change AI policy configuration');
  }
}
/** For authenticated administrators or narrow inventory/token lookups only.
 * Business processing must re-enter the record's persisted scope. */
export function withSystemScope<T>(reason: string, work: () => T): T {
  if (!reason.trim())
    throw new Error("System database access requires a reason");
  return context.run(Object.freeze({ kind: "system", reason }), () =>
    startScopedWork(work),
  );
}

export function businessCacheKey(key: string): string {
  const scope = requireBusinessScope();
  return `${scope.userId}:${scope.businessProfileId}:${key}`;
}

/** Actor attribution for business services also invoked without an HTTP request. */
export function businessAuditActor(ownerUserId: number): number {
  const scope = currentBusinessScope();
  return scope?.userId === ownerUserId
    ? (scope.actorUserId ?? ownerUserId)
    : ownerUserId;
}

/** Signup and creation of an independently owned business have account scope. */
export function withAccountScope<T>(work: () => T): T {
  return context.run(undefined, () => startScopedWork(work));
}
