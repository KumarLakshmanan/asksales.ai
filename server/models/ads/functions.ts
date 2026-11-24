import { db } from "../db";
import { adsTable, type AdRecord, type InsertAd } from "./schema";
import { campaignsTable } from "../campaigns/schema";
import { and, eq, sql } from "drizzle-orm";

export async function userOwnsAdCampaign(userId: number, campaignId: number): Promise<boolean> {
  const [campaign] = await db.select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)))
    .limit(1);
  return Boolean(campaign);
}

export async function getAd(id: number, userId: number): Promise<AdRecord | undefined> {
  const result = await db.select({ ad: adsTable })
    .from(adsTable)
    .innerJoin(campaignsTable, eq(adsTable.campaignId, campaignsTable.id))
    .where(and(eq(adsTable.id, id), eq(campaignsTable.userId, userId)))
    .limit(1);
  return result[0]?.ad;
}

export async function getAds(userId: number): Promise<AdRecord[]> {
  const result = await db.select({ ad: adsTable })
    .from(adsTable)
    .innerJoin(campaignsTable, eq(adsTable.campaignId, campaignsTable.id))
    .where(eq(campaignsTable.userId, userId));
  return result.map((row: { ad: AdRecord }) => row.ad);
}

export async function getAdsByCampaignId(campaignId: number, userId: number): Promise<AdRecord[]> {
  const result = await db.select({ ad: adsTable })
    .from(adsTable)
    .innerJoin(campaignsTable, eq(adsTable.campaignId, campaignsTable.id))
    .where(and(eq(adsTable.campaignId, campaignId), eq(campaignsTable.userId, userId)));
  return result.map((row: { ad: AdRecord }) => row.ad);
}

export async function createAd(ad: InsertAd): Promise<AdRecord> {
  const result = await db.insert(adsTable).values(ad).returning();
  return result[0];
}

export async function updateAd(id: number, userId: number, ad: Partial<InsertAd>): Promise<AdRecord | undefined> {
  const result = await db.update(adsTable).set({ ...ad, updatedAt: new Date() }).where(and(
    eq(adsTable.id, id),
    sql`EXISTS (
      SELECT 1 FROM ${campaignsTable}
      WHERE ${campaignsTable.id} = ${adsTable.campaignId}
        AND ${campaignsTable.userId} = ${userId}
    )`,
  )).returning();
  return result[0];
}

export async function deleteAd(id: number, userId: number): Promise<boolean> {
  const deleted = await db.delete(adsTable).where(and(
    eq(adsTable.id, id),
    sql`EXISTS (
      SELECT 1 FROM ${campaignsTable}
      WHERE ${campaignsTable.id} = ${adsTable.campaignId}
        AND ${campaignsTable.userId} = ${userId}
    )`,
  )).returning({ id: adsTable.id });
  return deleted.length > 0;
}
