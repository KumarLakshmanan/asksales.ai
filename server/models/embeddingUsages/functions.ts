import { db } from "../db";
import { embeddingUsagesTable, type EmbeddingUsage, type InsertEmbeddingUsage } from "./schema";
import { usageMetadata } from '../../services/insights/UsageContext.js';

export async function createEmbeddingUsage(data: InsertEmbeddingUsage): Promise<EmbeddingUsage> {
  const [usage] = await db.insert(embeddingUsagesTable).values({ ...data, metadata:usageMetadata(data.metadata) }).returning();
  return usage;
}

