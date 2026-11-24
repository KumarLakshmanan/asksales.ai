import { db } from "../db";
import { userPreferences, type UserPreferences, type NewUserPreferences } from "./schema";
import { eq } from "drizzle-orm";

export async function getUserPreferencesByUserId(userId: number): Promise<UserPreferences | undefined> {
  const [prefs] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
  return prefs;
}

export async function updateUserPreferences(userId: number, data: Partial<NewUserPreferences>): Promise<UserPreferences> {
  const [prefs] = await db
    .update(userPreferences)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(userPreferences.userId, userId))
    .returning();
  return prefs;
}

export async function upsertUserPreferences(userId: number, data: Partial<NewUserPreferences>, executor: Pick<typeof db, 'insert'> = db): Promise<UserPreferences> {
  const values = { ...data, userId, updatedAt: new Date() };
  const [prefs] = await executor
    .insert(userPreferences)
    .values(values)
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { ...data, updatedAt: values.updatedAt },
    })
    .returning();
  return prefs;
}
