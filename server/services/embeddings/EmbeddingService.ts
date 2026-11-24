/**
 * Unified Embedding Service
 *
 * Single entry-point for all embedding operations:
 * - Generate embeddings (single text or batch)
 * - Store embeddings with dedup (content hash)
 * - Similarity search via pgvector
 * - Provider/model resolution from admin settings
 *
 * Reuses admin API credentials via the existing credential system (admin_api_credentials table).
 */

import crypto from 'crypto';
import { db } from '../../models/db';
import { sql, eq, and } from 'drizzle-orm';
import { embeddingsTable } from '../../models/embeddings/schema';
import { embeddingSettingsTable } from '../../models/embeddingSettings/schema';
import { getAdminCredentialsByPlatform } from '../../models/adminApiCredentials/functions';
import { BaseEmbeddingProvider, EMBEDDING_MODELS, EMBEDDING_PROVIDERS, isEmbeddingProvider, isEmbeddingModel, validateEmbeddingVectors, type EmbeddingProvider, type EmbeddingResponse } from './BaseEmbeddingProvider';
import { OpenAIEmbeddingProvider } from './OpenAIEmbeddingProvider';
import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider';
import { OpenRouterEmbeddingProvider } from './OpenRouterEmbeddingProvider';
import { logger } from '../../utils/logger.js';
import { createEmbeddingUsage } from '../../models/embeddingUsages/functions';
import { getEmbeddingModelCost } from '../../models/apiPricing/functions';
import { deductCreditsForEmbeddingUsage } from '../CreditDeductionHooks.js';
import { embeddingPricingSnapshot } from '../insights/PricingService.js';
import { currentUsageContext, newUsageContext, withUsageContext } from '../insights/UsageContext.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface GenerateEmbeddingOptions {
  text: string;
  provider?: EmbeddingProvider;
  model?: string;
  userId: number;
}

export interface StoreEmbeddingOptions {
  userId: number;
  text: string;
  sourceType: string; // 'knowledge_base', 'lead', 'content', 'custom'
  sourceId?: number;
  provider?: EmbeddingProvider;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface StorePrecomputedEmbeddingOptions extends StoreEmbeddingOptions {
  vector: number[];
  provider: EmbeddingProvider;
  model: string;
}

export interface ReplaceKnowledgeBaseEmbeddingsOptions {
  userId: number;
  sourceId: number;
  provider: EmbeddingProvider;
  model: string;
  chunks: Array<{
    text: string;
    vector: number[];
    metadata?: Record<string, unknown>;
  }>;
}

export interface SimilaritySearchOptions {
  userId: number;
  query: string;
  limit?: number;
  threshold?: number; // min similarity (0–1), default 0.5
  sourceType?: string;
  provider?: EmbeddingProvider;
  model?: string;
  /** Restrict KB retrieval to the active profile plus tenant-global entries. */
  businessProfileId?: number | null;
}

export interface SimilarityResult {
  id: number;
  content: string;
  sourceType: string;
  sourceId: number | null;
  similarity: number;
  metadata: Record<string, unknown>;
}

// ─── Service ────────────────────────────────────────────────────────────────────

class EmbeddingService {
  private static instance: EmbeddingService;

  private constructor() {}

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  // ── Provider resolution ─────────────────────────────────────────────────────

  /**
   * Resolve provider + model.
   * Priority: explicit request > embedding_settings defaults > first provider with active admin credentials.
   */
  async resolveProviderAndModel(
    requestedProvider?: EmbeddingProvider,
    requestedModel?: string,
  ): Promise<{ provider: EmbeddingProvider; model: string }> {
    if (requestedProvider !== undefined && !isEmbeddingProvider(requestedProvider)) {
      throw new Error('Unsupported embedding provider.');
    }
    const settings = await this.getSettings();
    const enabled: EmbeddingProvider[] = settings ? settings.enabledProviders.filter(isEmbeddingProvider) : EMBEDDING_PROVIDERS;
    if (requestedProvider && !enabled.includes(requestedProvider)) {
      throw new Error(`Embedding provider "${requestedProvider}" is disabled in Admin > Integrations > Embeddings AI.`);
    }
    const preferred = isEmbeddingProvider(settings?.defaultProvider) ? settings.defaultProvider : undefined;
    const candidates: EmbeddingProvider[] = requestedProvider ? [requestedProvider]
      : [...new Set([...(preferred && enabled.includes(preferred) ? [preferred] : []), ...enabled])];
    for (const provider of candidates) {
      const credential = await this.getCredential(provider);
      if (!credential) continue;
      const configuredModel = credential.platform.endsWith('_embedding') ? credential.config?.model : undefined;
      const model = requestedModel
        ?? (settings?.defaultProvider === provider ? settings.defaultModel : undefined)
        ?? configuredModel
        ?? Object.keys(EMBEDDING_MODELS[provider])[0];
      if (!isEmbeddingModel(provider, model)) {
        throw new Error(`Embedding model "${model}" is not supported for "${provider}". Update its embedding settings and rebuild any index using a retired model.`);
      }
      return { provider, model };
    }
    throw new Error('No enabled embedding provider has active credentials. Configure OpenAI, Gemini, or OpenRouter in Admin > Integrations > Embeddings AI.');
  }

