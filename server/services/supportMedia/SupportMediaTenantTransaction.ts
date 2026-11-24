import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

export async function withTenantSupportMediaTransaction<T>(
  userId: number,
  callback: (tx: typeof db) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('A valid tenant user ID is required.');
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${String(userId)}, true)`);
    return callback(tx);
  });
}

