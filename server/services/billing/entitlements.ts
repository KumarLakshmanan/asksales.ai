import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { LIMIT_DEFINITIONS, UNLIMITED_LIMITS, type LimitKey, type OrganizationEntitlements } from '../../../shared/subscriptions.js';

export interface CapacityExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type CapacityFailure = {
  code: 'PLAN_LIMIT_EXCEEDED';
  resource: LimitKey;
  current: number;
  requestedIncrease: number;
  limit: number;
  organizationId: number;
};

export class PlanLimitError extends Error {
  readonly status = 403;
  readonly code = 'PLAN_LIMIT_EXCEEDED' as const;
  readonly resource: LimitKey;
  readonly current: number;
  readonly requestedIncrease: number;
  readonly limit: number;
  readonly organizationId: number;

  constructor(failure: CapacityFailure) {
    const label = LIMIT_DEFINITIONS.find(item => item.key === failure.resource)?.label || failure.resource;
    super(`${label} limit reached. Free capacity or ask your organization billing admin to change the plan.`);
    this.name = 'PlanLimitError';
    this.resource = failure.resource;
    this.current = failure.current;
    this.requestedIncrease = failure.requestedIncrease;
    this.limit = failure.limit;
    this.organizationId = failure.organizationId;
  }

  toJSON() {
    return { error: this.message, message: this.message, code: this.code, resource: this.resource, current: this.current,
      requestedIncrease: this.requestedIncrease, limit: this.limit, organizationId: this.organizationId };
  }
}

/** Drizzle wraps the PostgreSQL error; preserve its structured detail. */
export function normalizeCapacityError(error: unknown): PlanLimitError | null {
  const visited = new Set<unknown>();
  let value = error;
  while (value && typeof value === 'object' && !visited.has(value)) {
    if (value instanceof PlanLimitError) return value;
    visited.add(value);
    const candidate = value as { detail?: unknown; cause?: unknown };
    try {
      const detail = typeof candidate.detail === 'string' ? JSON.parse(candidate.detail) : candidate.detail;
      if (detail && typeof detail === 'object' && detail.code === 'PLAN_LIMIT_EXCEEDED'
        && LIMIT_DEFINITIONS.some(item => item.key === detail.resource)
        && ['current', 'requestedIncrease', 'limit', 'organizationId'].every(key => Number.isSafeInteger(detail[key]) && detail[key] >= 0)) {
        return new PlanLimitError(detail as CapacityFailure);
      }
    } catch { /* Another database error may have non-JSON diagnostic detail. */ }
    value = candidate.cause;
  }
  return null;
}

function validOrganizationId(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid billing organization is required');
}

/** Call after organization membership is authorized. Returns aggregate counts only. */
export async function getOrganizationEntitlements(organizationId: number, executor: CapacityExecutor = db): Promise<OrganizationEntitlements> {
  validOrganizationId(organizationId);
  const result = await executor.execute(sql`SELECT billing_organization_entitlements(${organizationId}) AS entitlement`);
  const value = result.rows[0]?.entitlement as Partial<OrganizationEntitlements> | undefined;
  if (!value) throw new Error('Organization entitlements are not available');
  return {
    limits: { ...UNLIMITED_LIMITS, ...value.limits },
    usage: Object.fromEntries(LIMIT_DEFINITIONS.map(({ key }) => [key, Number(value.usage?.[key] || 0)])) as OrganizationEntitlements['usage'],
    enforced: Boolean(value.enforced),
    catalogVersion: value.catalogVersion ?? null,
    planSlug: value.planSlug ?? null,
  };
}

export type StorageCapacityReservation = { id: string; businessProfileId: number; userId: number };

/** Uploads must be associated with the persisted business, never a UI selector. */
export async function reserveOrganizationStorage(userId: number, bytes: number): Promise<StorageCapacityReservation> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Storage bytes must be a nonnegative integer');
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== userId) throw new Error('A business profile is required to reserve file storage');
  try {
    const result = await db.execute(sql`SELECT billing_reserve_storage(${scope.businessProfileId},${userId},${bytes}) AS id`);
    const id = result.rows[0]?.id;
    if (typeof id !== 'string') throw new Error('Storage reservation was not created');
    return { id, businessProfileId: scope.businessProfileId, userId };
  } catch (error) { throw normalizeCapacityError(error) || error; }
}

export async function releaseOrganizationStorage(reservation: StorageCapacityReservation, executor: CapacityExecutor = db): Promise<void> {
  await executor.execute(sql`SELECT billing_release_storage(${reservation.id}::uuid,${reservation.businessProfileId},${reservation.userId})`);
}

/** Storage screens show the organization budget, with their existing file list
 * still filtered by the business's permissions. */
export async function storageOrganizationEntitlements(userId: number): Promise<(OrganizationEntitlements & { fileCount: number }) | null> {
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== userId) return null;
  const result = await db.execute(sql`SELECT billing_organization_id AS id FROM company_settings WHERE id=${scope.businessProfileId} AND user_id=${userId}`);
  const organizationId = Number(result.rows[0]?.id);
  if (!organizationId) return null;
  const entitlement = await getOrganizationEntitlements(organizationId);
  const counts = await db.execute(sql`SELECT count(*)::integer AS files FROM billing_capacity_items
    WHERE organization_id=${organizationId} AND source_table='storage_files'`);
  return { ...entitlement, fileCount: Number(counts.rows[0]?.files || 0) };
}

export async function getCapacityReconciliation(organizationId: number, executor: CapacityExecutor = db): Promise<unknown[]> {
  validOrganizationId(organizationId);
  const result = await executor.execute(sql`SELECT billing_capacity_reconciliation(${organizationId}) AS mismatches`);
  return (result.rows[0]?.mismatches as unknown[]) || [];
}
