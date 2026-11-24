import { db } from "../db";
import { contentAssetPreviewsTable, type ContentAssetPreviewRecord, type InsertContentAssetPreview } from "./schema";
import { and, eq } from "drizzle-orm";

export class ContentAssetPreviewModel {
  static async findAllForUser(userId: number): Promise<ContentAssetPreviewRecord[]> {
    return await db
      .select()
      .from(contentAssetPreviewsTable)
      .where(eq(contentAssetPreviewsTable.userId, userId));
  }

  static async findByIdForUser(id: number, userId: number): Promise<ContentAssetPreviewRecord | undefined> {
    const result = await db
      .select()
      .from(contentAssetPreviewsTable)
      .where(and(
        eq(contentAssetPreviewsTable.id, id),
        eq(contentAssetPreviewsTable.userId, userId),
      ))
      .limit(1);
    return result[0];
  }

  static async findByLeadIdForUser(leadId: number, userId: number): Promise<ContentAssetPreviewRecord[]> {
    return await db
      .select()
      .from(contentAssetPreviewsTable)
      .where(and(
        eq(contentAssetPreviewsTable.leadId, leadId),
        eq(contentAssetPreviewsTable.userId, userId),
      ));
  }

  static async createForUser(
    userId: number,
    data: Omit<InsertContentAssetPreview, 'id' | 'userId' | 'createdAt'>,
  ): Promise<ContentAssetPreviewRecord> {
    const result = await db
      .insert(contentAssetPreviewsTable)
      .values({ ...data, userId })
      .returning();
    return result[0];
  }

  static async updateForUser(
    id: number,
    userId: number,
    data: Partial<Omit<InsertContentAssetPreview, 'id' | 'userId' | 'leadId' | 'leadName' | 'createdAt'>>,
  ): Promise<ContentAssetPreviewRecord | undefined> {
    const result = await db
      .update(contentAssetPreviewsTable)
      .set(data)
      .where(and(
        eq(contentAssetPreviewsTable.id, id),
        eq(contentAssetPreviewsTable.userId, userId),
      ))
      .returning();
    return result[0];
  }

  static async deleteForUser(id: number, userId: number): Promise<void> {
    await db
      .delete(contentAssetPreviewsTable)
      .where(and(
        eq(contentAssetPreviewsTable.id, id),
        eq(contentAssetPreviewsTable.userId, userId),
      ));
  }
}