  /** Dedicated credentials take precedence. An explicitly disabled key must
   * never be bypassed by silently using the provider's LLM credential. */
  async getCredential(providerName: EmbeddingProvider) {
    if (!isEmbeddingProvider(providerName)) throw new Error('Unsupported embedding provider.');
    const dedicated = await getAdminCredentialsByPlatform(`${providerName}_embedding`);
    const credentials = dedicated.length ? dedicated : await getAdminCredentialsByPlatform(providerName);
    const rank: Record<string, number> = { high: 0, normal: 1, low: 2, fallback: 3 };
    return credentials.filter(credential => credential.isActive && credential.apiKey)
      .sort((a, b) => (rank[a.priority] ?? 4) - (rank[b.priority] ?? 4) || a.id - b.id)[0] ?? null;
  }

  async createProvider(providerName: EmbeddingProvider): Promise<BaseEmbeddingProvider> {
    const credential = await this.getCredential(providerName);
    if (!credential) throw new Error(`No active embedding credential for "${providerName}".`);
    switch (providerName) {
      case 'openai': return new OpenAIEmbeddingProvider(credential.apiKey);
      case 'gemini': return new GeminiEmbeddingProvider(credential.apiKey);
      case 'openrouter': return new OpenRouterEmbeddingProvider(credential.apiKey);
    }
  }

  // ── Core operations ─────────────────────────────────────────────────────────

  /**
   * Generate an embedding vector for a piece of text.
   * Returns the raw vector (array of numbers).
   */
  async generateEmbedding(options: GenerateEmbeddingOptions): Promise<{ vector: number[]; dimensions: number; provider: EmbeddingProvider; model: string }> {
    const { provider, model } = await this.resolveProviderAndModel(options.provider, options.model);
    const context=newUsageContext({provider,model,process:'knowledge'});
    context.pricing=await embeddingPricingSnapshot(model,provider);
    return withUsageContext(context,async()=>{
    const embeddingProvider = await this.createProvider(provider);
    const startTime = Date.now();

    let response: EmbeddingResponse;
    try {
      response = await embeddingProvider.generateEmbeddings({ text: options.text, model });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await this.trackUsage(options.userId, provider, model, 'embedding', 0, 0, 1, 0, durationMs, (error as Error).message);
      throw error;
    }

    const durationMs = Date.now() - startTime;

    if (!response.success || response.embeddings.length === 0) {
      await this.trackUsage(options.userId, provider, model, 'embedding', 0, response.dimensions, 1, 0, durationMs, response.error);
      throw new Error(response.error ?? 'Failed to generate embedding');
    }

    validateEmbeddingVectors(response.embeddings, 1, response.dimensions);
    if (response.model !== model) throw new Error('Embedding provider changed the selected model.');

    // Track successful usage
    await this.trackUsage(
      options.userId, provider, model, 'embedding',
      response.usage?.totalTokens || 0, response.dimensions, 1, 1, durationMs,
    );

    return {
      vector: response.embeddings[0],
      dimensions: response.dimensions,
      provider,
      model,
    };
    });
  }

