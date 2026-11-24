import { KnowledgeBaseModel } from '../models/knowledgeBase/functions.js';
import { StorageService } from './StorageService.js';
import { ingestKnowledgeBaseFile } from './KnowledgeBaseIngestionService.js';
import { logger } from '../utils/logger.js';

export async function processKnowledgeBaseEntryIngestion(params: {
  userId: number;
  entryId: number;
  storageFileId: number;
}): Promise<{
  success: boolean;
  entryId: number;
  chunkCount?: number;
  extractedTextLength?: number;
  embeddingsGenerated?: boolean;
  skipped?: boolean;
}> {
  const { userId, entryId, storageFileId } = params;

  const entry = await KnowledgeBaseModel.findById(entryId, userId);
  if (!entry) {
    return { success: false, entryId, skipped: true };
  }

  if (entry.processingStatus === 'completed') {
    return { success: true, entryId, skipped: true };
  }

  if (entry.processingStatus !== 'processing' && entry.processingStatus !== 'reprocessing') {
    await KnowledgeBaseModel.update(entryId, userId, {
      processingStatus: 'processing',
      extractionStatus: 'processing',
      indexingStatus: 'queued',
    });
  }

  try {
    const storageService = StorageService.getInstance();
    const downloaded = await storageService.downloadFile(Number(storageFileId), userId);

    if (!downloaded) {
      throw new Error(`Storage file not found: ${storageFileId}`);
    }

    if (downloaded.file.userId !== userId) {
      throw new Error(`Storage file ${storageFileId} does not belong to user ${userId}`);
    }

    const ingestion = await ingestKnowledgeBaseFile({
      generateEmbeddings:false,
      userId,
      fileBuffer: downloaded.buffer,
      fileName: downloaded.file.originalName || downloaded.file.fileName,
      mimeType: downloaded.file.mimeType || 'application/octet-stream',
    });

    // Canonical V2 ingestion owns provider calls and searchable vectors. The
    // extraction record keeps only source chunks, without a duplicate index.
    const storedChunks = ingestion.chunks.map(({ embedding: _embedding, ...chunk }) => ({
      ...chunk, hasEmbedding: false,
    }));

    const completedEntry = await KnowledgeBaseModel.update(entryId, userId, {
      content: JSON.stringify({
        extractedText: ingestion.extractedText,
        chunks: storedChunks,
        embeddingsGenerated: false,
        embeddingModel: ingestion.embeddingModel || null,
        embeddingProvider: ingestion.embeddingProvider || null,
        extractionSource: ingestion.extractionSource,
        extractionWarnings: ingestion.extractionWarnings,
      }),
      processingStatus: 'processing',
      extractionStatus: 'completed',
      indexingStatus: 'processing',
    });
    if (!completedEntry) throw new Error('KNOWLEDGE_ENTRY_NOT_FOUND');
    const { knowledgeIngestionService } = await import('./knowledge/KnowledgeIngestionService.js');
    let governed;
    try {
      governed = await knowledgeIngestionService.indexLegacyEntry(completedEntry,{autoPublish:false});
    } catch (error) {
      throw new Error('KNOWLEDGE_VERSION_INDEX_FAILED',{cause:error});
    }
    await KnowledgeBaseModel.update(entryId,userId,{processingStatus:'completed',
      indexingStatus:governed.vectorIndexed ? 'completed' : 'failed'});

    return {
      success: true,
      entryId,
      chunkCount: ingestion.chunks.length,
      extractedTextLength: ingestion.extractedText.length,
      embeddingsGenerated: governed.vectorIndexed,
    };
  } catch (error: unknown) {
    await KnowledgeBaseModel.update(entryId, userId, {
      processingStatus: 'failed',
      extractionStatus: error instanceof Error && error.message === 'KNOWLEDGE_VERSION_INDEX_FAILED' ? 'completed' : 'failed',
      indexingStatus: 'failed',
    });
    logger.error({ err: error, userId, entryId, storageFileId }, '[KnowledgeBaseProcessing] Failed');
    throw error;
  }
}
