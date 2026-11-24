import { db } from "../db";
import { companyProfilesTable, type CompanyProfileRecord, type InsertCompanyProfile } from "./schema";
import { eq } from "drizzle-orm";

export async function getCompanyProfile(id: number): Promise<CompanyProfileRecord | undefined> {
  const result = await db.select().from(companyProfilesTable).where(eq(companyProfilesTable.id, id)).limit(1);
  return result[0];
}

export async function getCompanyProfileByUserId(userId: number): Promise<CompanyProfileRecord | undefined> {
  const result = await db.select().from(companyProfilesTable).where(eq(companyProfilesTable.userId, userId)).limit(1);
  return result[0];
}

export async function createCompanyProfile(profile: InsertCompanyProfile): Promise<CompanyProfileRecord> {
  const result = await db.insert(companyProfilesTable).values(profile).returning();
  return result[0];
}

export async function updateCompanyProfile(id: number, profile: Partial<InsertCompanyProfile>): Promise<CompanyProfileRecord | undefined> {
  const result = await db.update(companyProfilesTable)
    .set({ ...profile, updatedAt: new Date() })
    .where(eq(companyProfilesTable.id, id))
    .returning();
  return result[0];
}

export async function deleteCompanyProfile(id: number): Promise<void> {
  await db.delete(companyProfilesTable).where(eq(companyProfilesTable.id, id));
}
