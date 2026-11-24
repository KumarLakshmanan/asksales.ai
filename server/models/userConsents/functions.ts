import { db } from "../db.js";
import { eq, and, desc } from "drizzle-orm";
import { userConsentsTable, type NewUserConsent, type UserConsent } from "./schema.js";

export async function createUserConsent(input: NewUserConsent, executor: Pick<typeof db, 'insert'> = db): Promise<UserConsent> {
  const [row] = await executor.insert(userConsentsTable).values(input).returning();
  return row;
}

export async function getLatestConsent(
  userId: number,
  consentType: string
): Promise<UserConsent | undefined> {
  const [row] = await db
    .select()
    .from(userConsentsTable)
    .where(and(eq(userConsentsTable.userId, userId), eq(userConsentsTable.consentType, consentType)))
    .orderBy(desc(userConsentsTable.createdAt))
    .limit(1);
  return row;
}

export async function listConsentsForUser(userId: number): Promise<UserConsent[]> {
  return db
    .select()
    .from(userConsentsTable)
    .where(eq(userConsentsTable.userId, userId))
    .orderBy(desc(userConsentsTable.createdAt));
}
