import { db } from "../db";
import { leadSettings, type LeadSettings, type NewLeadSettings } from "./schema";
import { eq } from "drizzle-orm";

export async function getLeadSettingsByUserId(userId: number): Promise<LeadSettings | undefined> {
  const [settings] = await db.select().from(leadSettings).where(eq(leadSettings.userId, userId));
  return settings;
}

export async function updateLeadSettings(userId: number, data: Partial<NewLeadSettings>): Promise<LeadSettings> {
  const [settings] = await db
    .update(leadSettings)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(leadSettings.userId, userId))
    .returning();
  return settings;
}

export async function upsertLeadSettings(userId: number, data: Partial<NewLeadSettings>): Promise<LeadSettings> {
  const values = { ...data, userId, updatedAt: new Date() };
  const [settings] = await db
    .insert(leadSettings)
    .values(values)
    .onConflictDoUpdate({
      target: [leadSettings.businessProfileId, leadSettings.userId],
      set: { ...data, updatedAt: values.updatedAt },
    })
    .returning();
  return settings;
}
