import { db } from "../db";
import { usersTable, type UserRecord, type InsertUser } from "./schema";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

export async function getUserById(id: number): Promise<UserRecord | undefined> {
  const result = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  return result[0];
}

export async function getUserByEmail(email: string): Promise<UserRecord | undefined> {
  const result = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  return result[0];
}

export async function getUserByGoogleSub(sub: string): Promise<UserRecord | undefined> {
  const result = await db.select().from(usersTable).where(eq(usersTable.googleSub, sub)).limit(1);
  return result[0];
}

export async function getUserByVerificationToken(token: string): Promise<UserRecord | undefined> {
  const result = await db.select().from(usersTable).where(eq(usersTable.verificationToken, token)).limit(1);
  return result[0];
}

export async function createUser(user: InsertUser): Promise<UserRecord> {
  const result = await db.insert(usersTable).values(user).returning();
  return result[0];
}

export async function updateUser(id: number, user: Partial<InsertUser>): Promise<UserRecord | undefined> {
  const result = await db.update(usersTable).set({
    ...user,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, id)).returning();
  return result[0];
}

/** Consume only the still-current, unexpired code. Concurrent consumers and
 * a code replaced by resend cannot overwrite the winning password. */
export async function consumeUserPasswordReset(id: number, observedHash: string, password: string): Promise<UserRecord | undefined> {
  const [user] = await db.update(usersTable).set({
    password, resetPasswordToken: null, resetPasswordTokenExpiry: null,
    passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null,
    updatedAt: new Date(),
  }).where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt),
    eq(usersTable.resetPasswordToken, observedHash),
    gt(usersTable.resetPasswordTokenExpiry, sql`clock_timestamp()`))).returning();
  return user;
}

/** Verification is also single-use, including when two HTTP requests compared
 * the same bcrypt hash before either request reached this write. */
export async function consumeUserVerification(id: number, observedHash: string): Promise<UserRecord | undefined> {
  const [user] = await db.update(usersTable).set({
    isVerified: true, verificationToken: null, verificationTokenExpiry: null,
    updatedAt: new Date(),
  }).where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt), eq(usersTable.isVerified, false),
    eq(usersTable.verificationToken, observedHash),
    gt(usersTable.verificationTokenExpiry, sql`clock_timestamp()`))).returning();
  return user;
}

/** PostgreSQL serializes these increments; stale parallel reads cannot lose
 * attempts or revive a counter belonging to a replaced password. */
export async function recordFailedUserLogin(id: number, observedPassword: string | null): Promise<void> {
  await db.update(usersTable).set({
    failedLoginAttempts: sql`CASE WHEN ${usersTable.lockedUntil} <= clock_timestamp()
      THEN 1 ELSE ${usersTable.failedLoginAttempts} + 1 END`,
    lockedUntil: sql`CASE WHEN ${usersTable.lockedUntil} <= clock_timestamp() THEN NULL
      WHEN ${usersTable.failedLoginAttempts} + 1 >= 5 THEN clock_timestamp() + interval '15 minutes' ELSE NULL END`,
    updatedAt: new Date(),
  }).where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt),
    observedPassword === null ? isNull(usersTable.password) : eq(usersTable.password, observedPassword),
    or(isNull(usersTable.lockedUntil), sql`${usersTable.lockedUntil} <= clock_timestamp()`)));
}

export async function completeUserPasswordLogin(id: number, observedPassword: string): Promise<UserRecord | undefined> {
  const [user] = await db.update(usersTable).set({ failedLoginAttempts: 0, lockedUntil: null,
    lastLoginAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(usersTable.id, id), eq(usersTable.password, observedPassword),
    isNull(usersTable.deletedAt), eq(usersTable.isVerified, true),
    or(isNull(usersTable.lockedUntil), sql`${usersTable.lockedUntil} <= clock_timestamp()`))).returning();
  return user;
}

export async function deleteUser(id: number): Promise<boolean> {
  const result = await db.delete(usersTable).where(eq(usersTable.id, id)).returning({ id: usersTable.id });
  return result.length > 0;
}

export async function getAllUsers(): Promise<UserRecord[]> {
  return await db.select().from(usersTable);
}
