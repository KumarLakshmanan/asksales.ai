import { currentBusinessScope } from '../../../tenancy/businessContext.js';
import { supportAdminAuditLogsTable } from '../../../models/supportOrchestration/schema.js';

export interface SupportAdminAuditInput {
  userId: number;
  actorType: 'business_staff' | 'owner' | 'support_member' | 'system' | 'platform_admin';
  actorId?: number | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
}

interface AuditInsertExecutor {
  insert(table: typeof supportAdminAuditLogsTable): {
    values(values: typeof supportAdminAuditLogsTable.$inferInsert): {
      returning(selection: { id: typeof supportAdminAuditLogsTable.id }): Promise<Array<{ id: number }>>;
    };
  };
}

export async function recordSupportAdminAudit(
  executor: AuditInsertExecutor,
  input: SupportAdminAuditInput,
) {
  const jsonSnapshot = (value: unknown): Record<string, unknown> | null => {
    if (value == null) return null;
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  };
  const scope = currentBusinessScope();
  const staffActor = input.actorType === 'owner' && scope?.userId === input.userId && scope.actorUserId && scope.actorUserId !== scope.userId ? scope.actorUserId : null;
  const [record] = await executor.insert(supportAdminAuditLogsTable).values({
    userId: input.userId,
    actorType: staffActor ? 'business_staff' : input.actorType,
    actorId: staffActor ?? input.actorId ?? null,
    action: input.action.slice(0, 80),
    entityType: input.entityType.slice(0, 80),
    entityId: input.entityId == null ? null : String(input.entityId).slice(0, 120),
    beforeState: jsonSnapshot(input.beforeState),
    afterState: jsonSnapshot(input.afterState),
    metadata: input.metadata || {},
  }).returning({ id: supportAdminAuditLogsTable.id });
  return record;
}
