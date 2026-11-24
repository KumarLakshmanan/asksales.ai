import { db } from "../db";
import { leadGenCampaignsTable, type LeadGenCampaignRecord, type InsertLeadGenCampaign } from "./schema";
import { eq } from "drizzle-orm";

export class LeadGenCampaignModel {
  static async findAll(): Promise<LeadGenCampaignRecord[]> {
    return await db.select().from(leadGenCampaignsTable);
  }

  static async findById(id: number): Promise<LeadGenCampaignRecord | undefined> {
    const result = await db.select().from(leadGenCampaignsTable).where(eq(leadGenCampaignsTable.id, id)).limit(1);
    return result[0];
  }

  static async create(data: InsertLeadGenCampaign): Promise<LeadGenCampaignRecord> {
    const result = await db.insert(leadGenCampaignsTable).values(data).returning();
    return result[0];
  }

  static async update(id: number, data: Partial<InsertLeadGenCampaign>): Promise<LeadGenCampaignRecord | undefined> {
    const result = await db.update(leadGenCampaignsTable).set(data).where(eq(leadGenCampaignsTable.id, id)).returning();
    return result[0];
  }

  static async delete(id: number): Promise<void> {
    await db.delete(leadGenCampaignsTable).where(eq(leadGenCampaignsTable.id, id));
  }
}
