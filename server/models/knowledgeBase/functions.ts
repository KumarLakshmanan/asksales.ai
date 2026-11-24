import { db } from "../db";
import { knowledgeBaseTable, InsertKnowledgeBaseEntry, KnowledgeBaseEntry } from "./schema";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { currentBusinessScope } from '../../tenancy/businessContext.js';

export const KnowledgeBaseModel = {
  async findAll(userId: number, businessProfileId?: number | null): Promise<KnowledgeBaseEntry[]> {
    const conditions = [eq(knowledgeBaseTable.userId, userId)];
    if (businessProfileId !== undefined) {
      if (businessProfileId === null) {
        conditions.push(isNull(knowledgeBaseTable.businessProfileId));
      } else {
        conditions.push(eq(knowledgeBaseTable.businessProfileId, businessProfileId));
      }
    }
    return db
      .select()
      .from(knowledgeBaseTable)
      .where(and(...conditions))
      .orderBy(desc(knowledgeBaseTable.updatedAt));
  },

  async findById(id: number, userId: number): Promise<KnowledgeBaseEntry | null> {
    const results = await db
      .select()
      .from(knowledgeBaseTable)
      .where(and(eq(knowledgeBaseTable.id, id), eq(knowledgeBaseTable.userId, userId)));
    return results[0] || null;
  },

  async findByType(userId: number, type: string): Promise<KnowledgeBaseEntry[]> {
    return db
      .select()
      .from(knowledgeBaseTable)
      .where(and(eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.type, type)))
      .orderBy(desc(knowledgeBaseTable.updatedAt));
  },

  async findBySourceUrl(userId: number, sourceUrl: string, businessProfileId?: number): Promise<KnowledgeBaseEntry | null> {
    const conditions = [eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.sourceUrl, sourceUrl)];
    if (businessProfileId !== undefined) conditions.push(eq(knowledgeBaseTable.businessProfileId, businessProfileId));
    const results = await db
      .select()
      .from(knowledgeBaseTable)
      .where(and(...conditions))
      .orderBy(desc(knowledgeBaseTable.updatedAt));
    return results[0] || null;
  },

  async create(data: InsertKnowledgeBaseEntry, executor: Pick<typeof db, "insert"> = db): Promise<KnowledgeBaseEntry> {
    const results = await executor.insert(knowledgeBaseTable).values(data).returning();
    return results[0];
  },

  /** Persist the complete validated batch atomically, before provider work.
   * An unchanged retry returns the same durable entry IDs. */
  async createBatch(userId: number, requestId: string, input: InsertKnowledgeBaseEntry[]): Promise<KnowledgeBaseEntry[]> {
    const profile = currentBusinessScope()?.businessProfileId;
    const candidates = input.map((data, index) => ({ ...data, userId,
      businessProfileId: data.businessProfileId ?? profile ?? null,
      creationRequestKey: `${requestId}:${index}`,
    }));
    if (profile && candidates.some(data => data.businessProfileId !== profile)) throw new Error('INVALID_BUSINESS_PROFILE');
    return db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-authoring'), ${userId})`);
      const existing: KnowledgeBaseEntry[] = await tx.select().from(knowledgeBaseTable).where(and(
        eq(knowledgeBaseTable.userId, userId), sql`split_part(${knowledgeBaseTable.creationRequestKey},':',1)=${requestId}`,
      ));
      if (existing.length && existing.length !== candidates.length) throw new Error('KNOWLEDGE_BATCH_REQUEST_CHANGED');
      const byKey = new Map(existing.map(entry => [entry.creationRequestKey, entry]));
      const fields = ['title', 'description', 'content', 'type', 'question', 'answer', 'businessProfileId'] as const;
      for (const candidate of candidates) {
        const prior = byKey.get(candidate.creationRequestKey);
        if (prior && fields.some(field => (prior[field] ?? null) !== (candidate[field] ?? null))) {
          throw new Error('KNOWLEDGE_BATCH_REQUEST_CHANGED');
        }
      }
      const missing = candidates.filter(candidate => !byKey.has(candidate.creationRequestKey));
      if (missing.length) {
        const inserted: KnowledgeBaseEntry[] = await tx.insert(knowledgeBaseTable).values(missing).returning();
        for (const entry of inserted) byKey.set(entry.creationRequestKey, entry);
      }
      return candidates.map(candidate => byKey.get(candidate.creationRequestKey)!);
    });
  },

  async claimBatchItem(id: number, userId: number): Promise<KnowledgeBaseEntry | null> {
    const rows = await db.update(knowledgeBaseTable).set({ processingStatus: 'processing', updatedAt: new Date() })
      .where(and(eq(knowledgeBaseTable.id, id), eq(knowledgeBaseTable.userId, userId),
        sql`(${knowledgeBaseTable.processingStatus} IN ('queued','failed') OR
          (${knowledgeBaseTable.processingStatus}='processing' AND ${knowledgeBaseTable.updatedAt}<NOW()-INTERVAL '10 minutes'))`)).returning();
    return rows[0] || null;
  },

  async updateIfUnchanged(id: number, userId: number, data: Partial<InsertKnowledgeBaseEntry>, expected: Date): Promise<KnowledgeBaseEntry | null> {
    const rows = await db.update(knowledgeBaseTable).set({ ...data,
      updatedAt: sql`GREATEST(clock_timestamp(),${knowledgeBaseTable.updatedAt}+INTERVAL '1 millisecond')`,
    }).where(and(eq(knowledgeBaseTable.id, id), eq(knowledgeBaseTable.userId, userId),
      sql`COALESCE(date_trunc('milliseconds',${knowledgeBaseTable.updatedAt}),'epoch'::timestamp)=${expected}`)).returning();
    return rows[0] || null;
  },

  async update(id: number, userId: number, data: Partial<InsertKnowledgeBaseEntry>): Promise<KnowledgeBaseEntry | null> {
    const results = await db
      .update(knowledgeBaseTable)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(knowledgeBaseTable.id, id), eq(knowledgeBaseTable.userId, userId)))
      .returning();
    return results[0] || null;
  },

  async delete(id: number, userId: number): Promise<boolean> {
    const result = await db
      .delete(knowledgeBaseTable)
      .where(and(eq(knowledgeBaseTable.id, id), eq(knowledgeBaseTable.userId, userId)))
      .returning({ id: knowledgeBaseTable.id });
    return result.length > 0;
  },
};
