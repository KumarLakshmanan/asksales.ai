import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { CrmConfigurationError } from './CRMConfigurationService.js';

export async function getCrmAssignees(userId: number, executor: any = db) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new CrmConfigurationError('Business profile not found.', 404);
  const result = await executor.execute(sql`SELECT DISTINCT u.id, COALESCE(NULLIF(u.name, ''),u.email) AS name,u.email,
    CASE WHEN u.id=${userId} THEN 'owner' ELSE m.role END AS role
    FROM users u LEFT JOIN business_profile_memberships m ON m.user_id=u.id
      AND m.business_profile_id=${scope.businessProfileId} AND m.status='active'
    WHERE u.deleted_at IS NULL AND (u.id=${userId} OR m.id IS NOT NULL) ORDER BY name,u.id`);
  return result.rows as Array<{ id: number; name: string; email: string; role: string }>;
}

export async function validateCrmAssignee(userId: number, assignedTo: number | null | undefined, executor: any = db) {
  if (assignedTo === undefined || assignedTo === null) return;
  const scope = requireBusinessScope();
  if (!Number.isSafeInteger(assignedTo) || assignedTo <= 0 || scope.userId !== userId)
    throw new CrmConfigurationError('Choose an active member of this business.', 400);
  const result = await executor.execute(sql`SELECT u.id FROM users u
    WHERE u.id=${assignedTo} AND u.deleted_at IS NULL AND (u.id=${userId} OR EXISTS (
      SELECT 1 FROM business_profile_memberships member WHERE member.business_profile_id=${scope.businessProfileId}
        AND member.user_id=u.id AND member.status='active')) LIMIT 1`);
  if (!result.rows.length) throw new CrmConfigurationError('Choose an active member of this business.', 400);
}
