import { AsyncLocalStorage } from "node:async_hooks";

/** Payment responsibility is independent of the owner of business records.
 * Callers must authorize an organization before entering this scope. */
export interface BillingScope {
  organizationId: number;
  actorUserId: number;
  /** Validated business identity retained during narrowly scoped billing aggregates. */
  businessProfileId?: number;
  businessOwnerUserId?: number;
}

const context = new AsyncLocalStorage<Readonly<BillingScope>>();

export function currentBillingScope(): Readonly<BillingScope> | undefined {
  return context.getStore();
}

export function withBillingScope<T>(scope: BillingScope, work: () => T): T {
  if (
    ![scope.organizationId, scope.actorUserId].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    )
  ) {
    throw new Error("Invalid billing organization scope");
  }
  return context.run(Object.freeze({ ...scope }), work);
}