  /**
   * Generate embeddings for a batch of texts.
   */
  async generateEmbeddingsBatch(
    texts: string[],
    userId: number,
    provider?: EmbeddingProvider,
    model?: string,
  ): Promise<{ vectors: number[][]; dimensions: number; provider: EmbeddingProvider; model: string }> {
    const resolved = await this.resolveProviderAndModel(provider, model);
    const context=newUsageContext({provider:resolved.provider,model:resolved.model,process:'knowledge'});
    context.pricing=await embeddingPricingSnapshot(resolved.model,resolved.provider);
    return withUsageContext(context,async()=>{
    const embeddingProvider = await this.createProvider(resolved.provider);
    const startTime = Date.now();

    let response: EmbeddingResponse;
    try {
      response = await embeddingProvider.generateEmbeddings({ text: texts, model: resolved.model });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await this.trackUsage(userId, resolved.provider, resolved.model, 'batch_embedding', 0, 0, texts.length, 0, durationMs, (error as Error).message);
      throw error;
    }

    const durationMs = Date.now() - startTime;

    if (!response.success) {
      await this.trackUsage(userId, resolved.provider, resolved.model, 'batch_embedding', 0, response.dimensions, texts.length, 0, durationMs, response.error);
      throw new Error(response.error ?? 'Batch embedding generation failed');
    }

    validateEmbeddingVectors(response.embeddings, texts.length, response.dimensions);
    if (response.model !== resolved.model) throw new Error('Embedding provider changed the selected model.');

    // Track successful usage
    await this.trackUsage(
      userId, resolved.provider, resolved.model, 'batch_embedding',
      response.usage?.totalTokens || 0, response.dimensions, texts.length, 1, durationMs,
    );

    return {
      vectors: response.embeddings,
      dimensions: response.dimensions,
      provider: resolved.provider,
      model: resolved.model,
    };
    });
  }

  /**
   * Store an embedding. Deduplicates by content hash + provider + model per user.
   * Returns the embedding record ID.
   */
  async storeEmbedding(options: StoreEmbeddingOptions): Promise<number> {
    const { provider, model } = await this.resolveProviderAndModel(options.provider, options.model);
    const contentHash = this.hashContent(options.text);

    // Check for existing embedding (dedup)
    const existing = await db.execute(sql`
      SELECT id FROM embeddings
      WHERE user_id = ${options.userId}
        AND source_type = ${options.sourceType}
        AND source_id IS NOT DISTINCT FROM ${options.sourceId ?? null}
        AND content_hash = ${contentHash}
        AND provider = ${provider}
        AND model = ${model}
      LIMIT 1
    `);
    if (existing.rows.length > 0) {
      logger.debug({ userId: options.userId, sourceType: options.sourceType }, '[EmbeddingService] Dedup hit — skipping re-embed');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (existing.rows[0] as any).id;
    }

    // Generate the vector
    const { vector, dimensions } = await this.generateEmbedding({
      text: options.text,
      provider,
      model,
      userId: options.userId,
    });

    // Store with pgvector (raw SQL because Drizzle doesn't natively support vector type)
    const result = await db.execute(sql`
      INSERT INTO embeddings (user_id, source_type, source_id, content_hash, content, provider, model, dimensions, embedding, metadata)
      VALUES (
        ${options.userId},
        ${options.sourceType},
        ${options.sourceId ?? null},
        ${contentHash},
        ${options.text},
        ${provider},
        ${model},
        ${dimensions},
        ${sql.raw(`'[${vector.join(',')}]'::vector`)},
        ${JSON.stringify(options.metadata ?? {})}::jsonb
      )
      ON CONFLICT (business_profile_id, user_id, source_type, source_id, content_hash, provider, model) DO UPDATE
        SET embedding = EXCLUDED.embedding,
            source_type = EXCLUDED.source_type,
            source_id = EXCLUDED.source_id,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
      RETURNING id
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result.rows[0] as any).id;
  }

  /**
   * Persist a vector generated by the batch ingestion pipeline without making
   * a second provider request for the same text.
   */
  async storePrecomputedEmbedding(options: StorePrecomputedEmbeddingOptions): Promise<number> {
    if (!options.vector.length || options.vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Cannot store an empty or invalid embedding vector');
    }

    const contentHash = this.hashContent(options.text);
    const vectorLiteral = `[${options.vector.join(',')}]`;
    const result = await db.execute(sql`
      INSERT INTO embeddings (user_id, source_type, source_id, content_hash, content, provider, model, dimensions, embedding, metadata)
      VALUES (
        ${options.userId},
        ${options.sourceType},
        ${options.sourceId ?? null},
        ${contentHash},
        ${options.text},
        ${options.provider},
        ${options.model},
        ${options.vector.length},
        ${sql.raw(`'${vectorLiteral}'::vector`)},
        ${JSON.stringify(options.metadata ?? {})}::jsonb
      )
      ON CONFLICT (business_profile_id, user_id, source_type, source_id, content_hash, provider, model) DO UPDATE
        SET embedding = EXCLUDED.embedding,
            source_type = EXCLUDED.source_type,
            source_id = EXCLUDED.source_id,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
      RETURNING id
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result.rows[0] as any).id;
  }

