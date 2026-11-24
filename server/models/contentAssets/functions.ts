import { db } from "../db";
import { contentAssetsTable, type ContentAssetRecord, type InsertContentAsset } from "./schema";
import { and, count, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { collectContentAssetMediaUrls } from '../../utils/contentAssetMedia.js';
import { logger } from '../../utils/logger.js';
import { contentAssetManagedStorageEntry, contentStorageOwner, lockContentManagedStorage, releaseContentManagedStorage, syncContentManagedStorage } from '../../services/content/ContentManagedStorageService.js';
import { collectContentManagedReferenceUrls } from '../../utils/contentManagedReferences.js';

export interface ContentAssetFilters {
  type?: string;
  channel?: string;
  status?: string;
  threadId?: number;
  limit?: number;
  offset?: number;
  search?: string;
}

function buildUserConditions(userId: number, filters: ContentAssetFilters) {
  const conditions = [eq(contentAssetsTable.userId, userId)];
  // Cross-platform publishing creates same-type child records so each provider
  // attempt has its own lifecycle. Those are implementation details, not new
  // library content. Companion image/video children have a different type and
  // remain visible in their respective library categories.
  conditions.push(sql`NOT EXISTS (
    SELECT 1
    FROM content_assets AS parent_asset
    WHERE parent_asset.id = ${contentAssetsTable.parentAssetId}
      AND parent_asset.user_id = ${userId}
      AND parent_asset.type = ${contentAssetsTable.type}
  )`);
  if (filters.type) conditions.push(eq(contentAssetsTable.type, filters.type));
  if (filters.channel) conditions.push(eq(contentAssetsTable.channel, filters.channel));
  if (filters.status) conditions.push(eq(contentAssetsTable.status, filters.status));
  if (filters.threadId) conditions.push(eq(contentAssetsTable.threadId, filters.threadId));
  if (filters.search) {
    const escaped = filters.search.replace(/[\\%_]/g, '\\$&');
    const pattern = `%${escaped}%`;
    conditions.push(or(
      ilike(contentAssetsTable.title, pattern),
      sql`COALESCE(${contentAssetsTable.performance}->>'prompt', '') ILIKE ${pattern} ESCAPE '\\'`,
    )!);
  }
  return conditions;
}

async function lockAssetForStorage(tx: typeof db, id: number, userId?: number): Promise<ContentAssetRecord | undefined> {
  const where = and(eq(contentAssetsTable.id, id), ...(userId === undefined ? [] : [eq(contentAssetsTable.userId, userId)]));
  const [candidate] = await tx.select().from(contentAssetsTable).where(where).limit(1);
  if (!candidate) return undefined;
  await lockContentManagedStorage(tx, candidate);
  return (await tx.select().from(contentAssetsTable).where(where).limit(1).for('update'))[0];
}

export class ContentAssetModel {
  static async attachTrackedMedia(asset: ContentAssetRecord): Promise<void> {
    if (!asset.userId) return;
    const urls = [...collectContentAssetMediaUrls(asset)];
    if (urls.length === 0) return;
    try {
      const { StorageService } = await import('../../services/StorageService.js');
      await StorageService.getInstance().attachUnreferencedFilesByUrl(
        urls,
        asset.userId,
        'content_asset',
        String(asset.id),
      );
    } catch (error) {
      logger.warn(
        { err: error, assetId: asset.id, userId: asset.userId },
        '[ContentAssetModel] Unable to attach generated media to content asset',
      );
    }
  }

  static async findAll(): Promise<ContentAssetRecord[]> {
    return await db.select().from(contentAssetsTable);
  }

  static async findAllByUser(userId: number): Promise<ContentAssetRecord[]> {
    return await this.findByUser(userId);
  }

  static async findByUser(userId: number, filters: ContentAssetFilters = {}): Promise<ContentAssetRecord[]> {
    const conditions = buildUserConditions(userId, filters);

    let query = db
      .select()
      .from(contentAssetsTable)
      .where(and(...conditions))
      // `id` breaks ties so offset pages are deterministic. Without it Postgres
      // may return rows sharing an updated_at on two pages ("Load more" repeats).
      .orderBy(desc(contentAssetsTable.updatedAt), desc(contentAssetsTable.id))
      .$dynamic();
    query = query.limit(filters.limit ?? 200);
    if (filters.offset !== undefined) query = query.offset(filters.offset);
    return await query;
  }

  static async countForUser(userId: number, filters: ContentAssetFilters = {}): Promise<number> {
    const [row] = await db
      .select({ total: count() })
      .from(contentAssetsTable)
      .where(and(...buildUserConditions(userId, filters)));
    return Number(row?.total ?? 0);
  }

  static async countByTypeForUser(userId: number, threadId?: number): Promise<Record<string, number>> {
    const conditions = [eq(contentAssetsTable.userId, userId)];
    if (threadId) conditions.push(eq(contentAssetsTable.threadId, threadId));
    const rows = await db
      .select({ type: contentAssetsTable.type, total: count() })
      .from(contentAssetsTable)
      .where(and(...conditions))
      .groupBy(contentAssetsTable.type);
    return Object.fromEntries(rows.map((row: { type: string; total: number | string }) => [
      row.type || 'unknown',
      Number(row.total),
    ]));
  }

  static async findById(id: number): Promise<ContentAssetRecord | undefined> {
    const result = await db.select().from(contentAssetsTable).where(eq(contentAssetsTable.id, id)).limit(1);
    return result[0];
  }

  static async findByIdForUser(id: number, userId: number): Promise<ContentAssetRecord | undefined> {
    const result = await db.select().from(contentAssetsTable).where(and(
      eq(contentAssetsTable.id, id),
      eq(contentAssetsTable.userId, userId),
    )).limit(1);
    return result[0];
  }

  static async findChildrenForUser(parentAssetId: number, userId: number): Promise<ContentAssetRecord[]> {
    return db
      .select()
      .from(contentAssetsTable)
      .where(and(
        eq(contentAssetsTable.parentAssetId, parentAssetId),
        eq(contentAssetsTable.userId, userId),
      ));
  }

  static async findByVideoOperationForUser(
    operationName: string,
    userId: number,
  ): Promise<ContentAssetRecord | undefined> {
    const result = await db
      .select()
      .from(contentAssetsTable)
      .where(and(
        eq(contentAssetsTable.userId, userId),
        sql`${contentAssetsTable.performance}->>'operationName' = ${operationName}`,
      ))
      .limit(1);
    return result[0];
  }

  static async findOtherAssetReferencingMediaUrl(
    userId: number,
    excludedAssetId: number,
    mediaUrl: string,
  ): Promise<number | undefined> {
    const canonical = mediaUrl.trim().split(/[?#]/, 1)[0];
    if (!canonical) return undefined;
    const [row] = await db
      .select({ id: contentAssetsTable.id })
      .from(contentAssetsTable)
      .where(and(
        eq(contentAssetsTable.userId, userId),
        ne(contentAssetsTable.id, excludedAssetId),
        or(
          sql`split_part(split_part(COALESCE(${contentAssetsTable.imageUrl}, ''), '?', 1), '#', 1) = ${canonical}`,
          sql`split_part(split_part(COALESCE(${contentAssetsTable.videoUrl}, ''), '?', 1), '#', 1) = ${canonical}`,
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(${contentAssetsTable.imageUrls}) = 'array'
                THEN ${contentAssetsTable.imageUrls} ELSE '[]'::jsonb END
            ) AS media(value)
            WHERE split_part(split_part(media.value, '?', 1), '#', 1) = ${canonical}
          )`,
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(${contentAssetsTable.videoUrls}) = 'array'
                THEN ${contentAssetsTable.videoUrls} ELSE '[]'::jsonb END
            ) AS media(value)
            WHERE split_part(split_part(media.value, '?', 1), '#', 1) = ${canonical}
          )`,
          sql`position(${canonical} in COALESCE(${contentAssetsTable.content}, '')) > 0`,
        ),
      ))
      .limit(1);
    return row?.id;
  }

  static async findByGenerationKey(
    userId: number,
    type: string,
    generationKey: string,
  ): Promise<ContentAssetRecord | undefined> {
    const [row] = await db
      .select()
      .from(contentAssetsTable)
      .where(and(
        eq(contentAssetsTable.userId, userId),
        eq(contentAssetsTable.type, type),
        sql`${contentAssetsTable.metadata}->>'generationKey' = ${generationKey}`,
      ))
      .orderBy(contentAssetsTable.id)
      .limit(1);
    return row;
  }

  /**
   * Idempotent insert for generated media. The same generation (job retry,
   * status poll, completion webhook, tool replay) always resolves to one row.
   * `content_assets_generation_key_uidx` (migration 590) closes the race between
   * two concurrent completions; without it the lookup still stops sequential repeats.
   */
  static async createOnce(
    data: InsertContentAsset,
    generationKey: string,
  ): Promise<{ asset: ContentAssetRecord; created: boolean }> {
    const userId = Number(data.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Generated media requires an owner');
    const existing = await this.findByGenerationKey(userId, data.type, generationKey);
    if (existing) return { asset: existing, created: false };
    // publishPlatform stays null so the row is covered by the partial unique index.
    const values: InsertContentAsset = { ...data, publishPlatform: null, metadata: { ...(data.metadata || {}), generationKey } };
    const inserted = await db.transaction(async (tx: typeof db) => {
      await lockContentManagedStorage(tx, values);
      const [saved] = await tx.insert(contentAssetsTable).values(values).onConflictDoNothing().returning();
      if (saved) await syncContentManagedStorage(tx, [contentAssetManagedStorageEntry(saved)]);
      return saved as ContentAssetRecord | undefined;
    });
    if (!inserted) {
      const winner = await this.findByGenerationKey(userId, data.type, generationKey);
      if (!winner) throw new Error('Generated media save conflicted without a stored row');
      return { asset: winner, created: false };
    }
    await this.attachTrackedMedia(inserted);
    return { asset: inserted, created: true };
  }

  static async create(data: InsertContentAsset): Promise<ContentAssetRecord> {
    const asset = await db.transaction(async (tx: typeof db) => {
      await lockContentManagedStorage(tx, data);
      const [saved] = await tx.insert(contentAssetsTable).values(data).returning();
      await syncContentManagedStorage(tx, [contentAssetManagedStorageEntry(saved)]);
      return saved;
    });

    await this.attachTrackedMedia(asset);

    // Content generation credits removed — cost is covered by underlying API usage
    // (OpenAI/Gemini token costs are already deducted as api_openai/api_gemini events)

    return asset;
  }

  static async update(id: number, data: Partial<InsertContentAsset>): Promise<ContentAssetRecord | undefined> {
    return this.updateStoredAsset(id, data);
  }

  static async updateForUser(
    id: number,
    userId: number,
    data: Partial<InsertContentAsset>,
  ): Promise<ContentAssetRecord | undefined> {
    return this.updateStoredAsset(id, data, userId);
  }

  private static async updateStoredAsset(id: number, data: Partial<InsertContentAsset>, userId?: number): Promise<ContentAssetRecord | undefined> {
    const asset = await db.transaction(async (tx: typeof db) => {
      const previous = await lockAssetForStorage(tx, id, userId);
      if (!previous) return undefined;
      const [saved] = await tx
      .update(contentAssetsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(contentAssetsTable.id, id))
      .returning();
      if (!saved) return undefined;
      // Status-only recovery must not re-adopt media explicitly revoked through
      // Storage. An unchanged URL set requires no reference mutation.
      const before = collectContentManagedReferenceUrls(previous).sort();
      const after = collectContentManagedReferenceUrls(saved).sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) await syncContentManagedStorage(tx, [contentAssetManagedStorageEntry(saved)]);
      return saved;
    });
    if (asset) await this.attachTrackedMedia(asset);
    return asset;
  }

  static async markAsPublished(
    id: number,
    payload: { publishedPostId: string; publishedUrl?: string; publishPlatform: string }
  ): Promise<ContentAssetRecord | undefined> {
    const result = await db
      .update(contentAssetsTable)
      .set({
        status: 'published',
        publishedPostId: payload.publishedPostId,
        publishedAt: new Date(),
        publishedUrl: payload.publishedUrl ?? null,
        publishPlatform: payload.publishPlatform,
        updatedAt: new Date(),
      })
      .where(eq(contentAssetsTable.id, id))
      .returning();
    return result[0];
  }

  static async markAsPublishedForUser(
    id: number,
    userId: number,
    payload: { publishedPostId: string; publishedUrl?: string; publishPlatform: string }
  ): Promise<ContentAssetRecord | undefined> {
    const result = await db
      .update(contentAssetsTable)
      .set({
        status: 'published',
        publishedPostId: payload.publishedPostId,
        publishedAt: new Date(),
        publishedUrl: payload.publishedUrl ?? null,
        publishPlatform: payload.publishPlatform,
        retryCount: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(contentAssetsTable.id, id),
        eq(contentAssetsTable.userId, userId),
      ))
      .returning();
    return result[0];
  }

  static async delete(id: number): Promise<void> {
    await this.deleteStoredAsset(id);
  }

  static async deleteForUser(id: number, userId: number): Promise<boolean> {
    return this.deleteStoredAsset(id, userId);
  }

  private static async deleteStoredAsset(id: number, userId?: number): Promise<boolean> {
    return db.transaction(async (tx: typeof db) => {
      const previous = await lockAssetForStorage(tx, id, userId);
      if (!previous) return false;
      const deleted = await tx.delete(contentAssetsTable).where(eq(contentAssetsTable.id, id)).returning();
      await releaseContentManagedStorage(tx, deleted.map((asset: ContentAssetRecord) => contentStorageOwner('content_asset', asset)));
      return deleted.length > 0;
    });
  }
}
