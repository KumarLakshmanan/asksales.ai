import { db } from "../db";
import { campaignsTable, type CampaignRecord, type InsertCampaign } from "./schema";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { and, eq } from "drizzle-orm";

export class CampaignModel {
  static async findAll(filter?: { userId?: number }): Promise<CampaignRecord[]> {
    if (filter?.userId !== undefined) {
      return await db
        .select()
        .from(campaignsTable)
        .where(eq(campaignsTable.userId, filter.userId));
    }
    return await db.select().from(campaignsTable);
  }

  static async findById(id: number): Promise<CampaignRecord | undefined> {
    const result = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).limit(1);
    return result[0];
  }

  static async findByIdForUser(id: number, userId: number): Promise<CampaignRecord | undefined> {
    const result = await db.select().from(campaignsTable).where(and(
      eq(campaignsTable.id, id),
      eq(campaignsTable.userId, userId),
    )).limit(1);
    return result[0];
  }

  static async create(data: InsertCampaign): Promise<CampaignRecord> {
    const result = await db.insert(campaignsTable).values(data).returning();
    return result[0];
  }

  static async update(id: number, data: Partial<InsertCampaign>): Promise<CampaignRecord | undefined> {
    const result = await db.update(campaignsTable).set(data).where(eq(campaignsTable.id, id)).returning();
    return result[0];
  }

  static async updateForUser(
    id: number,
    userId: number,
    data: Partial<InsertCampaign>,
  ): Promise<CampaignRecord | undefined> {
    const result = await db.update(campaignsTable).set(data).where(and(
      eq(campaignsTable.id, id),
      eq(campaignsTable.userId, userId),
    )).returning();
    return result[0];
  }

  static async delete(id: number): Promise<void> {
    await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  }
}