  /**
   * Replace every searchable chunk for one KB entry in a single transaction.
   * The old index remains intact unless all replacement vectors validate and
   * every insert succeeds.
   */
  async replaceKnowledgeBaseEmbeddings(options: ReplaceKnowledgeBaseEmbeddingsOptions): Promise<number> {
    if (options.chunks.length === 0) throw new Error('Cannot index a knowledge-base entry with no chunks.');
    for (const chunk of options.chunks) {
      if (!chunk.text.trim() || chunk.vector.length === 0 || chunk.vector.some((value) => !Number.isFinite(value))) {
        throw new Error('Cannot atomically index an empty or invalid knowledge-base chunk.');
      }
    }
    return db.transaction(async (tx: typeof db) => {
      await tx.delete(embeddingsTable).where(and(
        eq(embeddingsTable.userId, options.userId),
        eq(embeddingsTable.sourceType, 'knowledge_base'),
        eq(embeddingsTable.sourceId, options.sourceId),
      ));
      let stored = 0;
      for (const chunk of options.chunks) {
        const vectorLiteral = `[${chunk.vector.join(',')}]`;
        const result = await tx.execute(sql`
          INSERT INTO embeddings
            (user_id, source_type, source_id, content_hash, content, provider, model, dimensions, embedding, metadata)
          VALUES (
            ${options.userId}, 'knowledge_base', ${options.sourceId}, ${this.hashContent(chunk.text)},
            ${chunk.text}, ${options.provider}, ${options.model}, ${chunk.vector.length},
            ${sql.raw(`'${vectorLiteral}'::vector`)}, ${JSON.stringify(chunk.metadata ?? {})}::jsonb
          )
          ON CONFLICT (business_profile_id, user_id, source_type, source_id, content_hash, provider, model)
          DO UPDATE SET
            embedding = EXCLUDED.embedding,
            content = EXCLUDED.content,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
          RETURNING id
        `);
        if (result.rows.length !== 1) throw new Error('Knowledge-base embedding insert was not acknowledged.');
        stored += 1;
      }
      return stored;
    });
  }

  /**
   * Similarity search: find the most relevant stored embeddings for a query.
   */
  async searchSimilar(options: SimilaritySearchOptions): Promise<SimilarityResult[]> {
    const { provider, model } = await this.resolveProviderAndModel(options.provider, options.model);
    const limit = options.limit ?? 5;
    const threshold = options.threshold ?? 0.5;

    // Generate embedding for the query
    const { vector } = await this.generateEmbedding({
      text: options.query,
      provider,
      model,
      userId: options.userId,
    });

    const vectorLiteral = `[${vector.join(',')}]`;

    // Build query with optional source_type filter
    let query;
    if (options.sourceType === 'knowledge_base') {
      const profilePredicate = options.businessProfileId == null
        ? sql`kb.business_profile_id IS NULL`
        : sql`(kb.business_profile_id IS NULL OR kb.business_profile_id = ${options.businessProfileId})`;
      query = sql`
        SELECT e.id, e.content, e.source_type, e.source_id, e.metadata,
               1 - (e.embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) AS similarity
        FROM embeddings e
        JOIN knowledge_base kb
          ON kb.id = e.source_id
         AND kb.user_id = e.user_id
        WHERE e.user_id = ${options.userId}
          AND e.provider = ${provider}
          AND e.model = ${model}
          AND e.source_type = 'knowledge_base'
          AND kb.processing_status IN ('completed', 'reprocessing')
          AND ${profilePredicate}
          AND 1 - (e.embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) >= ${threshold}
        ORDER BY similarity DESC
        LIMIT ${limit}
      `;
    } else if (options.sourceType) {
      query = sql`
        SELECT id, content, source_type, source_id, metadata,
               1 - (embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) AS similarity
        FROM embeddings
        WHERE user_id = ${options.userId}
          AND provider = ${provider}
          AND model = ${model}
          AND source_type = ${options.sourceType}
          AND 1 - (embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) >= ${threshold}
        ORDER BY similarity DESC
        LIMIT ${limit}
      `;
    } else {
      query = sql`
        SELECT id, content, source_type, source_id, metadata,
               1 - (embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) AS similarity
        FROM embeddings
        WHERE user_id = ${options.userId}
          AND provider = ${provider}
          AND model = ${model}
          AND 1 - (embedding <=> ${sql.raw(`'${vectorLiteral}'::vector`)}) >= ${threshold}
        ORDER BY similarity DESC
        LIMIT ${limit}
      `;
    }

    const result = await db.execute(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result.rows as any[]).map((r) => ({
      id: r.id,
      content: r.content,
      sourceType: r.source_type,
      sourceId: r.source_id,
      similarity: parseFloat(r.similarity),
      metadata: r.metadata ?? {},
    }));
  }

