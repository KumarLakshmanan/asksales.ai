import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { withSystemScope, currentBusinessScope } from '../../tenancy/businessContext.js';

/**
 * RLS-safe transaction wrapper. SET LOCAL is scoped to the checked-out
 * connection and is automatically cleared on commit/rollback.
 */
export async function withTenantKnowledgeTransaction<T>(
  userId: number,
  callback: (tx: typeof db) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('A valid tenant user ID is required.');
  const scope = currentBusinessScope();
  if (scope && scope.userId !== userId) throw new Error('Knowledge account does not match the selected business');
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${String(userId)}, true)`);
    return callback(tx);
  });
}

export async function withKnowledgeAdminTransaction<T>(
  callback: (tx: typeof db) => Promise<T>,
): Promise<T> {
  if (currentBusinessScope()) return db.transaction(callback);
  return withSystemScope('Knowledge administration', () => db.transaction(callback));
}
