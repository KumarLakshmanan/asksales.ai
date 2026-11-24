import { db } from "../db";
import { adminsTable, type AdminRecord, type InsertAdmin } from "./schema";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

async function requireLifecycleActor(tx: typeof db, actorId?: number) {
  const [actor] = actorId ? await tx.select({ role: adminsTable.role }).from(adminsTable)
    .where(eq(adminsTable.id, actorId)).limit(1) : [];
  if (actor?.role !== 'super_admin') {
    throw Object.assign(new Error('Super admin access required'), { status: 403 });
  }
}

async function preserveSuperAdmin(tx: typeof db, id: number) {
  const [target] = await tx.select({ role: adminsTable.role }).from(adminsTable)
    .where(eq(adminsTable.id, id)).limit(1);
  if (target?.role === 'super_admin') {
    const remaining = await tx.select({ id: adminsTable.id }).from(adminsTable)
      .where(eq(adminsTable.role, 'super_admin'));
    if (remaining.length <= 1) {
      throw Object.assign(new Error('The last super admin cannot be removed or demoted'), { status: 409 });
    }
  }
}

export async function getAdminById(id: number): Promise<AdminRecord | undefined> {
  const result = await db.select().from(adminsTable).where(eq(adminsTable.id, id)).limit(1);
  return result[0];
}

export async function getAdminByEmail(email: string): Promise<AdminRecord | undefined> {
  const result = await db.select().from(adminsTable).where(eq(adminsTable.email, email)).limit(1);
  return result[0];
}

export async function createAdmin(admin: InsertAdmin): Promise<AdminRecord> {
  const result = await db.insert(adminsTable).values(admin).returning();
  return result[0];
}

/** Consume the compared, still-valid grant once without overwriting another winner. */
export async function consumeAdminPasswordReset(id: number, observedHash: string, password: string): Promise<AdminRecord | undefined> {
  return db.transaction(async (tx: typeof db) => {
    const grant = and(eq(adminsTable.id, id), eq(adminsTable.resetPasswordToken, observedHash));
    const [locked] = await tx.select({ id: adminsTable.id }).from(adminsTable).where(grant).for('update');
    if (!locked) return undefined;
    const [admin] = await tx.update(adminsTable).set({
      password, resetPasswordToken: null, resetPasswordTokenExpiry: null,
      passwordChangedAt: new Date(), updatedAt: new Date(),
    }).where(and(grant,
      // Preserve existing missing-expiry compatibility pending an explicit policy.
      // Check deadlines after acquiring the row lock, including any lock wait.
      or(isNull(adminsTable.resetPasswordTokenExpiry),
        gt(adminsTable.resetPasswordTokenExpiry, sql`clock_timestamp()`)),
    )).returning();
    return admin;
  });
}

export async function updateAdmin(id: number, admin: Partial<InsertAdmin>, actorId?: number): Promise<AdminRecord | undefined> {
  const update = async (tx: typeof db) => {
    const result = await tx.update(adminsTable).set({ ...admin, updatedAt: new Date() })
      .where(eq(adminsTable.id, id)).returning();
    return result[0];
  };
  if (admin.role === undefined && actorId === undefined) return update(db);
  if (admin.role !== undefined && !['admin', 'super_admin'].includes(admin.role)) {
    throw Object.assign(new Error('Invalid administrator role'), { status: 400 });
  }
  return db.transaction(async (tx: typeof db) => {
    // Role changes and deletions share this transaction-scoped lock. Recheck
    // the actor after waiting: their middleware snapshot may now be stale.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(740323,1)`);
    await requireLifecycleActor(tx, actorId);
    if (admin.role !== undefined && admin.role !== 'super_admin') await preserveSuperAdmin(tx, id);
    return update(tx);
  });
}

export async function deleteAdmin(id: number, actorId?: number): Promise<boolean> {
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(740323,1)`);
    await requireLifecycleActor(tx, actorId);
    if (id === actorId) throw Object.assign(new Error('Cannot delete your own admin account'), { status: 400 });
    await preserveSuperAdmin(tx, id);
    const result = await tx.delete(adminsTable).where(eq(adminsTable.id, id)).returning({ id: adminsTable.id });
    return result.length > 0;
  });
}

export async function getAllAdmins(): Promise<AdminRecord[]> {
  return await db.select().from(adminsTable);
}