  /**
   * Delete embeddings for a specific source record (e.g. when KB entry is deleted).
   */
  async deleteBySource(userId: number, sourceType: string, sourceId: number): Promise<void> {
    await db.delete(embeddingsTable).where(
      and(
        eq(embeddingsTable.userId, userId),
        eq(embeddingsTable.sourceType, sourceType),
        eq(embeddingsTable.sourceId, sourceId),
      ),
    );
  }

  /**
   * Delete all embeddings for a user.
   */
  async deleteByUser(userId: number): Promise<void> {
    await db.delete(embeddingsTable).where(eq(embeddingsTable.userId, userId));
  }

  // ── Settings helpers ────────────────────────────────────────────────────────

  async getSettings() {
    const [settings] = await db.select().from(embeddingSettingsTable).limit(1);
    return settings ?? null;
  }

  async updateSettings(data: { defaultProvider?: string; defaultModel?: string; enabledProviders?: string[] }) {
    const existing = await this.getSettings();
    if (!existing) {
      await db.insert(embeddingSettingsTable).values({
        defaultProvider: data.defaultProvider ?? 'openai',
        defaultModel: data.defaultModel ?? 'text-embedding-3-small',
        enabledProviders: data.enabledProviders ?? ['openai'],
      });
    } else {
      await db.update(embeddingSettingsTable)
        .set({
          ...(data.defaultProvider && { defaultProvider: data.defaultProvider }),
          ...(data.defaultModel && { defaultModel: data.defaultModel }),
          ...(data.enabledProviders && { enabledProviders: data.enabledProviders }),
          updatedAt: new Date(),
        })
        .where(eq(embeddingSettingsTable.id, existing.id));
    }
    return this.getSettings();
  }

  /**
   * List available embedding models grouped by provider.
   */
  getAvailableModels() {
    return EMBEDDING_MODELS;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Track embedding usage: insert record + deduct credits.
   * Completes its usage and wallet writes before the embedding call returns.
   */
  private async trackUsage(
    userId: number,
    provider: string,
    model: string,
    purpose: string,
    totalTokens: number,
    dimensions: number,
    textsCount: number,
    success: number,
    durationMs: number,
    errorMessage?: string,
  ): Promise<void> {
    try {
      // Calculate cost (raw fractional cents for accurate credit calculation)
      const snapshot=currentUsageContext()?.pricing;
      const costs = snapshot ? {inputPerMillion:(snapshot.inputUsdPerMillion||0)*(1+(snapshot.marginPercentage||0)/100),
        inputPerMillionOriginal:snapshot.inputUsdPerMillion||0} : await getEmbeddingModelCost(model);
      const rawCostCents = totalTokens > 0
        ? (totalTokens / 1_000_000) * costs.inputPerMillion * 100
        : 0;
      const rawOriginalCostCents = totalTokens > 0
        ? (totalTokens / 1_000_000) * costs.inputPerMillionOriginal * 100
        : 0;
      const estimatedCostCents = rawCostCents;
      const originalCostCents = rawOriginalCostCents;

      // Insert usage record
      await createEmbeddingUsage({
        userId,
        provider,
        model,
        purpose,
        service: 'EmbeddingService',
        inputTokens: totalTokens,
        totalTokens,
        estimatedCostCents,
        originalCostCents,
        dimensions,
        textsCount,
        responseSuccess: success,
        errorMessage: errorMessage || undefined,
        durationMs,
      });

      // Deduct credits for successful calls (pass raw fractional cents)
      if (success === 1 && rawCostCents > 0) {
        await deductCreditsForEmbeddingUsage(userId, {
          model,
          provider,
          purpose,
          estimatedCostCents: rawCostCents,
          originalCostCents: rawOriginalCostCents,
          inputTokens: totalTokens,
          totalTokens,
        });
      }
    } catch (err) {
      logger.error({ err, userId, provider, model }, '[EmbeddingService] Failed to track usage');
    }
  }

  private hashContent(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }
}

export const embeddingService = EmbeddingService.getInstance();
